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
    
    // --- Player Data ---
    player_owned_cells: Vec<u32>,
    player_total_troops: Vec<u32>,
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
            
            // Player Initializers
            player_owned_cells: vec![0; PLAYER_ARRAY_SIZE],
            player_total_troops: vec![0; PLAYER_ARRAY_SIZE],
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
        start_troops: u32,
        start_gold: u32,
        start_growth_rate: u32,
        start_max_cap: u32,
    ) {
        // Clear old player states
        for i in 1..PLAYER_ARRAY_SIZE {
            self.player_is_alive[i] = 0;
            self.player_owned_cells[i] = 0;
            self.player_total_troops[i] = 0;
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
            self.player_population_growth_rate[i] = start_growth_rate; // e.g., 50 pop per second
            self.player_max_population_cap[i] = start_max_cap;
            self.player_color_index[i] = i as u8; // By default, their color index is their player ID
        }
    }

    // --- Core Simulation Ticks ---

    #[wasm_bindgen]
    pub fn tick(&mut self) {
        self.current_tick += 1;
        self.apply_production();
        self.process_war_fronts();
    }

    /// Placeholder function: Calculates economic yield and troops reinforcement.
    fn apply_production(&mut self) {
        // TODO: Iterate over relevant cells and increase troops/resources based on resource_yield and infrastructure_level
    }

    /// Placeholder function: Resolves attacks, updates owners, and manages territorial shifts.
    fn process_war_fronts(&mut self) {
        // TODO: Process movement and combat.
        // If a cell changes state, update last_modified_tick[cell_id] = self.current_tick;
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
    pub fn get_player_total_troops_ptr(&self) -> *const u32 { self.player_total_troops.as_ptr() }

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
}
