use wasm_bindgen::prelude::*;

// 1920x1080 matrix topology
pub const MAP_WIDTH: usize = 1920;
pub const MAP_HEIGHT: usize = 1080;
pub const TOTAL_CELLS: usize = MAP_WIDTH * MAP_HEIGHT;

pub const MAX_PLAYERS: usize = 20;
// Index 0 represents "Neutral / Unowned", Indices 1-20 represent active players.
pub const PLAYER_ARRAY_SIZE: usize = MAX_PLAYERS + 1;

/// The Core Simulation State using a Structure of Arrays (SoA) Layout.
/// This completely avoids OOP overhead and GC pressure.
#[wasm_bindgen]
pub struct SimulationState {
    // --- Map Cell Data ---
    owner: Vec<u32>,
    troops: Vec<u32>,
    difficulty_to_invade: Vec<u32>,
    has_building: Vec<u8>,
    defense_bonus_multiplier: Vec<u16>,
    resource_yield: Vec<u8>,
    last_modified_tick: Vec<u32>,
    
    // Fixed-stride flat array assuming 4 cardinal neighbors per cell (Top, Right, Bottom, Left).
    // Using i32 to allow -1 for boundary/no-neighbor conditions.
    neighbor_graph: Vec<i32>,

    // Scratch buffer for delta export: interleaved (cell_id, owner_id) u32 pairs.
    // Sized to worst case so we never reallocate during a tick.
    delta_scratch: Vec<u32>,

    // --- Player Data ---
    player_owned_cells: Vec<u32>,
    player_total_troops: Vec<f32>,
    player_attack_pool: Vec<f32>,
    player_expansion_target: Vec<i32>,
    player_gold: Vec<u32>,
    player_population_growth_rate: Vec<u32>,
    player_is_alive: Vec<u8>,
    player_account_id: Vec<u32>,
    player_color_index: Vec<u8>,
    player_max_population_cap: Vec<u32>,

    current_tick: u32,
}

#[wasm_bindgen]
impl SimulationState {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SimulationState {
        let mut state = SimulationState {
            // Map Initializers
            owner: vec![0; TOTAL_CELLS],
            troops: vec![0; TOTAL_CELLS],
            difficulty_to_invade: vec![0; TOTAL_CELLS],
            has_building: vec![0; TOTAL_CELLS],
            defense_bonus_multiplier: vec![0; TOTAL_CELLS],
            resource_yield: vec![0; TOTAL_CELLS],
            last_modified_tick: vec![0; TOTAL_CELLS],
            neighbor_graph: vec![-1; TOTAL_CELLS * 4],
            delta_scratch: vec![0; TOTAL_CELLS * 2],

            // Player Initializers
            player_owned_cells: vec![0; PLAYER_ARRAY_SIZE],
            player_total_troops: vec![0.0; PLAYER_ARRAY_SIZE],
            player_attack_pool: vec![0.0; PLAYER_ARRAY_SIZE],
            player_expansion_target: vec![-1; PLAYER_ARRAY_SIZE],
            player_gold: vec![0; PLAYER_ARRAY_SIZE],
            player_population_growth_rate: vec![0; PLAYER_ARRAY_SIZE],
            player_is_alive: vec![0; PLAYER_ARRAY_SIZE],
            player_account_id: vec![0; PLAYER_ARRAY_SIZE],
            player_color_index: vec![0; PLAYER_ARRAY_SIZE],
            player_max_population_cap: vec![0; PLAYER_ARRAY_SIZE],

            current_tick: 0,
        };
        
        state.initialize_neighbor_graph();
        state
    }

    /// Precomputes the neighbor graph for O(1) adjacency lookups.
    fn initialize_neighbor_graph(&mut self) {
        for row in 0..MAP_HEIGHT {
            for col in 0..MAP_WIDTH {
                let cell_id = row * MAP_WIDTH + col;
                let base_idx = cell_id * 4;
                
                // Top (0)
                if row > 0 {
                    self.neighbor_graph[base_idx + 0] = ((row - 1) * MAP_WIDTH + col) as i32;
                }
                // Right (1)
                if col < MAP_WIDTH - 1 {
                    self.neighbor_graph[base_idx + 1] = (row * MAP_WIDTH + col + 1) as i32;
                }
                // Bottom (2)
                if row < MAP_HEIGHT - 1 {
                    self.neighbor_graph[base_idx + 2] = ((row + 1) * MAP_WIDTH + col) as i32;
                }
                // Left (3)
                if col > 0 {
                    self.neighbor_graph[base_idx + 3] = (row * MAP_WIDTH + col - 1) as i32;
                }
            }
        }
    }

    /// Initialize the players with their starting resources.
    #[wasm_bindgen]
    pub fn init_players(
        &mut self,
        num_players: u8,
        start_cells: u32,
        start_troops: f32,
        start_gold: u32,
        start_growth_rate: u32,
        start_max_cap: u32,
    ) {
        // Clear old player states
        for i in 1..PLAYER_ARRAY_SIZE {
            self.player_is_alive[i] = 0;
            self.player_owned_cells[i] = 0;
            self.player_total_troops[i] = 0.0;
            self.player_attack_pool[i] = 0.0;
            self.player_expansion_target[i] = -1;
            self.player_gold[i] = 0;
            self.player_population_growth_rate[i] = 0;
            self.player_max_population_cap[i] = 0;
            self.player_account_id[i] = 0;
            self.player_color_index[i] = 0;
        }

        let actual_players = if num_players as usize > MAX_PLAYERS { MAX_PLAYERS } else { num_players as usize };

        // Initialize active players (indices 1 through N)
        for i in 1..=actual_players {
            self.player_is_alive[i] = 1;
            self.player_owned_cells[i] = start_cells;
            self.player_total_troops[i] = start_troops;
            self.player_gold[i] = start_gold;
            self.player_population_growth_rate[i] = start_growth_rate; 
            self.player_max_population_cap[i] = start_max_cap;
            self.player_color_index[i] = i as u8; 
        }
    }

    #[wasm_bindgen]
    pub fn spawn_faction(&mut self, faction_id: u32, center_row: usize, center_col: usize) {
        let f = faction_id as usize;
        if self.player_is_alive[f] == 0 { return; }
        
        let radius = 25isize;
        let mut cells_claimed = 0;
        
        for r in -radius..=radius {
            for c in -radius..=radius {
                if r*r + c*c <= radius*radius {
                    let rr = center_row as isize + r;
                    let cc = center_col as isize + c;
                    
                    if rr >= 0 && rr < MAP_HEIGHT as isize && cc >= 0 && cc < MAP_WIDTH as isize {
                        let idx = (rr as usize) * MAP_WIDTH + (cc as usize);
                        
                        // Ignore water (3)
                        if self.resource_yield[idx] != 3 && self.owner[idx] == 0 { 
                            self.owner[idx] = faction_id;
                            self.last_modified_tick[idx] = self.current_tick;
                            cells_claimed += 1;
                        }
                    }
                }
            }
        }
        
        self.player_owned_cells[f] += cells_claimed;
    }

    #[wasm_bindgen]
    pub fn execute_expansion(&mut self, faction_id: u32, target_cell: u32, attack_percentage: u8) {
        let f = faction_id as usize;
        if self.player_is_alive[f] == 0 { return; }
        
        let pct = (attack_percentage as f32).min(100.0) / 100.0;
        let troops_to_send = self.player_total_troops[f] * pct;
        
        if troops_to_send > 1.0 {
            self.player_total_troops[f] -= troops_to_send;
            self.player_attack_pool[f] += troops_to_send;
            self.player_expansion_target[f] = target_cell as i32;
        }
    }

    // --- Core Simulation Ticks ---

    #[wasm_bindgen]
    pub fn tick(&mut self) {
        self.current_tick += 1;
        self.apply_production();
        self.process_war_fronts();
    }

    fn apply_production(&mut self) {
        for i in 1..PLAYER_ARRAY_SIZE {
            if self.player_is_alive[i] == 1 {
                let cells = self.player_owned_cells[i];
                if cells == 0 {
                    self.player_is_alive[i] = 0;
                    continue;
                }
                
                // Max population grows dynamically
                self.player_max_population_cap[i] = 1000 + (cells * 100);
                
                // Growth rate: e.g. 10% of max cap per second
                // Tick is 20Hz, so divide by 20
                let growth_per_tick = (self.player_max_population_cap[i] as f32 * 0.10) / 20.0;
                
                self.player_total_troops[i] += growth_per_tick;
                
                let max_f32 = self.player_max_population_cap[i] as f32;
                if self.player_total_troops[i] > max_f32 {
                    self.player_total_troops[i] = max_f32;
                }
            }
        }
    }

    fn process_war_fronts(&mut self) {
        let mut faction_frontiers: Vec<Vec<usize>> = vec![Vec::with_capacity(1000); PLAYER_ARRAY_SIZE];
        
        // Find frontiers for expanding factions
        for cell_id in 0..TOTAL_CELLS {
            let owner = self.owner[cell_id] as usize;
            if owner != 0 && self.player_attack_pool[owner] > 0.0 && self.player_expansion_target[owner] != -1 {
                let base_idx = cell_id * 4;
                for i in 0..4 {
                    let n = self.neighbor_graph[base_idx + i];
                    if n != -1 {
                        let n_idx = n as usize;
                        let n_owner = self.owner[n_idx] as usize;
                        if n_owner != owner && self.resource_yield[n_idx] != 3 {
                            faction_frontiers[owner].push(n_idx);
                            break; 
                        }
                    }
                }
            }
        }
        
        // Resolve expansions per faction
        for f in 1..PLAYER_ARRAY_SIZE {
            let target = self.player_expansion_target[f];
            if target != -1 && self.player_attack_pool[f] > 0.0 && !faction_frontiers[f].is_empty() {
                let target_r = target / MAP_WIDTH as i32;
                let target_c = target % MAP_WIDTH as i32;
                
                // Sort to expand towards target
                faction_frontiers[f].sort_unstable_by_key(|&n_idx| {
                    let r = (n_idx / MAP_WIDTH) as i32;
                    let c = (n_idx % MAP_WIDTH) as i32;
                    let dr = r - target_r;
                    let dc = c - target_c;
                    dr*dr + dc*dc
                });
                
                let max_conquers_per_tick = 50; 
                let mut conquers = 0;
                
                for &src_cell in faction_frontiers[f].iter() {
                    if conquers >= max_conquers_per_tick { break; }
                    if self.player_attack_pool[f] <= 0.0 { break; }
                    
                    let base_idx = src_cell * 4;
                    for i in 0..4 {
                        let n = self.neighbor_graph[base_idx + i];
                        if n != -1 {
                            let n_idx = n as usize;
                            let n_owner = self.owner[n_idx] as usize;
                            
                            if n_owner != f && self.resource_yield[n_idx] != 3 {
                                let terrain = self.resource_yield[n_idx];
                                let base_cost = match terrain {
                                    0 => 1.0, // Plains
                                    1 => 3.0, // Highlands
                                    2 => 6.0, // Mountains
                                    _ => 99.0,
                                };
                                
                                let mut total_cost = base_cost;
                                if n_owner != 0 {
                                    let enemy_cells = self.player_owned_cells[n_owner].max(1) as f32;
                                    let enemy_defense_per_cell = self.player_total_troops[n_owner] / enemy_cells;
                                    total_cost += enemy_defense_per_cell;
                                }
                                
                                if self.player_attack_pool[f] >= total_cost {
                                    self.player_attack_pool[f] -= total_cost;
                                    
                                    if n_owner != 0 {
                                        self.player_total_troops[n_owner] -= total_cost - base_cost;
                                        if self.player_total_troops[n_owner] < 0.0 {
                                            self.player_total_troops[n_owner] = 0.0;
                                        }
                                        self.player_owned_cells[n_owner] = self.player_owned_cells[n_owner].saturating_sub(1);
                                    }
                                    
                                    self.owner[n_idx] = f as u32;
                                    self.last_modified_tick[n_idx] = self.current_tick;
                                    self.player_owned_cells[f] += 1;
                                    conquers += 1;
                                    
                                    // Also if this cell IS the target, we stop immediately
                                    if n_idx as i32 == target {
                                        self.player_expansion_target[f] = -1;
                                        self.player_total_troops[f] += self.player_attack_pool[f];
                                        self.player_attack_pool[f] = 0.0;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if self.player_expansion_target[f] == -1 { break; }
                }
                
                // End attack condition
                if self.player_attack_pool[f] < 1.0 {
                    self.player_total_troops[f] += self.player_attack_pool[f];
                    self.player_attack_pool[f] = 0.0;
                    self.player_expansion_target[f] = -1;
                }
            }
        }
    }

    // --- Raw Pointer Exposure for JavaScript Zero-Copy Access ---
    
    // Map Fields
    #[wasm_bindgen]
    pub fn get_owner_ptr(&self) -> *const u32 { self.owner.as_ptr() }

    #[wasm_bindgen]
    pub fn get_troops_ptr(&self) -> *const u32 { self.troops.as_ptr() }

    #[wasm_bindgen]
    pub fn get_difficulty_to_invade_ptr(&self) -> *const u32 { self.difficulty_to_invade.as_ptr() }

    #[wasm_bindgen]
    pub fn get_has_building_ptr(&self) -> *const u8 { self.has_building.as_ptr() }

    #[wasm_bindgen]
    pub fn get_defense_bonus_multiplier_ptr(&self) -> *const u16 { self.defense_bonus_multiplier.as_ptr() }

    #[wasm_bindgen]
    pub fn get_resource_yield_ptr(&self) -> *const u8 { self.resource_yield.as_ptr() }

    #[wasm_bindgen]
    pub fn get_last_modified_tick_ptr(&self) -> *const u32 { self.last_modified_tick.as_ptr() }

    #[wasm_bindgen]
    pub fn get_neighbor_graph_ptr(&self) -> *const i32 { self.neighbor_graph.as_ptr() }
    
    // Player Fields
    #[wasm_bindgen]
    pub fn get_player_owned_cells_ptr(&self) -> *const u32 { self.player_owned_cells.as_ptr() }

    #[wasm_bindgen]
    pub fn get_player_total_troops_ptr(&self) -> *const f32 { self.player_total_troops.as_ptr() }

    #[wasm_bindgen]
    pub fn get_player_attack_pool_ptr(&self) -> *const f32 { self.player_attack_pool.as_ptr() }

    #[wasm_bindgen]
    pub fn get_player_gold_ptr(&self) -> *const u32 { self.player_gold.as_ptr() }

    #[wasm_bindgen]
    pub fn get_player_population_growth_rate_ptr(&self) -> *const u32 { self.player_population_growth_rate.as_ptr() }

    #[wasm_bindgen]
    pub fn get_player_is_alive_ptr(&self) -> *const u8 { self.player_is_alive.as_ptr() }

    #[wasm_bindgen]
    pub fn get_player_account_id_ptr(&self) -> *const u32 { self.player_account_id.as_ptr() }

    #[wasm_bindgen]
    pub fn get_player_color_index_ptr(&self) -> *const u8 { self.player_color_index.as_ptr() }

    #[wasm_bindgen]
    pub fn get_player_max_population_cap_ptr(&self) -> *const u32 { self.player_max_population_cap.as_ptr() }

    #[wasm_bindgen]
    pub fn get_current_tick(&self) -> u32 { self.current_tick }

    #[wasm_bindgen]
    pub fn collect_dirty_cells(&mut self, since_tick: u32) -> u32 {
        let mut count: usize = 0;
        let cap = self.delta_scratch.len() / 2;
        for cell_id in 0..TOTAL_CELLS {
            if count >= cap { break; }
            if self.last_modified_tick[cell_id] >= since_tick {
                self.delta_scratch[count * 2] = cell_id as u32;
                self.delta_scratch[count * 2 + 1] = self.owner[cell_id];
                count += 1;
            }
        }
        count as u32
    }

    #[wasm_bindgen]
    pub fn get_delta_scratch_ptr(&self) -> *const u32 { self.delta_scratch.as_ptr() }
}
