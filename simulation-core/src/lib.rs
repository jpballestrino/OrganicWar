use wasm_bindgen::prelude::*;

// 1920x1080 matrix topology
pub const MAP_WIDTH: usize = 1920;
pub const MAP_HEIGHT: usize = 1080;
pub const TOTAL_CELLS: usize = MAP_WIDTH * MAP_HEIGHT;

pub const MAX_PLAYERS: usize = 20;
// Index 0 represents "Neutral / Unowned", Indices 1-20 represent active players.
pub const PLAYER_ARRAY_SIZE: usize = MAX_PLAYERS + 1;

// --- Packed cell layout (one u16 per cell) ---
// Owner, terrain type, defense tier, and the has-building flag are bit-packed
// into a single u16 to cut the hot per-cell footprint from 8 bytes to 2.
//   bits 0-6   (7): owner id      0..127  (0 = neutral; covers the 100-player cap)
//   bits 7-10  (4): terrain type  0..15
//   bits 11-14 (4): defense tier  0..15
//   bit  15    (1): has building  0/1
// NOTE: this layout is mirrored in JS — src/js/constants.js (CELL_* consts),
// the renderer's GLSL unpack, and src/js/mapGen.js. Keep them in lockstep.
const OWNER_MASK: u16 = 0x007F;
const TERRAIN_SHIFT: u16 = 7;
const TERRAIN_MASK: u16 = 0x000F << TERRAIN_SHIFT; // 0x0780
const DEFENSE_SHIFT: u16 = 11;
const DEFENSE_MASK: u16 = 0x000F << DEFENSE_SHIFT; // 0x7800
const BUILDING_MASK: u16 = 0x8000;

// --- Population growth tuning ---
// Troop growth per second follows a downward parabola in the population ratio
// p = troops / max_cap, with roots at p = 1.0 and p = -0.2. That puts the peak
// at p = 0.40 and makes growth zero at 100% population, while staying positive
// at p = 0 so a wiped-out faction still regenerates. The shape is normalized so
// shape(0.40) = 1.0 (shape(0) ≈ 0.556 is the natural low-population floor).
const GROWTH_PEAK_RATIO: f32 = 0.40;
// Vertex of a parabola is the midpoint of its roots, so root2 = 2*peak - 1.
const GROWTH_ROOT2: f32 = 2.0 * GROWTH_PEAK_RATIO - 1.0; // -0.2
// shape(p) = (1 - p)(p - root2); divide by its value at the peak to normalize.
const GROWTH_SHAPE_PEAK: f32 =
    (1.0 - GROWTH_PEAK_RATIO) * (GROWTH_PEAK_RATIO - GROWTH_ROOT2); // 0.36
// Troops/sec at the peak, as a fraction of the player's max population cap.
const PEAK_GROWTH_FRACTION: f32 = 0.05;
// Absolute troops/sec floor so even a tiny empire always recovers from zero.
const MIN_GROWTH_PER_SEC: f32 = 5.0;

// Max population scales purely with territory: cap = owned_cells * this.
// (Tune here — there is no flat base, so initial cap = starting cells * this.)
const POP_CAP_PER_CELL: u32 = 2;

// A freshly spawned faction starts with troops = this fraction of its max pop.
const INITIAL_FILL_RATIO: f32 = 0.40;

// Expansion velocity scales with the committed (attacking) troops: cells
// conquered per tick ≈ attack_pool * EXPANSION_CELLS_PER_TROOP, clamped to
// [MIN, MAX] so a tiny attack still creeps forward and a huge one advances as
// an organic shell rather than teleporting. As the pool drains the front slows.
const EXPANSION_CELLS_PER_TROOP: f32 = 0.08;
const MIN_CONQUERS_PER_TICK: usize = 2;
const MAX_CONQUERS_PER_TICK: usize = 40;

/// The Core Simulation State using a Structure of Arrays (SoA) Layout.
/// This completely avoids OOP overhead and GC pressure.
#[wasm_bindgen]
pub struct SimulationState {
    // --- Map Cell Data ---
    // Packed per-cell field: owner / terrain / defense / has_building (see layout above).
    cell_data: Vec<u16>,
    troops: Vec<u32>,
    difficulty_to_invade: Vec<u32>,
    last_modified_tick: Vec<u32>,
    
    // Fixed-stride flat array of 8 neighbors per cell (Moore neighborhood):
    //   0=Top, 1=Right, 2=Bottom, 3=Left,
    //   4=Top-Left, 5=Top-Right, 6=Bottom-Right, 7=Bottom-Left.
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
    // What the current expansion is allowed to conquer, set from the clicked cell:
    //   0  = neutral land only (respect all players' borders)
    //   X  = neutral land + faction X's cells (an attack aimed at X only)
    player_target_owner: Vec<u32>,
    player_gold: Vec<u32>,
    player_population_growth_rate: Vec<u32>,
    player_is_alive: Vec<u8>,
    player_account_id: Vec<u32>,
    player_color_index: Vec<u8>,
    player_max_population_cap: Vec<u32>,
    // Running sums of owned-cell row/col per player. Divided by owned_cells they
    // give the territory centroid (where the client draws the name/troop label).
    // Maintained incrementally on every owner change — no extra grid scan.
    player_row_sum: Vec<f32>,
    player_col_sum: Vec<f32>,

    current_tick: u32,
    // Simulation tick rate (Hz). Per-second rates are divided by this so the
    // sim behaves identically regardless of how fast the server ticks it.
    tick_hz: u32,
    // xorshift RNG state — used to randomize the order cells are conquered so
    // expansion grows radially in all directions rather than toward the target.
    rng_state: u32,
}

#[wasm_bindgen]
impl SimulationState {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SimulationState {
        let mut state = SimulationState {
            // Map Initializers
            cell_data: vec![0; TOTAL_CELLS],
            troops: vec![0; TOTAL_CELLS],
            difficulty_to_invade: vec![0; TOTAL_CELLS],
            last_modified_tick: vec![0; TOTAL_CELLS],
            neighbor_graph: vec![-1; TOTAL_CELLS * 8],
            delta_scratch: vec![0; TOTAL_CELLS * 2],

            // Player Initializers
            player_owned_cells: vec![0; PLAYER_ARRAY_SIZE],
            player_total_troops: vec![0.0; PLAYER_ARRAY_SIZE],
            player_attack_pool: vec![0.0; PLAYER_ARRAY_SIZE],
            player_expansion_target: vec![-1; PLAYER_ARRAY_SIZE],
            player_target_owner: vec![0; PLAYER_ARRAY_SIZE],
            player_gold: vec![0; PLAYER_ARRAY_SIZE],
            player_population_growth_rate: vec![0; PLAYER_ARRAY_SIZE],
            player_is_alive: vec![0; PLAYER_ARRAY_SIZE],
            player_account_id: vec![0; PLAYER_ARRAY_SIZE],
            player_color_index: vec![0; PLAYER_ARRAY_SIZE],
            player_max_population_cap: vec![0; PLAYER_ARRAY_SIZE],
            player_row_sum: vec![0.0; PLAYER_ARRAY_SIZE],
            player_col_sum: vec![0.0; PLAYER_ARRAY_SIZE],

            current_tick: 0,
            tick_hz: 60,
            rng_state: 0x9E3779B9,
        };

        state.initialize_neighbor_graph();
        state
    }

    // --- Packed cell field accessors (see the bit layout near the top) ---
    // These are plain value get/set helpers, so reads stay cheap and writes are
    // read-modify-write that preserve the other fields in the same u16.

    #[inline]
    fn cell_owner(&self, i: usize) -> u32 {
        (self.cell_data[i] & OWNER_MASK) as u32
    }

    #[inline]
    fn set_cell_owner(&mut self, i: usize, owner: u32) {
        self.cell_data[i] = (self.cell_data[i] & !OWNER_MASK) | ((owner as u16) & OWNER_MASK);
    }

    #[inline]
    fn cell_terrain(&self, i: usize) -> u8 {
        ((self.cell_data[i] & TERRAIN_MASK) >> TERRAIN_SHIFT) as u8
    }

    #[allow(dead_code)]
    #[inline]
    fn set_cell_terrain(&mut self, i: usize, terrain: u8) {
        self.cell_data[i] =
            (self.cell_data[i] & !TERRAIN_MASK) | (((terrain as u16) << TERRAIN_SHIFT) & TERRAIN_MASK);
    }

    #[allow(dead_code)]
    #[inline]
    fn cell_defense(&self, i: usize) -> u8 {
        ((self.cell_data[i] & DEFENSE_MASK) >> DEFENSE_SHIFT) as u8
    }

    #[allow(dead_code)]
    #[inline]
    fn set_cell_defense(&mut self, i: usize, tier: u8) {
        self.cell_data[i] =
            (self.cell_data[i] & !DEFENSE_MASK) | (((tier as u16) << DEFENSE_SHIFT) & DEFENSE_MASK);
    }

    #[allow(dead_code)]
    #[inline]
    fn cell_has_building(&self, i: usize) -> bool {
        self.cell_data[i] & BUILDING_MASK != 0
    }

    #[allow(dead_code)]
    #[inline]
    fn set_cell_has_building(&mut self, i: usize, present: bool) {
        if present {
            self.cell_data[i] |= BUILDING_MASK;
        } else {
            self.cell_data[i] &= !BUILDING_MASK;
        }
    }

    /// Precomputes the neighbor graph for O(1) adjacency lookups.
    fn initialize_neighbor_graph(&mut self) {
        for row in 0..MAP_HEIGHT {
            for col in 0..MAP_WIDTH {
                let cell_id = row * MAP_WIDTH + col;
                let base_idx = cell_id * 8;

                let has_up = row > 0;
                let has_down = row < MAP_HEIGHT - 1;
                let has_left = col > 0;
                let has_right = col < MAP_WIDTH - 1;

                // --- Cardinal neighbors ---
                // Top (0)
                if has_up {
                    self.neighbor_graph[base_idx + 0] = ((row - 1) * MAP_WIDTH + col) as i32;
                }
                // Right (1)
                if has_right {
                    self.neighbor_graph[base_idx + 1] = (row * MAP_WIDTH + col + 1) as i32;
                }
                // Bottom (2)
                if has_down {
                    self.neighbor_graph[base_idx + 2] = ((row + 1) * MAP_WIDTH + col) as i32;
                }
                // Left (3)
                if has_left {
                    self.neighbor_graph[base_idx + 3] = (row * MAP_WIDTH + col - 1) as i32;
                }

                // --- Diagonal neighbors (completes the Moore neighborhood) ---
                // Top-Left (4)
                if has_up && has_left {
                    self.neighbor_graph[base_idx + 4] = ((row - 1) * MAP_WIDTH + col - 1) as i32;
                }
                // Top-Right (5)
                if has_up && has_right {
                    self.neighbor_graph[base_idx + 5] = ((row - 1) * MAP_WIDTH + col + 1) as i32;
                }
                // Bottom-Right (6)
                if has_down && has_right {
                    self.neighbor_graph[base_idx + 6] = ((row + 1) * MAP_WIDTH + col + 1) as i32;
                }
                // Bottom-Left (7)
                if has_down && has_left {
                    self.neighbor_graph[base_idx + 7] = ((row + 1) * MAP_WIDTH + col - 1) as i32;
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
            self.player_target_owner[i] = 0;
            self.player_gold[i] = 0;
            self.player_population_growth_rate[i] = 0;
            self.player_max_population_cap[i] = 0;
            self.player_account_id[i] = 0;
            self.player_color_index[i] = 0;
            self.player_row_sum[i] = 0.0;
            self.player_col_sum[i] = 0.0;
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
        
        let radius = 12isize;
        let mut cells_claimed = 0;
        
        for r in -radius..=radius {
            for c in -radius..=radius {
                if r*r + c*c <= radius*radius {
                    let rr = center_row as isize + r;
                    let cc = center_col as isize + c;
                    
                    if rr >= 0 && rr < MAP_HEIGHT as isize && cc >= 0 && cc < MAP_WIDTH as isize {
                        let idx = (rr as usize) * MAP_WIDTH + (cc as usize);
                        
                        // Ignore water (3)
                        if self.cell_terrain(idx) != 3 && self.cell_owner(idx) == 0 {
                            self.set_cell_owner(idx, faction_id);
                            self.last_modified_tick[idx] = self.current_tick;
                            self.player_row_sum[f] += rr as f32;
                            self.player_col_sum[f] += cc as f32;
                            cells_claimed += 1;
                        }
                    }
                }
            }
        }
        
        self.player_owned_cells[f] += cells_claimed;

        // Start at 40% of the (now-known) max population cap.
        let max_cap = (self.player_owned_cells[f] * POP_CAP_PER_CELL).max(1) as f32;
        self.player_total_troops[f] = max_cap * INITIAL_FILL_RATIO;
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

            // Decide what this expansion may conquer from the clicked cell's owner:
            //   own/neutral click → neutral land only; enemy click → attack that enemy.
            let tc = target_cell as usize;
            let clicked_owner = if tc < TOTAL_CELLS { self.cell_owner(tc) } else { 0 };
            self.player_target_owner[f] = if clicked_owner == faction_id { 0 } else { clicked_owner };
        }
    }

    /// Cancel an in-progress expansion: return all un-spent attacking troops to
    /// the defending pool and clear the target.
    #[wasm_bindgen]
    pub fn cancel_expansion(&mut self, faction_id: u32) {
        let f = faction_id as usize;
        if self.player_is_alive[f] == 0 { return; }
        self.player_total_troops[f] += self.player_attack_pool[f];
        self.player_attack_pool[f] = 0.0;
        self.player_expansion_target[f] = -1;
        self.player_target_owner[f] = 0;
    }

    // --- Core Simulation Ticks ---

    /// Tell the sim how many times per second it will be ticked, so per-second
    /// rates (e.g. troop growth) stay consistent across tick rates.
    #[wasm_bindgen]
    pub fn set_tick_hz(&mut self, hz: u32) {
        self.tick_hz = hz.max(1);
    }

    #[wasm_bindgen]
    pub fn tick(&mut self) {
        self.current_tick += 1;
        self.apply_production();
        self.process_war_fronts();
    }

    fn apply_production(&mut self) {
        let tick_hz = self.tick_hz.max(1) as f32;
        for i in 1..PLAYER_ARRAY_SIZE {
            if self.player_is_alive[i] == 1 {
                let cells = self.player_owned_cells[i];
                if cells == 0 {
                    self.player_is_alive[i] = 0;
                    continue;
                }

                // Max population scales purely with territory (no flat base).
                let max_cap = (cells * POP_CAP_PER_CELL).max(1);
                self.player_max_population_cap[i] = max_cap;
                let max_cap_f = max_cap as f32;

                // Population ratio p in [0, 1].
                let troops = self.player_total_troops[i];
                let p = (troops / max_cap_f).clamp(0.0, 1.0);

                // Growth curve (troops/sec): peaks at p = 0.40, zero at p = 1.0,
                // positive at p = 0 (the recovery floor). See the consts above.
                let shape = ((1.0 - p) * (p - GROWTH_ROOT2) / GROWTH_SHAPE_PEAK).max(0.0);
                let growth_per_sec =
                    (max_cap_f * PEAK_GROWTH_FRACTION * shape).max(MIN_GROWTH_PER_SEC);

                let new_troops = troops + growth_per_sec / tick_hz;
                // Never exceed the cap (this also enforces "zero growth at 100%").
                self.player_total_troops[i] = new_troops.min(max_cap_f);
            }
        }
    }

    /// How many of a cell's 8 neighbors are owned by faction `f` (0..8).
    /// Higher = more enclosed by our territory; used to fill concavities first.
    #[inline]
    fn owned_neighbor_count(&self, cell: usize, f: usize) -> u8 {
        let base = cell * 8;
        let mut count = 0u8;
        for i in 0..8 {
            let nb = self.neighbor_graph[base + i];
            if nb != -1 && self.cell_owner(nb as usize) as usize == f {
                count += 1;
            }
        }
        count
    }

    /// Fast xorshift32 PRNG for expansion ordering (not security-sensitive).
    #[inline]
    fn next_rand(&mut self) -> u32 {
        let mut x = self.rng_state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng_state = x;
        x
    }

    fn process_war_fronts(&mut self) {
        // Counter-attack annihilation: if two factions are attacking each other
        // (each clicked into the other's territory), their committed attack-pool
        // troops cancel 1-for-1 this tick — those troops are destroyed on both
        // sides. 20k vs 20k wipes both out; 20k vs 10k leaves the attacker with
        // 10k still pressing. Each unordered pair is handled once (a < b).
        for a in 1..PLAYER_ARRAY_SIZE {
            let b = self.player_target_owner[a] as usize;
            if b <= a || b >= PLAYER_ARRAY_SIZE { continue; }
            if self.player_target_owner[b] as usize != a { continue; }
            if self.player_attack_pool[a] <= 0.0 || self.player_attack_pool[b] <= 0.0 { continue; }

            let cancel = self.player_attack_pool[a].min(self.player_attack_pool[b]);
            self.player_attack_pool[a] -= cancel;
            self.player_attack_pool[b] -= cancel;

            // A side whose pool is now spent ends its attack here.
            for f in [a, b] {
                if self.player_attack_pool[f] <= 0.0 {
                    self.player_attack_pool[f] = 0.0;
                    self.player_expansion_target[f] = -1;
                    self.player_target_owner[f] = 0;
                }
            }
        }

        // Candidates = the conquerable cells (non-owned, non-water) directly
        // bordering each expanding faction's territory — i.e. the very next shell
        // of neighbors. We conquer a randomized subset of this shell each tick so
        // the whole border advances together in all directions (an organic blob),
        // rather than racing in a straight line toward the clicked target.
        let mut candidates: Vec<Vec<usize>> = vec![Vec::new(); PLAYER_ARRAY_SIZE];

        for cell_id in 0..TOTAL_CELLS {
            let owner = self.cell_owner(cell_id) as usize;
            if owner == 0 { continue; }
            if self.player_attack_pool[owner] <= 0.0 || self.player_expansion_target[owner] == -1 {
                continue;
            }

            // Only neutral land (owner 0) and — if this is an attack — the single
            // targeted enemy may be conquered. Every other player's cells are a
            // hard boundary, so neutral expansion never bleeds into a player and
            // an attack never spills onto third parties.
            let target_owner = self.player_target_owner[owner];
            let base_idx = cell_id * 8;
            for i in 0..8 {
                let n = self.neighbor_graph[base_idx + i];
                if n != -1 {
                    let n_idx = n as usize;
                    let n_owner = self.cell_owner(n_idx);
                    let conquerable = n_owner == 0 || n_owner == target_owner;
                    if conquerable && self.cell_terrain(n_idx) != 3 {
                        // May be pushed by several owned neighbors; dupes are
                        // harmless (skipped once owned below).
                        candidates[owner].push(n_idx);
                    }
                }
            }
        }

        // Resolve expansions per faction
        for f in 1..PLAYER_ARRAY_SIZE {
            let target = self.player_expansion_target[f];
            if target == -1 || self.player_attack_pool[f] <= 0.0 {
                continue;
            }

            // Nothing legal to conquer (e.g. fully walled in by water/other
            // players in this mode): refund the committed troops and stop.
            if candidates[f].is_empty() {
                self.player_total_troops[f] += self.player_attack_pool[f];
                self.player_attack_pool[f] = 0.0;
                self.player_expansion_target[f] = -1;
                self.player_target_owner[f] = 0;
                continue;
            }

            // A cell can border several of our cells, so collapse duplicates.
            candidates[f].sort_unstable();
            candidates[f].dedup();

            // Score each border cell by how enclosed it already is by our
            // territory (its owned-neighbor count). We conquer the MOST enclosed
            // cells first so concavities — and any cell that would otherwise be
            // surrounded — are filled before the frontier pushes outward. This
            // guarantees no enclosed/un-owned pockets are ever left behind, while
            // a random tiebreak keeps same-enclosure growth radial in all dirs.
            let mut scored: Vec<(u8, u32, usize)> = Vec::with_capacity(candidates[f].len());
            for &c in candidates[f].iter() {
                let enclosure = self.owned_neighbor_count(c, f);
                let tiebreak = self.next_rand();
                scored.push((enclosure, tiebreak, c));
            }
            // Most enclosed first; random order within the same enclosure level.
            scored.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));

            // Expansion speed is proportional to the committed (attacking) troops,
            // clamped so it stays organic. Recomputed each tick from the current
            // pool, so the front slows down as the attack is spent.
            let max_conquers = ((self.player_attack_pool[f] * EXPANSION_CELLS_PER_TROOP) as usize)
                .clamp(MIN_CONQUERS_PER_TICK, MAX_CONQUERS_PER_TICK);
            let mut conquers = 0;

            for &(_, _, n_idx) in scored.iter() {
                if conquers >= max_conquers { break; }
                if self.player_attack_pool[f] <= 0.0 { break; }

                let n_owner = self.cell_owner(n_idx) as usize;
                // Water already excluded; cells are deduped so this is just a guard.
                if n_owner == f { continue; }

                let base_cost = match self.cell_terrain(n_idx) {
                    0 => 1.0, // Plains
                    1 => 3.0, // Highlands
                    2 => 6.0, // Mountains
                    _ => 99.0,
                };

                let mut total_cost = base_cost;
                if n_owner != 0 {
                    // Taking a defended cell wastes extra attacker troops equal to
                    // the defender's difficulty_to_invade. Placeholder formula:
                    // (currently-defending troops) / (cells) — i.e. how densely the
                    // defender's standing army covers its land. Sending troops out to
                    // attack lowers the home pool, making your own land easier to take.
                    // (Flip the ratio here if difficulty should be cells/troops.)
                    let defender_cells = self.player_owned_cells[n_owner].max(1) as f32;
                    let difficulty_to_invade = self.player_total_troops[n_owner] / defender_cells;
                    total_cost += difficulty_to_invade;
                }

                if self.player_attack_pool[f] >= total_cost {
                    self.player_attack_pool[f] -= total_cost;

                    let nr = (n_idx / MAP_WIDTH) as f32;
                    let nc = (n_idx % MAP_WIDTH) as f32;

                    if n_owner != 0 {
                        self.player_total_troops[n_owner] -= total_cost - base_cost;
                        if self.player_total_troops[n_owner] < 0.0 {
                            self.player_total_troops[n_owner] = 0.0;
                        }
                        self.player_owned_cells[n_owner] = self.player_owned_cells[n_owner].saturating_sub(1);
                        // Cell leaves the previous owner's territory centroid.
                        self.player_row_sum[n_owner] -= nr;
                        self.player_col_sum[n_owner] -= nc;
                    }

                    self.set_cell_owner(n_idx, f as u32);
                    self.last_modified_tick[n_idx] = self.current_tick;
                    self.player_owned_cells[f] += 1;
                    self.player_row_sum[f] += nr;
                    self.player_col_sum[f] += nc;
                    conquers += 1;
                    // Note: we do NOT stop when the clicked cell is reached — the
                    // attack keeps expanding until the pool is spent (end condition
                    // below) or the player cancels it with Space (cancel_expansion).
                }
            }

            // End attack condition
            if self.player_attack_pool[f] < 1.0 {
                self.player_total_troops[f] += self.player_attack_pool[f];
                self.player_attack_pool[f] = 0.0;
                self.player_expansion_target[f] = -1;
            }
        }
    }

    // --- Raw Pointer Exposure for JavaScript Zero-Copy Access ---
    
    // Map Fields
    // Packed owner/terrain/defense/has_building, one u16 per cell. JS reads owner
    // and terrain by masking this buffer (see src/js/constants.js for the layout).
    #[wasm_bindgen]
    pub fn get_cell_data_ptr(&self) -> *const u16 { self.cell_data.as_ptr() }

    #[wasm_bindgen]
    pub fn get_troops_ptr(&self) -> *const u32 { self.troops.as_ptr() }

    #[wasm_bindgen]
    pub fn get_difficulty_to_invade_ptr(&self) -> *const u32 { self.difficulty_to_invade.as_ptr() }

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

    // Territory centroid = (row_sum/owned_cells, col_sum/owned_cells).
    #[wasm_bindgen]
    pub fn get_player_row_sum_ptr(&self) -> *const f32 { self.player_row_sum.as_ptr() }

    #[wasm_bindgen]
    pub fn get_player_col_sum_ptr(&self) -> *const f32 { self.player_col_sum.as_ptr() }

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
                let owner = self.cell_owner(cell_id);
                self.delta_scratch[count * 2] = cell_id as u32;
                self.delta_scratch[count * 2 + 1] = owner;
                count += 1;
            }
        }
        count as u32
    }

    #[wasm_bindgen]
    pub fn get_delta_scratch_ptr(&self) -> *const u32 { self.delta_scratch.as_ptr() }
}
