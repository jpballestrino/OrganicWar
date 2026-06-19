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

// ── Anti-snowball production throttle ─────────────────────────────────────────
// A runaway empire out-PRODUCES what it loses (troops/sec scales with cells), so
// it can keep funding reckless conquests. We throttle PRODUCTION (not capacity)
// above a per-match "soft cap" = GROWTH_FAIR_SHARE_MULT × a player's fair share
// of the land (land_cells / num_players, computed once in init_players). Cells
// beyond the soft cap contribute only GROWTH_OVERSIZE_FACTOR toward troops/sec,
// so a giant empire's production flattens toward a mid-size empire's.
//
// Deliberately leaves max_cap / density LINEAR (cells × POP_CAP_PER_CELL): the
// combat model and the client's maxPop→cells display both rely on that, and we
// don't want to also make big empires defensively fragile (that's a separate knob
// — to couple it, diminish max_cap here too, but then fix the client's
// `maxPop / POP_CAP_PER_CELL` cell-count derivation). Tune gently: the growth
// curve is a parabola in p = troops/cap, so throttling bites super-linearly.
const GROWTH_FAIR_SHARE_MULT: f32 = 2.0;  // full rate up to ~2× your fair share
const GROWTH_OVERSIZE_FACTOR: f32 = 0.5;  // territory beyond that produces at 50%

// Gold income per owned cell per second; total income scales with territory.
// Mirrored in src/js/constants.js (GOLD_PER_CELL_PER_SEC) so the HUD can show
// the income rate without an extra wire field — keep the two in sync.
const GOLD_PER_CELL_PER_SEC: f32 = 0.00333;

// A freshly spawned faction starts with troops = this fraction of its max pop.
const INITIAL_FILL_RATIO: f32 = 0.80;

// Expansion velocity scales with the committed (attacking) troops: cells
// conquered per tick ≈ attack_pool * EXPANSION_CELLS_PER_TROOP, clamped to
// [MIN, MAX] so a tiny attack still creeps forward and a huge one advances as
// an organic shell rather than teleporting. As the pool drains the front slows.
const EXPANSION_CELLS_PER_TROOP: f32 = 0.72;
const MIN_CONQUERS_PER_TICK: usize = 5;
const MAX_CONQUERS_PER_TICK: usize = 240;

// A front with fewer committed troops than this is treated as inactive/closed.
const FRONT_EPS: f32 = 0.0001;

// Defense building influence radius (cells). A building fortifies its builder's
// own cells within this radius to defense_tier 10. Mirrored on the client in
// src/js/constants.js (BUILDING_RADIUS) and emitted in the building-placed event.
const BUILDING_RADIUS: i32 = 40;

// Gold cost to place a defense building. Charged in place_defense_building after
// validation; the placement fails if the builder can't afford it. Mirrored in
// src/js/constants.js (DEFENSE_BUILDING_COST) for the HUD / client pre-check.
const DEFENSE_BUILDING_COST: f32 = 2000.0;

// Construction time for a defense building, in seconds. The tower occupies its
// footprint immediately but grants NO defense bonus until this elapses (the
// client shows a fill bar meanwhile). Converted to ticks via tick_hz at
// placement so the build time is identical at any SIM_TICK_HZ. Mirrored in
// src/js/constants.js (DEFENSE_BUILD_MS) and emitted in the building-placed event.
const DEFENSE_BUILD_SECONDS: f32 = 5.0;

// Building type tags, stored in `building_type` parallel to `defense_buildings`.
const BTYPE_DEFENSE: u8 = 0;
const BTYPE_SILO: u8 = 1;
const BTYPE_MINE: u8 = 2;
const BTYPE_ANTIAIR: u8 = 3;

// Missile silo: a building that can fire missiles at targets within SILO_RANGE
// cells. Costs more and takes longer to build than a defense tower, and grants
// NO fortification bonus. Mirrored in src/js/constants.js.
const SILO_BUILDING_COST: f32 = 10000.0;
const SILO_BUILD_SECONDS: f32 = 10.0;
const SILO_RANGE: i32 = 240;
// Missile: fired from a completed silo. Costs MISSILE_COST gold and razes every
// cell within MISSILE_BLAST_RADIUS of the impact to neutral (nature), destroying
// troops and any buildings there. Mirrored in src/js/constants.js.
const MISSILE_COST: f32 = 2000.0;
const MISSILE_BLAST_RADIUS: i32 = 15;

const MINE_BUILDING_COST: f32 = 3000.0;
const MINE_BUILD_SECONDS: f32 = 10.0;

const ANTIAIR_BUILDING_COST: f32 = 5000.0;
const ANTIAIR_BUILD_SECONDS: f32 = 10.0;
const ANTIAIR_RADIUS: i32 = 400;
const ANTIAIR_MAX_CHARGES: u8 = 3;

const BTYPE_CITY: u8 = 4;
const CITY_BUILDING_COST: f32 = 2000.0;
const CITY_BUILD_SECONDS: f32 = 5.0;
const CITY_POP_BONUS: f32 = 0.05;

// Upper bound for per-cell difficulty_to_invade (troops-per-cell × enclosure).
// The client uses this same value to normalize density to 0..1 for the shader,
// so density == DIFFICULTY_CAP → fully solid interior at max enclosure.
// Mirrored in src/js/constants.js (DIFFICULTY_CAP).
const DIFFICULTY_CAP: f32 = 50.0;

// Flat troop cost to conquer a neutral (unowned) cell, regardless of terrain.
// Neutral land is cheap to grab so factions spread quickly over open map;
// the terrain-weighted difficulty_to_invade only governs owned (defended)
// cells. This is a fractional cost, so it cannot live in the u32
// difficulty_to_invade buffer — it is applied directly in process_war_fronts.
const NEUTRAL_INVADE_COST: f32 = 0.2;

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
    

    // Scratch buffer for delta export: interleaved (cell_id, owner_id) u32 pairs.
    // Sized to worst case so we never reallocate during a tick.
    delta_scratch: Vec<u32>,
    
    // Incremental dirty list of cell_ids whose ownership changed since the last snapshot clear.
    dirty_cells: Vec<u32>,

    // Active defense buildings: each entry is center encoded as row*MAP_WIDTH+col.
    defense_buildings: Vec<u32>,
    // Parallel to defense_buildings (same index `i`): the tick at which each
    // building finishes construction. 0 = complete/active. While > current_tick
    // the building occupies its footprint and can be destroyed, but grants no
    // defense bonus (no tier stamp, skipped in cell_in_own_building_radius).
    // INVARIANT: defense_build_complete.len() == defense_buildings.len() — both
    // are mutated only in place_defense_building (push) and destroy_building
    // (swap_remove), always in lockstep.
    defense_build_complete: Vec<u32>,
    // Parallel to defense_buildings (same index `i`): building type tag
    // (BTYPE_DEFENSE / BTYPE_SILO). Same INVARIANT — pushed in
    // place_building_internal and swap_remove'd in destroy_building alongside the
    // others. Lets one list hold every building type while keeping the defense
    // fortification logic (cell_in_own_building_radius, completion stamp) to
    // BTYPE_DEFENSE only.
    building_type: Vec<u8>,
    // Parallel to defense_buildings (same index `i`): the faction that owns the
    // building. Defense towers are destroyed on any footprint conquest so this
    // never changes for them, but a silo survives partial conquest and only
    // transfers (try_transfer_silo) once a single enemy owns all 64 footprint
    // cells — so fire_missile / completion read this, NOT cell_owner(center).
    // INVARIANT: all four of defense_buildings / defense_build_complete /
    // building_type / building_owner share one length, pushed together in
    // place_building_internal and swap_remove'd together in destroy_building.
    building_owner: Vec<u32>,
    // Tracks charges for AA batteries.
    building_charges: Vec<u8>,
    // Tracks when the building can perform its next action (e.g., when a silo can fire again). 0 means ready.
    building_cooldown: Vec<u32>,
    // Silos that changed owner since the last clear, as (center, new_owner) u32
    // pairs. Broadcast as `building-owner-changed` so clients recolor the icon
    // and update who may fire from it. (A broadcast buffer, NOT a parallel vec.)
    transferred_buildings_buf: Vec<u32>,
    // Buildings destroyed since the last clear_destroyed_buildings() call.
    // Encoded the same way as defense_buildings so the server can broadcast them.
    destroyed_buildings_buf: Vec<u32>,
    // Buildings that finished construction since the last clear_completed_buildings()
    // call, as (center, faction_id) u32 pairs. The server polls this to broadcast
    // `building-completed` so clients stamp the fortification tier locally.
    completed_buildings_buf: Vec<u32>,
    // Bot-placed buildings since the last clear_placed_buildings() call, as
    // (center, faction_id) u32 pairs. Human placements are broadcast directly
    // from handleInput, so only bot builds need this poll-and-broadcast buffer.
    placed_buildings_buf: Vec<u32>,
    // Successful missile fires by humans and bots, broadcast as (row, col, radius) triplets
    fired_missiles_buf: Vec<u32>,
    // Missiles that were intercepted by AA. Triplet (source_row, source_col, target_row, target_col).
    intercepted_missiles_buf: Vec<u32>,
    // In-flight missiles pending detonation: [target_row, target_col, faction_id, remaining_ticks]
    inflight_missiles: Vec<u32>,

    // --- Player Data ---
    player_owned_cells: Vec<u32>,
    player_total_troops: Vec<f32>,
    // Per-player TOTAL troops committed to attacks (sum of all that player's
    // fronts). Derived from `front_pool` each tick; exported for the HUD.
    player_attack_pool: Vec<f32>,
    // Multiple simultaneous attack fronts per faction, laid out row-major as
    // `front_pool[attacker * PLAYER_ARRAY_SIZE + target]` = troops `attacker`
    // has committed against target-owner `target`:
    //   target 0  = neutral land (respect all players' borders)
    //   target X  = attack faction X's cells only
    // A front is active while its pool > FRONT_EPS. A faction can hold an
    // active neutral front and several enemy fronts at once, each advancing
    // independently from its own committed troops.
    front_pool: Vec<f32>,
    // Accumulated gold (f32 so fractional per-tick income accrues correctly).
    player_gold: Vec<f32>,
    player_kill_count: Vec<f32>,
    player_gold_spent: Vec<f32>,
    player_population_growth_rate: Vec<u32>,
    player_is_alive: Vec<u8>,
    // 1 = server-driven bot (gets a heuristic target each think tick), 0 = human.
    player_is_bot: Vec<u8>,
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
    // Per-player territory size beyond which production is throttled (see the
    // anti-snowball consts). Set once in init_players from land_cells/num_players;
    // 0 = no throttle (e.g. before init or on the client render cache).
    growth_soft_cap: u32,
    // xorshift RNG state — used to randomize the order cells are conquered so
    // expansion grows radially in all directions rather than toward the target.
    rng_state: u32,
}

#[wasm_bindgen]
impl SimulationState {
    #[wasm_bindgen(constructor)]
    pub fn new() -> SimulationState {
        let state = SimulationState {
            // Map Initializers
            cell_data: vec![0; TOTAL_CELLS],
            troops: vec![0; TOTAL_CELLS],
            difficulty_to_invade: vec![0; TOTAL_CELLS],
            last_modified_tick: vec![0; TOTAL_CELLS],
            delta_scratch: vec![0; TOTAL_CELLS * 2],
            dirty_cells: Vec::new(),
            defense_buildings: Vec::new(),
            defense_build_complete: Vec::new(),
            building_type: Vec::new(),
            building_owner: Vec::new(),
            building_charges: Vec::new(),
            building_cooldown: Vec::new(),
            transferred_buildings_buf: Vec::new(),
            destroyed_buildings_buf: Vec::new(),
            completed_buildings_buf: Vec::new(),
            placed_buildings_buf: Vec::new(),
            fired_missiles_buf: Vec::new(),
            intercepted_missiles_buf: Vec::new(),
            inflight_missiles: Vec::new(),

            // Player Initializers
            player_owned_cells: vec![0; PLAYER_ARRAY_SIZE],
            player_total_troops: vec![0.0; PLAYER_ARRAY_SIZE],
            player_attack_pool: vec![0.0; PLAYER_ARRAY_SIZE],
            front_pool: vec![0.0; PLAYER_ARRAY_SIZE * PLAYER_ARRAY_SIZE],
            player_gold: vec![0.0; PLAYER_ARRAY_SIZE],
            player_kill_count: vec![0.0; PLAYER_ARRAY_SIZE],
            player_gold_spent: vec![0.0; PLAYER_ARRAY_SIZE],
            player_population_growth_rate: vec![0; PLAYER_ARRAY_SIZE],
            player_is_alive: vec![0; PLAYER_ARRAY_SIZE],
            player_is_bot: vec![0; PLAYER_ARRAY_SIZE],
            player_account_id: vec![0; PLAYER_ARRAY_SIZE],
            player_color_index: vec![0; PLAYER_ARRAY_SIZE],
            player_max_population_cap: vec![0; PLAYER_ARRAY_SIZE],
            player_row_sum: vec![0.0; PLAYER_ARRAY_SIZE],
            player_col_sum: vec![0.0; PLAYER_ARRAY_SIZE],

            current_tick: 0,
            tick_hz: 60,
            growth_soft_cap: 0,
            rng_state: 0x9E3779B9,
        };

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
        let old_owner = self.cell_data[i] & OWNER_MASK;
        let new_owner = (owner as u16) & OWNER_MASK;
        if old_owner != new_owner {
            self.cell_data[i] = (self.cell_data[i] & !OWNER_MASK) | new_owner;
            self.dirty_cells.push(i as u32);
        }
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

    /// True if faction `f` has any attack front with troops still committed.
    #[inline]
    fn has_active_front(&self, f: usize) -> bool {
        let base = f * PLAYER_ARRAY_SIZE;
        for t in 0..PLAYER_ARRAY_SIZE {
            if self.front_pool[base + t] > FRONT_EPS { return true; }
        }
        false
    }

    /// Returns the neighbor of a cell in a given direction (0-7), or -1 if none.
    #[inline(always)]
    fn get_neighbor(cell: usize, dir: usize) -> i32 {
        let row = cell / MAP_WIDTH;
        let col = cell % MAP_WIDTH;
        let has_up = row > 0;
        let has_down = row < MAP_HEIGHT - 1;
        let has_left = col > 0;
        let has_right = col < MAP_WIDTH - 1;

        match dir {
            0 => if has_up { ((row - 1) * MAP_WIDTH + col) as i32 } else { -1 },
            1 => if has_right { (row * MAP_WIDTH + col + 1) as i32 } else { -1 },
            2 => if has_down { ((row + 1) * MAP_WIDTH + col) as i32 } else { -1 },
            3 => if has_left { (row * MAP_WIDTH + col - 1) as i32 } else { -1 },
            4 => if has_up && has_left { ((row - 1) * MAP_WIDTH + col - 1) as i32 } else { -1 },
            5 => if has_up && has_right { ((row - 1) * MAP_WIDTH + col + 1) as i32 } else { -1 },
            6 => if has_down && has_right { ((row + 1) * MAP_WIDTH + col + 1) as i32 } else { -1 },
            7 => if has_down && has_left { ((row + 1) * MAP_WIDTH + col - 1) as i32 } else { -1 },
            _ => -1,
        }
    }

    /// Initialize the players with their starting resources.
    #[wasm_bindgen]
    pub fn init_players(
        &mut self,
        num_players: u8,
        start_gold: u32,
        start_growth_rate: u32,
        start_max_cap: u32,
    ) {
        // Clear old player states
        for i in 1..PLAYER_ARRAY_SIZE {
            self.player_is_alive[i] = 0;
            self.player_is_bot[i] = 0;
            self.player_owned_cells[i] = 0;
            self.player_total_troops[i] = 0.0;
            self.player_attack_pool[i] = 0.0;
            // Clear all of this faction's attack fronts.
            for t in 0..PLAYER_ARRAY_SIZE {
                self.front_pool[i * PLAYER_ARRAY_SIZE + t] = 0.0;
            }
            self.player_gold[i] = 0.0;
            self.player_population_growth_rate[i] = 0;
            self.player_max_population_cap[i] = 0;
            self.player_account_id[i] = 0;
            self.player_color_index[i] = 0;
            self.player_row_sum[i] = 0.0;
            self.player_col_sum[i] = 0.0;
        }

        let actual_players = if num_players as usize > MAX_PLAYERS { MAX_PLAYERS } else { num_players as usize };

        // Anti-snowball: set the production soft cap at GROWTH_FAIR_SHARE_MULT ×
        // each player's fair share of the land. Terrain is generated (by the
        // server worker) before init_players, so cell_terrain is valid here.
        // Water (terrain 3) is never conquerable, so only land counts.
        let mut land_cells: u32 = 0;
        for c in 0..TOTAL_CELLS {
            if self.cell_terrain(c) != 3 { land_cells += 1; }
        }
        let fair_share = land_cells as f32 / actual_players.max(1) as f32;
        self.growth_soft_cap = (fair_share * GROWTH_FAIR_SHARE_MULT).max(1.0) as u32;

        // Initialize active players (indices 1 through N)
        for i in 1..=actual_players {
            self.player_is_alive[i] = 1;
            self.player_owned_cells[i] = 0;
            self.player_total_troops[i] = 0.0;
            self.player_gold[i] = start_gold as f32;
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
            // Decide which front the clicked cell feeds:
            //   own/neutral click → neutral front (0); enemy click → that enemy.
            // Distinct enemies open distinct fronts that advance simultaneously;
            // re-clicking a target just reinforces its existing front.
            let tc = target_cell as usize;
            let clicked_owner = if tc < TOTAL_CELLS { self.cell_owner(tc) } else { 0 };
            let target = if clicked_owner == faction_id { 0 } else { clicked_owner as usize };

            self.player_total_troops[f] -= troops_to_send;
            self.front_pool[f * PLAYER_ARRAY_SIZE + target] += troops_to_send;
            self.player_attack_pool[f] += troops_to_send;
        }
    }

    /// Cancel all in-progress attacks: return every front's un-spent troops to
    /// the defending pool and close the fronts.
    #[wasm_bindgen]
    pub fn cancel_expansion(&mut self, faction_id: u32) {
        let f = faction_id as usize;
        if f == 0 || f >= PLAYER_ARRAY_SIZE || self.player_is_alive[f] == 0 { return; }
        for t in 0..PLAYER_ARRAY_SIZE {
            let fi = f * PLAYER_ARRAY_SIZE + t;
            self.player_total_troops[f] += self.front_pool[fi];
            self.front_pool[fi] = 0.0;
        }
        self.player_attack_pool[f] = 0.0;
    }

    /// Cancel only a specific attack front.
    #[wasm_bindgen]
    pub fn cancel_front(&mut self, faction_id: u32, target_faction: u32) {
        let f = faction_id as usize;
        let t = target_faction as usize;
        if f == 0 || f >= PLAYER_ARRAY_SIZE || t >= PLAYER_ARRAY_SIZE || self.player_is_alive[f] == 0 { return; }
        
        let fi = f * PLAYER_ARRAY_SIZE + t;
        let troops = self.front_pool[fi];
        
        if troops > 0.0 {
            self.player_total_troops[f] += troops;
            self.front_pool[fi] = 0.0;
            self.player_attack_pool[f] -= troops;
            if self.player_attack_pool[f] < 0.0 {
                self.player_attack_pool[f] = 0.0;
            }
        }
    }

    /// Mark a faction as a server-driven bot (or clear the flag). Bots get a
    /// heuristic expansion target each think tick via `bot_think_all`.
    #[wasm_bindgen]
    pub fn set_player_is_bot(&mut self, faction_id: u32, is_bot: bool) {
        let f = faction_id as usize;
        if f == 0 || f >= PLAYER_ARRAY_SIZE { return; }
        self.player_is_bot[f] = if is_bot { 1 } else { 0 };
    }

    /// Drive every bot faction one decision. Uses a simple heuristic over each
    /// bot's current border, gathered in a SINGLE grid pass for all bots at once
    /// (so cost is independent of bot count):
    ///   * Prefer growing into the cheapest bordering neutral land (plains before
    ///     highlands before mountains) — safe, economy-building expansion.
    ///   * Attack the WEAKEST bordering enemy (lowest troops-per-cell) only when
    ///     boxed in with no neutral land, or when we clearly out-muscle them
    ///     (our troops-per-cell beats theirs by a margin) — opportunistic, but it
    ///     won't throw troops at a defender it can't crack.
    /// Commits `attack_percentage` of the bot's troops toward a representative
    /// cell in the chosen direction. Bots with an attack already in flight, no
    /// land, or nothing legal to take are skipped.
    #[wasm_bindgen]
    pub fn bot_think_all(&mut self, attack_percentage: u8) {
        // Which factions need a fresh decision this tick.
        let mut consider = [false; PLAYER_ARRAY_SIZE];
        let mut any = false;
        for f in 1..PLAYER_ARRAY_SIZE {
            if self.player_is_bot[f] == 1
                && self.player_owned_cells[f] > 0
                && !self.has_active_front(f)
            {
                consider[f] = true;
                any = true;
            }
        }
        if !any { return; }

        // Per-bot accumulators, filled in one pass over the grid.
        let mut best_neutral_cost = [f32::INFINITY; PLAYER_ARRAY_SIZE];
        let mut best_neutral_cell = [-1i64; PLAYER_ARRAY_SIZE];
        let mut weakest_enemy_strength = [f32::INFINITY; PLAYER_ARRAY_SIZE];
        let mut weakest_enemy_cell = [-1i64; PLAYER_ARRAY_SIZE];

        for cell in 0..TOTAL_CELLS {
            let o = self.cell_owner(cell) as usize;
            if o == 0 || o >= PLAYER_ARRAY_SIZE || !consider[o] {
                continue;
            }
            for i in 0..8 {
                let n = Self::get_neighbor(cell, i);
                if n == -1 { continue; }
                let n_idx = n as usize;
                let terrain = self.cell_terrain(n_idx);
                if terrain == 3 { continue; } // water is never conquerable
                let n_owner = self.cell_owner(n_idx) as usize;
                if n_owner == o { continue; }

                if n_owner == 0 {
                    let cost = match terrain {
                        0 => 1.0, // Plains
                        1 => 3.0, // Highlands
                        2 => 6.0, // Mountains
                        _ => 99.0,
                    };
                    if cost < best_neutral_cost[o] {
                        best_neutral_cost[o] = cost;
                        best_neutral_cell[o] = n_idx as i64;
                    }
                } else if n_owner < PLAYER_ARRAY_SIZE {
                    let cells = self.player_owned_cells[n_owner].max(1) as f32;
                    let strength = self.player_total_troops[n_owner] / cells;
                    if strength < weakest_enemy_strength[o] {
                        weakest_enemy_strength[o] = strength;
                        weakest_enemy_cell[o] = n_idx as i64;
                    }
                }
            }
        }

        // Decide + commit per bot.
        for f in 1..PLAYER_ARRAY_SIZE {
            if !consider[f] { continue; }

            let our_cells = self.player_owned_cells[f].max(1) as f32;
            let our_strength = self.player_total_troops[f] / our_cells;
            let has_neutral = best_neutral_cell[f] != -1;
            let has_enemy = weakest_enemy_cell[f] != -1;
            // Attack only if it's worth it: we comfortably out-muscle the weakest
            // bordering enemy (1.5x troops-per-cell margin covers the invade cost).
            let can_overpower = has_enemy && our_strength > weakest_enemy_strength[f] * 1.5;

            let target_cell = if has_neutral && !can_overpower {
                best_neutral_cell[f]
            } else if has_enemy {
                weakest_enemy_cell[f]
            } else if has_neutral {
                best_neutral_cell[f]
            } else {
                -1 // fully walled in (only water borders) — sit tight this tick
            };

            if target_cell != -1 {
                self.execute_expansion(f as u32, target_cell as u32, attack_percentage);
            }
        }
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
        self.process_inflight_missiles();
        // Finish any buildings whose construction time has elapsed. MUST run after
        // process_war_fronts: a building conquered the same tick it would complete
        // is swap_removed first and never reaches the completion buffer, so it can
        // never emit both building-completed and building-destroyed.
        self.process_construction();
        // Recompute per-cell difficulty once per second. Interior cells of a dense
        // territory become progressively harder to crack; freshly taken border cells
        // reset to 0 at conquest and rebuild over this interval.
        if self.current_tick % self.tick_hz == 0 {
            self.update_cell_difficulties();
        }
    }

    fn update_cell_difficulties(&mut self) {
        // Pre-compute per-player troop density (troops / owned_cells) once.
        let mut density = [0.0f32; PLAYER_ARRAY_SIZE];
        for p in 1..PLAYER_ARRAY_SIZE {
            let cells = self.player_owned_cells[p];
            if cells > 0 {
                density[p] = self.player_total_troops[p] / cells as f32;
            }
        }

        for cell in 0..TOTAL_CELLS {
            let packed = self.cell_data[cell];
            let owner = (packed & OWNER_MASK) as usize;

            let terrain_cost = match (packed >> TERRAIN_SHIFT) & 0x000F {
                0 => 1.0f32,  // Plains
                1 => 3.0,     // Highlands
                2 => 6.0,     // Mountains
                _ => 0.0,     // Water (never in candidates anyway)
            };
            // Defense tier stored in bits 11-14; default to 1 until buildings add tiers.
            let def_tier = {
                let raw = ((packed & DEFENSE_MASK) >> DEFENSE_SHIFT) as f32;
                if raw < 1.0 { 1.0 } else { raw }
            };
            // Neutral cells have no troop density; owned cells add the player's density.
            let player_density = if owner >= 1 && owner < PLAYER_ARRAY_SIZE {
                density[owner]
            } else {
                0.0
            };

            let difficulty = ((player_density + terrain_cost) * def_tier).min(DIFFICULTY_CAP);
            self.difficulty_to_invade[cell] = difficulty as u32;
        }
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

                // Gold income scales with territory: each owned cell yields
                // GOLD_PER_CELL_PER_SEC, divided by the tick rate so the per-second
                // rate is identical regardless of how fast the sim ticks.
                // Each completed Gold Mine grants a +10% bonus.
                let mut mine_count = 0.0;
                for b in 0..self.defense_buildings.len() {
                    if self.building_type[b] == BTYPE_MINE 
                        && self.building_owner[b] as usize == i 
                        && self.defense_build_complete[b] == 0 
                    {
                        mine_count += 1.0;
                    }
                }
                
                let base_income = (cells as f32 * GOLD_PER_CELL_PER_SEC) / tick_hz;
                self.player_gold[i] += base_income * (1.0 + mine_count * 0.10);

                // Each completed City building grants +CITY_POP_BONUS to max pop.
                let mut city_count = 0.0_f32;
                for b in 0..self.defense_buildings.len() {
                    if self.building_type[b] == BTYPE_CITY
                        && self.building_owner[b] as usize == i
                        && self.defense_build_complete[b] == 0
                    {
                        city_count += 1.0;
                    }
                }

                // Max population scales purely with territory (no flat base).
                // The exported cap stays linear (cells × POP_CAP_PER_CELL) so the
                // client's cell-count derivation (maxPop / POP_CAP_PER_CELL) is exact.
                let max_cap = (cells * POP_CAP_PER_CELL).max(1);
                self.player_max_population_cap[i] = max_cap;
                // Effective cap applies city bonus; used for growth and home-cap only.
                let effective_cap_f = max_cap as f32 * (1.0 + city_count * CITY_POP_BONUS);

                // Total troops in the system = home reserves + deployed on fronts.
                // Growth rate is a function of TOTAL fill so deploying troops never
                // grants a free refill while the front runs.
                let troops = self.player_total_troops[i];
                let attack = self.player_attack_pool[i];
                let total  = troops + attack;
                let p = (total / effective_cap_f).clamp(0.0, 1.0);

                // Growth curve (troops/sec): peaks at p = 0.40, zero at p = 1.0,
                // positive at p = 0 (the recovery floor). See the consts above.
                let shape = ((1.0 - p) * (p - GROWTH_ROOT2) / GROWTH_SHAPE_PEAK).max(0.0);
                // Anti-snowball: throttle the shaped production by the oversize
                // factor (≤ 1 only past the soft cap). The recovery floor is left
                // unscaled so a near-dead faction always claws back, but for a huge
                // empire MIN_GROWTH is negligible against its size.
                let base_growth = effective_cap_f * PEAK_GROWTH_FRACTION * shape;
                let growth_per_sec =
                    (base_growth * self.oversize_growth_scale(cells)).max(MIN_GROWTH_PER_SEC);

                let new_troops = troops + growth_per_sec / tick_hz;
                // Cap home reserves so that home + attacking never exceeds effective cap.
                let home_cap = (effective_cap_f - attack).max(0.0);
                self.player_total_troops[i] = new_troops.min(home_cap);
            }
        }
    }

    /// Anti-snowball production multiplier (≤ 1.0) for an empire of `cells` cells.
    /// 1.0 up to the soft cap; beyond it, the excess territory only counts
    /// GROWTH_OVERSIZE_FACTOR toward production, so the scale = effective/actual
    /// shrinks as the empire grows — flattening a runaway leader's troops/sec.
    fn oversize_growth_scale(&self, cells: u32) -> f32 {
        let soft = self.growth_soft_cap;
        if soft == 0 || cells <= soft { return 1.0; }
        let effective = soft as f32 + (cells - soft) as f32 * GROWTH_OVERSIZE_FACTOR;
        effective / cells as f32
    }

    /// How many of a cell's 8 neighbors are owned by faction `f` (0..8).
    /// Higher = more enclosed by our territory; used to fill concavities first.
    #[inline]
    fn owned_neighbor_count(&self, cell: usize, f: usize) -> u8 {
        let mut count = 0u8;
        for i in 0..8 {
            let nb = Self::get_neighbor(cell, i);
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
        // (each has a front aimed at the other), the troops committed to those
        // two fronts cancel 1-for-1 this tick — destroyed on both sides. 20k vs
        // 20k wipes both fronts; 20k vs 10k leaves the attacker with 10k still
        // pressing. Each unordered pair is handled once (a < b). Only the two
        // mutually-aimed fronts interact; each side's other fronts are untouched.
        for a in 1..PLAYER_ARRAY_SIZE {
            for b in (a + 1)..PLAYER_ARRAY_SIZE {
                let fa = a * PLAYER_ARRAY_SIZE + b; // a's front against b
                let fb = b * PLAYER_ARRAY_SIZE + a; // b's front against a
                let pa = self.front_pool[fa];
                let pb = self.front_pool[fb];
                if pa <= FRONT_EPS || pb <= FRONT_EPS { continue; }
                // Mutually destroyed — NOT refunded to either side's reserves.
                let cancel = pa.min(pb);
                self.front_pool[fa] = pa - cancel;
                self.front_pool[fb] = pb - cancel;
            }
        }

        // Cheap per-faction gate for the grid pass below: does this faction have
        // ANY active front? Computed once here (after annihilation, so a front
        // zeroed above doesn't slip through), instead of summing 21 entries per
        // owned cell inside the 2M-cell loop.
        let mut any_front = [false; PLAYER_ARRAY_SIZE];
        for f in 1..PLAYER_ARRAY_SIZE {
            any_front[f] = self.has_active_front(f);
        }

        // Candidates = the conquerable cells (non-owned, non-water) directly
        // bordering each expanding faction's territory — i.e. the very next shell
        // of neighbors. We conquer a randomized subset of this shell each tick so
        // the whole border advances together in all directions (an organic blob).
        // Indexed per FRONT: `candidates[attacker * PLAYER_ARRAY_SIZE + target]`,
        // so an owned cell bordering both neutral land and an attacked enemy feeds
        // each of that faction's active fronts independently.
        let mut candidates: Vec<Vec<usize>> = vec![Vec::new(); PLAYER_ARRAY_SIZE * PLAYER_ARRAY_SIZE];

        for cell_id in 0..TOTAL_CELLS {
            let owner = self.cell_owner(cell_id) as usize;
            if owner == 0 || !any_front[owner] { continue; }

            let owner_base = owner * PLAYER_ARRAY_SIZE;
            for i in 0..8 {
                let n = Self::get_neighbor(cell_id, i);
                if n != -1 {
                    let n_idx = n as usize;
                    let n_owner = self.cell_owner(n_idx) as usize;
                    if n_owner == owner { continue; }
                    // A neighbor is conquerable only if we have an active front
                    // aimed at its owner (target 0 = neutral, target X = enemy X).
                    // Other players' cells without a matching front stay a hard
                    // boundary, so expansion never bleeds where we didn't commit.
                    if self.front_pool[owner_base + n_owner] > FRONT_EPS
                        && self.cell_terrain(n_idx) != 3
                    {
                        // May be pushed by several owned neighbors; dupes are
                        // harmless (collapsed below).
                        candidates[owner_base + n_owner].push(n_idx);
                    }
                }
            }
        }

        // Resolve each active front independently. Each front spends only its own
        // committed troops, so a faction attacking several enemies + neutral land
        // advances on all of them at once.
        for f in 1..PLAYER_ARRAY_SIZE {
            if !any_front[f] { continue; }

            for t in 0..PLAYER_ARRAY_SIZE {
                if t == f { continue; }
                let fi = f * PLAYER_ARRAY_SIZE + t;
                if self.front_pool[fi] <= FRONT_EPS { continue; }

                // Take ownership of this front's candidate list so the conquest
                // loop can freely borrow &mut self.
                let mut cells = std::mem::take(&mut candidates[fi]);

                // Nothing legal to conquer (walled in by water / non-targeted
                // players, or the target was just eliminated): refund and close.
                if cells.is_empty() {
                    self.player_total_troops[f] += self.front_pool[fi];
                    self.front_pool[fi] = 0.0;
                    continue;
                }

                // A cell can border several of our cells, so collapse duplicates.
                cells.sort_unstable();
                cells.dedup();

                // Score each border cell by how enclosed it already is by our
                // territory (its owned-neighbor count). We conquer the MOST enclosed
                // cells first so concavities — and any cell that would otherwise be
                // surrounded — are filled before the frontier pushes outward. This
                // guarantees no enclosed/un-owned pockets are ever left behind, while
                // a random tiebreak keeps same-enclosure growth radial in all dirs.
                let mut scored: Vec<(u8, u32, usize)> = Vec::with_capacity(cells.len());
                for &c in cells.iter() {
                    let enclosure = self.owned_neighbor_count(c, f);
                    let tiebreak = self.next_rand();
                    scored.push((enclosure, tiebreak, c));
                }
                // Most enclosed first; random order within the same enclosure level.
                scored.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));

                // Expansion speed is proportional to THIS front's committed troops,
                // clamped so it stays organic. Per-front, so a faction with several
                // fronts pushes each at its own rate.
                let max_conquers = ((self.front_pool[fi] * EXPANSION_CELLS_PER_TROOP) as usize)
                    .clamp(MIN_CONQUERS_PER_TICK, MAX_CONQUERS_PER_TICK);
                let mut conquers = 0;

                for &(_, _, n_idx) in scored.iter() {
                    if conquers >= max_conquers { break; }
                    if self.front_pool[fi] <= 0.0 { break; }

                    let n_owner = self.cell_owner(n_idx) as usize;
                    // Owner may have changed since gathering (a cell conquered by an
                    // earlier front this tick); only the front's target type counts.
                    if n_owner == f || n_owner != t { continue; }

                    // What the ATTACKER pays to take this cell. Neutral land is a
                    // flat, cheap cost regardless of terrain so the open map fills
                    // quickly. Owned cells use the terrain-weighted
                    // difficulty_to_invade = (density + terrain_cost) * defense_tier,
                    // computed each second by update_cell_difficulties() and reset to 0
                    // on conquest so freshly taken cells are cheap to re-contest. A
                    // fortified (high defense_tier) cell is genuinely expensive for the
                    // attacker — that is the whole point of building defenses.
                    let total_cost = if n_owner == 0 {
                        NEUTRAL_INVADE_COST
                    } else {
                        self.difficulty_to_invade[n_idx] as f32
                    };

                    if self.front_pool[fi] >= total_cost {
                        self.front_pool[fi] -= total_cost;

                        let nr = (n_idx / MAP_WIDTH) as f32;
                        let nc = (n_idx % MAP_WIDTH) as f32;

                        if n_owner != 0 {
                            // The defender loses ONLY their troops-per-cell density —
                            // the standing garrison that was holding this one cell.
                            // Defense tier and terrain make the cell costly for the
                            // ATTACKER (total_cost above) but must NOT inflate the
                            // defender's loss, otherwise breaching a fortified cell
                            // would drain far more troops than were ever stationed
                            // there. Computed live so the ratio stays constant as cells
                            // fall: an evenly-garrisoned empire reaches 0 troops exactly
                            // when it reaches 0 cells, never before.
                            let def_cells = self.player_owned_cells[n_owner].max(1) as f32;
                            let density = self.player_total_troops[n_owner] / def_cells;
                            self.player_total_troops[n_owner] -= density;
                            self.player_kill_count[f] += density;
                            if self.player_total_troops[n_owner] < 0.0 {
                                self.player_total_troops[n_owner] = 0.0;
                            }
                            self.player_owned_cells[n_owner] = self.player_owned_cells[n_owner].saturating_sub(1);
                            // Cell leaves the previous owner's territory centroid.
                            self.player_row_sum[n_owner] -= nr;
                            self.player_col_sum[n_owner] -= nc;
                        }

                        // If the conquered cell holds a building: a DEFENSE tower is
                        // destroyed the moment any footprint cell falls; a SILO is
                        // tougher — it survives partial conquest and only changes
                        // hands once a single enemy owns all 64 footprint cells
                        // (checked by try_transfer_silo after this cell flips).
                        let mut silo_to_check: Option<usize> = None;
                        if self.cell_data[n_idx] & BUILDING_MASK != 0 {
                            if let Some(bidx) = self.find_building_for_cell(n_idx) {
                                if self.building_type[bidx] == BTYPE_DEFENSE {
                                    self.destroy_building(bidx);
                                } else {
                                    silo_to_check = Some(bidx);
                                }
                            }
                        }

                        self.set_cell_owner(n_idx, f as u32);
                        self.last_modified_tick[n_idx] = self.current_tick;
                        // Freshly taken cell has no fortification yet; enclosure for the
                        // new owner builds up within one second via update_cell_difficulties.
                        self.difficulty_to_invade[n_idx] = 0;
                        // Fortification follows ownership: a cell taken inside one of
                        // our own building radii inherits tier 10, so a fort built near
                        // the border keeps protecting territory we expand into later.
                        // Otherwise clear any tier inherited from the former owner
                        // (e.g. an enemy's fort zone), so tier 10 always means "owned
                        // by the builder and inside a live building radius".
                        let tier = if self.cell_in_own_building_radius(n_idx, f) { 10 } else { 0 };
                        self.set_cell_defense(n_idx, tier);
                        self.player_owned_cells[f] += 1;
                        self.player_row_sum[f] += nr;
                        self.player_col_sum[f] += nc;
                        conquers += 1;

                        // bidx is still valid here: silos are never destroyed above,
                        // so the building list (and indices) didn't shift this cell.
                        if let Some(bidx) = silo_to_check {
                            self.try_transfer_silo(bidx, f as u32);
                        }
                    }
                }

                // End-of-front condition: a nearly-spent front returns its scraps
                // to the reserve and closes, so it stops being gathered next tick.
                if self.front_pool[fi] < 1.0 {
                    self.player_total_troops[f] += self.front_pool[fi];
                    self.front_pool[fi] = 0.0;
                }
            }
        }

        // Refresh the per-player aggregate (sum of all fronts) for the HUD export.
        for f in 1..PLAYER_ARRAY_SIZE {
            let base = f * PLAYER_ARRAY_SIZE;
            let mut sum = 0.0;
            for t in 0..PLAYER_ARRAY_SIZE {
                sum += self.front_pool[base + t];
            }
            self.player_attack_pool[f] = sum;
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
    pub fn get_player_gold_ptr(&self) -> *const f32 { self.player_gold.as_ptr() }

    #[wasm_bindgen]
    pub fn get_player_kill_count_ptr(&self) -> *const f32 { self.player_kill_count.as_ptr() }

    #[wasm_bindgen]
    pub fn get_player_gold_spent_ptr(&self) -> *const f32 { self.player_gold_spent.as_ptr() }

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
        self.dirty_cells.sort_unstable();
        self.dirty_cells.dedup();

        let mut count: usize = 0;
        let cap = self.delta_scratch.len() / 2;
        
        for &cell_idx in &self.dirty_cells {
            if count >= cap { break; }
            let cell_id = cell_idx as usize;
            
            if self.last_modified_tick[cell_id] >= since_tick {
                let owner = self.cell_owner(cell_id);
                self.delta_scratch[count * 2] = cell_idx;
                self.delta_scratch[count * 2 + 1] = owner;
                count += 1;
            }
        }
        
        self.dirty_cells.clear();
        count as u32
    }

    #[wasm_bindgen]
    pub fn get_delta_scratch_ptr(&self) -> *const u32 { self.delta_scratch.as_ptr() }

    /// Place a defense building centered at (center_row, center_col).
    ///
    /// Validates that the entire 8×8 footprint is owned by faction_id and free
    /// of existing buildings, then:
    ///   - sets the BUILDING_MASK bit on every footprint cell (has_building=1)
    ///   - charges DEFENSE_BUILDING_COST gold and registers the building with a
    ///     completion tick DEFENSE_BUILD_SECONDS in the future
    ///
    /// The tower is "under construction" until then: it occupies its footprint and
    /// can be destroyed, but grants NO defense bonus. process_construction() stamps
    /// defense_tier=10 across the radius on completion. The defense tier then
    /// persists through conquest so client/server tier bits stay in sync after the
    /// one-time `building-completed` broadcast.
    ///
    /// Returns true on success, false if the placement is invalid.
    #[wasm_bindgen]
    pub fn place_defense_building(&mut self, faction_id: u32, center_row: i32, center_col: i32) -> bool {
        self.place_building_internal(faction_id, center_row, center_col, BTYPE_DEFENSE, DEFENSE_BUILDING_COST, DEFENSE_BUILD_SECONDS)
    }

    /// Place a missile silo (key '4'). Same footprint rules and construction
    /// mechanic as a defense tower, but costs more, takes longer, and grants no
    /// fortification. Once complete it can fire missiles at targets within
    /// SILO_RANGE (see fire_missile).
    #[wasm_bindgen]
    pub fn place_silo(&mut self, faction_id: u32, center_row: i32, center_col: i32) -> bool {
        self.place_building_internal(faction_id, center_row, center_col, BTYPE_SILO, SILO_BUILDING_COST, SILO_BUILD_SECONDS)
    }

    #[wasm_bindgen]
    pub fn place_mine(&mut self, faction_id: u32, center_row: i32, center_col: i32) -> bool {
        self.place_building_internal(faction_id, center_row, center_col, BTYPE_MINE, MINE_BUILDING_COST, MINE_BUILD_SECONDS)
    }

    #[wasm_bindgen]
    pub fn place_antiair(&mut self, faction_id: u32, center_row: i32, center_col: i32) -> bool {
        self.place_building_internal(faction_id, center_row, center_col, BTYPE_ANTIAIR, ANTIAIR_BUILDING_COST, ANTIAIR_BUILD_SECONDS)
    }

    #[wasm_bindgen]
    pub fn place_city(&mut self, faction_id: u32, center_row: i32, center_col: i32) -> bool {
        self.place_building_internal(faction_id, center_row, center_col, BTYPE_CITY, CITY_BUILDING_COST, CITY_BUILD_SECONDS)
    }

    /// Shared placement logic for every building type. Validates the 8×8 footprint
    /// (fully owned, clear of existing buildings) and affordability, stamps the
    /// BUILDING_MASK footprint, charges gold, and registers the building with its
    /// type + completion tick — keeping defense_buildings / defense_build_complete /
    /// building_type index-aligned (see the field INVARIANTs). The defense bonus
    /// (if any) is applied later by process_construction, never here.
    fn place_building_internal(&mut self, faction_id: u32, center_row: i32, center_col: i32, btype: u8, cost: f32, build_seconds: f32) -> bool {
        let f = faction_id as usize;
        if f == 0 || f >= PLAYER_ARRAY_SIZE || self.player_is_alive[f] == 0 { return false; }

        // Must be able to afford it. Gold is charged only on a fully successful
        // placement (below), so a failed validation never costs anything.
        if self.player_gold[f] < cost { return false; }

        // Validate the 8×8 footprint (center ± 4 in each axis).
        let half: i32 = 4;
        for dr in -half..half {
            for dc in -half..half {
                let r = center_row + dr;
                let c = center_col + dc;
                if r < 0 || r >= MAP_HEIGHT as i32 || c < 0 || c >= MAP_WIDTH as i32 { return false; }
                let cell = r as usize * MAP_WIDTH + c as usize;
                if self.cell_owner(cell) as usize != f { return false; }
                if self.cell_data[cell] & BUILDING_MASK != 0 { return false; }
            }
        }

        // Stamp the 8×8 footprint with the has_building flag.
        for dr in -half..half {
            for dc in -half..half {
                let cell = (center_row + dr) as usize * MAP_WIDTH + (center_col + dc) as usize;
                self.cell_data[cell] |= BUILDING_MASK;
                self.last_modified_tick[cell] = self.current_tick;
            }
        }

        // NOTE: defense_tier is NOT stamped here — the building is "under
        // construction" and grants no bonus yet. process_construction() applies the
        // type-specific effect once build_seconds have elapsed.

        // Charge the builder now that the placement has fully succeeded.
        self.player_gold[f] -= cost;
        self.player_gold_spent[f] += cost;

        // Register this building so conquest can look it up, with its type and
        // completion tick (all three vecs kept index-aligned — see the INVARIANTs).
        let center = (center_row as usize * MAP_WIDTH + center_col as usize) as u32;
        let build_ticks = (build_seconds * self.tick_hz.max(1) as f32) as u32;
        self.defense_buildings.push(center);
        self.defense_build_complete.push(self.current_tick + build_ticks.max(1));
        self.building_type.push(btype);
        self.building_owner.push(faction_id);
        
        let charges = if btype == BTYPE_ANTIAIR { ANTIAIR_MAX_CHARGES } else { 0 };
        self.building_charges.push(charges);
        self.building_cooldown.push(0);

        // Bot builds are broadcast by the server polling placed_buildings_buf
        // each tick; human builds are broadcast directly from handleInput. The
        // type MUST travel too, or a bot silo is mislabeled as a defense tower on
        // the client (wrong icon + a phantom defense aura).
        if self.player_is_bot[f] == 1 {
            self.placed_buildings_buf.push(center);
            self.placed_buildings_buf.push(faction_id);
            self.placed_buildings_buf.push(btype as u32);
        }
        true
    }

    /// Fire a missile from one of faction `f`'s completed silos at (target_row,
    /// target_col). Razes every cell within MISSILE_BLAST_RADIUS to neutral:
    /// troops lost at the same per-cell density as conquest, buildings destroyed,
    /// owners set to 0 (nature) — collateral hits the firer's own cells too, while
    /// nature cells are a no-op.
    ///
    /// Returns a status code (so the caller knows whether to surface a message):
    ///   0 = fired
    ///   1 = rejected, SHOW a message (can't afford, or no silo in range)
    ///   2 = rejected, SILENT (invalid target: out of bounds, own cell, or nature —
    ///       a missile must always be aimed at an enemy cell, with no message)
    #[wasm_bindgen]
    pub fn fire_missile(&mut self, faction_id: u32, target_row: i32, target_col: i32) -> i32 {
        let f = faction_id as usize;
        if f == 0 || f >= PLAYER_ARRAY_SIZE || self.player_is_alive[f] == 0 { return 2; }
        if target_row < 0 || target_row >= MAP_HEIGHT as i32 || target_col < 0 || target_col >= MAP_WIDTH as i32 { return 2; }

        // Target must be an ENEMY cell: never the firer's own land, never nature.
        // This is the silent "no friendly fire / always damage another player" rule.
        let target_cell = target_row as usize * MAP_WIDTH + target_col as usize;
        let target_owner = self.cell_owner(target_cell) as usize;
        if target_owner == 0 || target_owner == f { return 2; }

        if self.player_gold[f] < MISSILE_COST { return 1; }

        let mut source_center = 0;
        let mut source_index = 0;
        let mut in_range = false;
        for i in 0..self.defense_buildings.len() {
            if self.building_type[i] != BTYPE_SILO { continue; }
            if self.defense_build_complete[i] > self.current_tick { continue; } // still building
            if self.building_owner[i] as usize != f { continue; }
            if self.building_cooldown[i] > self.current_tick { continue; } // silo is on cooldown!

            let center = self.defense_buildings[i];
            let cr = (center / MAP_WIDTH as u32) as i32;
            let cc = (center % MAP_WIDTH as u32) as i32;
            let dr = target_row - cr;
            let dc = target_col - cc;
            if dr * dr + dc * dc <= SILO_RANGE * SILO_RANGE { 
                in_range = true; 
                source_center = center;
                source_index = i;
                break; 
            }
        }
        if !in_range { return 1; }

        self.building_cooldown[source_index] = self.current_tick + (2.0 * self.tick_hz as f32).ceil() as u32;

        self.player_gold[f] -= MISSILE_COST;
        self.player_gold_spent[f] += MISSILE_COST;

        // Calculate physical distance to determine flight time in ticks
        let source_row = (source_center / MAP_WIDTH as u32) as u32;
        let source_col = (source_center % MAP_WIDTH as u32) as u32;
        let dr_f = target_row as f32 - source_row as f32;
        let dc_f = target_col as f32 - source_col as f32;
        let dist = (dr_f * dr_f + dc_f * dc_f).sqrt();
        let flight_time_sec = dist / 40.0; // 40 cells/sec matches frontend
        let remaining_ticks = (flight_time_sec * self.tick_hz as f32).ceil() as u32;

        self.inflight_missiles.push(source_row);
        self.inflight_missiles.push(source_col);
        self.inflight_missiles.push(target_row as u32);
        self.inflight_missiles.push(target_col as u32);
        self.inflight_missiles.push(faction_id);
        self.inflight_missiles.push(remaining_ticks);
        self.inflight_missiles.push(remaining_ticks); // total_ticks

        self.fired_missiles_buf.push(source_row);
        self.fired_missiles_buf.push(source_col);
        self.fired_missiles_buf.push(target_row as u32);
        self.fired_missiles_buf.push(target_col as u32);
        self.fired_missiles_buf.push(faction_id);

        0
    }

    fn process_inflight_missiles(&mut self) {
        let mut i = 0;
        while i < self.inflight_missiles.len() {
            let ticks = self.inflight_missiles[i + 5];
            let source_row = self.inflight_missiles[i];
            let source_col = self.inflight_missiles[i + 1];
            let target_row = self.inflight_missiles[i + 2] as i32;
            let target_col = self.inflight_missiles[i + 3] as i32;
            let faction_id = self.inflight_missiles[i + 4];
            let total_ticks = self.inflight_missiles[i + 6] as f32;

            let t = 1.0 - (ticks as f32 / total_ticks);
            let curr_r = source_row as f32 + (target_row as f32 - source_row as f32) * t;
            let curr_c = source_col as f32 + (target_col as f32 - source_col as f32) * t;
            
            let mut intercepted = false;
            
            // Continuous Airspace Scan (only intercept mid-air, t between 0.15 and 0.85)
            if t >= 0.15 && t <= 0.85 {
                let target_idx = (target_row as usize) * MAP_WIDTH + (target_col as usize);
                let target_owner = self.cell_owner(target_idx) as u32;

                for b in 0..self.defense_buildings.len() {
                    if self.building_type[b] != BTYPE_ANTIAIR { continue; }
                    if self.defense_build_complete[b] > self.current_tick { continue; } // under construction
                    let b_owner = self.building_owner[b] as u32;
                    if b_owner == 0 || b_owner == faction_id { continue; } // ignore own or unowned
                    
                    // Only intercept if the missile is targeting this AA battery's faction's territory
                    if b_owner != target_owner { continue; }
                    
                    if self.building_charges[b] == 0 { continue; }
                    
                    let center = self.defense_buildings[b];
                    let cr = (center / MAP_WIDTH as u32) as i32;
                    let cc = (center % MAP_WIDTH as u32) as i32;
                    let dr = curr_r - cr as f32;
                    let dc = curr_c - cc as f32;
                    
                    if dr * dr + dc * dc <= (ANTIAIR_RADIUS * ANTIAIR_RADIUS) as f32 {
                        intercepted = true;
                        self.building_charges[b] -= 1;
                        
                        self.intercepted_missiles_buf.push(source_row);
                        self.intercepted_missiles_buf.push(source_col);
                        self.intercepted_missiles_buf.push(target_row as u32);
                        self.intercepted_missiles_buf.push(target_col as u32);
                        self.intercepted_missiles_buf.push(cr as u32);
                        self.intercepted_missiles_buf.push(cc as u32);
                        self.intercepted_missiles_buf.push(curr_r.round() as u32);
                        self.intercepted_missiles_buf.push(curr_c.round() as u32);
                        
                        if self.building_charges[b] == 0 {
                            self.destroy_building(b);
                        }
                        break;
                    }
                }
            }

            if intercepted {
                // Remove missile (7 elements)
                let last_idx = self.inflight_missiles.len() - 7;
                if i != last_idx {
                    for j in 0..7 {
                        self.inflight_missiles[i + j] = self.inflight_missiles[last_idx + j];
                    }
                }
                for _ in 0..7 {
                    self.inflight_missiles.pop();
                }
                continue; // do not increment i
            }

            if ticks <= 1 {
                self.detonate_missile(target_row, target_col, faction_id);
                
                // Remove missile (7 elements)
                let last_idx = self.inflight_missiles.len() - 7;
                if i != last_idx {
                    for j in 0..7 {
                        self.inflight_missiles[i + j] = self.inflight_missiles[last_idx + j];
                    }
                }
                for _ in 0..7 {
                    self.inflight_missiles.pop();
                }
            } else {
                self.inflight_missiles[i + 5] -= 1;
                i += 7;
            }
        }
    }

    fn detonate_missile(&mut self, target_row: i32, target_col: i32, faction_id: u32) {
        let radius = MISSILE_BLAST_RADIUS;
        let r_min = (target_row - radius).max(0) as usize;
        let r_max = (target_row + radius).min(MAP_HEIGHT as i32 - 1) as usize;
        let c_min = (target_col - radius).max(0) as usize;
        let c_max = (target_col + radius).min(MAP_WIDTH as i32 - 1) as usize;
        for r in r_min..=r_max {
            for c in c_min..=c_max {
                let dr = r as i32 - target_row;
                let dc = c as i32 - target_col;
                if dr * dr + dc * dc > radius * radius { continue; }
                let cell = r * MAP_WIDTH + c;
                let owner = self.cell_owner(cell) as usize;
                if owner != 0 {
                    // Defender loses live density per cell, identical to conquest.
                    let def_cells = self.player_owned_cells[owner].max(1) as f32;
                    let density = self.player_total_troops[owner] / def_cells;
                    self.player_total_troops[owner] -= density;
                    if faction_id < PLAYER_ARRAY_SIZE as u32 {
                        self.player_kill_count[faction_id as usize] += density;
                    }
                    if self.player_total_troops[owner] < 0.0 { self.player_total_troops[owner] = 0.0; }
                    self.player_owned_cells[owner] = self.player_owned_cells[owner].saturating_sub(1);
                    self.player_row_sum[owner] -= r as f32;
                    self.player_col_sum[owner] -= c as f32;
                }
                // Destroy any building whose footprint this cell belongs to. The
                // first footprint cell hit clears BUILDING_MASK on all 64, so later
                // cells of the same building skip this (re-scan via find_building).
                if self.cell_data[cell] & BUILDING_MASK != 0 {
                    if let Some(bidx) = self.find_building_for_cell(cell) {
                        self.destroy_building(bidx);
                    }
                }
                self.set_cell_owner(cell, 0);
                self.set_cell_defense(cell, 0);
                self.last_modified_tick[cell] = self.current_tick;
            }
        }
    }

    /// Complete any building whose construction time has elapsed: stamp tier 10
    /// across its radius on the builder's own cells, mark it active
    /// (defense_build_complete = 0), and record (center, faction) in
    /// completed_buildings_buf for the server to broadcast as `building-completed`.
    /// Indexing by `i` is safe because defense_build_complete stays length-aligned
    /// with defense_buildings (see the field INVARIANT).
    fn process_construction(&mut self) {
        let radius: i32 = BUILDING_RADIUS;
        for i in 0..self.defense_buildings.len() {
            let complete = self.defense_build_complete[i];
            // 0 = already active; > current_tick = still building.
            if complete == 0 || complete > self.current_tick { continue; }

            let center = self.defense_buildings[i];
            let btype = self.building_type[i];
            // Use the tracked owner, not cell_owner(center): a silo whose center was
            // conquered (but not its whole footprint) still belongs to the builder,
            // so building-completed must name the right faction for the client lookup.
            let f = self.building_owner[i] as usize;
            // Defense towers fortify their radius on completion; silos grant no
            // zone (their only effect is enabling fire_missile).
            if btype == BTYPE_DEFENSE {
                let cr = (center / MAP_WIDTH as u32) as i32;
                let cc = (center % MAP_WIDTH as u32) as i32;
                let r_min = (cr - radius).max(0) as usize;
                let r_max = (cr + radius).min(MAP_HEIGHT as i32 - 1) as usize;
                let c_min = (cc - radius).max(0) as usize;
                let c_max = (cc + radius).min(MAP_WIDTH as i32 - 1) as usize;
                for r in r_min..=r_max {
                    for c in c_min..=c_max {
                        let dr = r as i32 - cr;
                        let dc = c as i32 - cc;
                        if dr * dr + dc * dc <= radius * radius {
                            let cell = r * MAP_WIDTH + c;
                            // Only fortify the builder's own cells (set_cell_defense
                            // does not touch the owner-delta dirty list, so tier never
                            // leaks into the snapshot wire format).
                            if self.cell_owner(cell) as usize == f {
                                self.set_cell_defense(cell, 10);
                            }
                        }
                    }
                }
            }
            self.defense_build_complete[i] = 0;
            // (center, faction, type) triplet — the server broadcasts building-completed.
            self.completed_buildings_buf.push(center);
            self.completed_buildings_buf.push(f as u32);
            self.completed_buildings_buf.push(btype as u32);
        }
    }

    /// True if `cell_idx` lies within the BUILDING_RADIUS influence zone of one of
    /// faction `f`'s own *completed* defense buildings. A live building's center
    /// always belongs to its builder (conquering any footprint cell destroys it),
    /// so the center cell's owner identifies the building's faction. Buildings
    /// still under construction are skipped — they grant no bonus to expansion.
    fn cell_in_own_building_radius(&self, cell_idx: usize, f: usize) -> bool {
        if self.defense_buildings.is_empty() { return false; }
        let radius: i32 = BUILDING_RADIUS;
        let row = (cell_idx / MAP_WIDTH) as i32;
        let col = (cell_idx % MAP_WIDTH) as i32;
        for (i, &center) in self.defense_buildings.iter().enumerate() {
            if self.building_type[i] != BTYPE_DEFENSE { continue; } // silos grant no zone
            if self.defense_build_complete[i] > self.current_tick { continue; }
            if self.building_owner[i] as usize != f { continue; }
            let cr = (center / MAP_WIDTH as u32) as i32;
            let cc = (center % MAP_WIDTH as u32) as i32;
            let dr = row - cr;
            let dc = col - cc;
            if dr * dr + dc * dc <= radius * radius {
                return true;
            }
        }
        false
    }

    /// Returns the index of the building whose 8×8 footprint contains `cell_idx`,
    /// or None if the cell belongs to no building.
    fn find_building_for_cell(&self, cell_idx: usize) -> Option<usize> {
        let row = (cell_idx / MAP_WIDTH) as i32;
        let col = (cell_idx % MAP_WIDTH) as i32;
        for (i, &center) in self.defense_buildings.iter().enumerate() {
            let cr = (center / MAP_WIDTH as u32) as i32;
            let cc = (center % MAP_WIDTH as u32) as i32;
            let dr = row - cr;
            let dc = col - cc;
            if dr >= -4 && dr < 4 && dc >= -4 && dc < 4 {
                return Some(i);
            }
        }
        None
    }

    /// Hand the silo at index `idx` to faction `f` IF `f` now owns every one of its
    /// 64 footprint cells (the "must conquer all 8×8" rule). No-op if `f` already
    /// owns it or doesn't yet hold the full footprint. On transfer it records
    /// (center, f) in transferred_buildings_buf for the server to broadcast.
    fn try_transfer_silo(&mut self, idx: usize, f: u32) {
        if self.building_owner[idx] == f { return; }
        let center = self.defense_buildings[idx];
        let cr = (center / MAP_WIDTH as u32) as i32;
        let cc = (center % MAP_WIDTH as u32) as i32;
        // Footprint is center ± 4 (half-open, exactly the 64 cells) and was
        // validated in-bounds at placement, so no bounds check is needed here.
        for dr in -4i32..4 {
            for dc in -4i32..4 {
                let cell = (cr + dr) as usize * MAP_WIDTH + (cc + dc) as usize;
                if self.cell_owner(cell) != f { return; }
            }
        }
        self.building_owner[idx] = f;
        self.transferred_buildings_buf.push(center);
        self.transferred_buildings_buf.push(f);
    }

    /// Destroys the building at index `idx`: clears BUILDING_MASK on its 8×8
    /// footprint, resets defense_tier to 0 in its influence zone, records the
    /// destruction in `destroyed_buildings_buf` for the server to broadcast.
    fn destroy_building(&mut self, idx: usize) {
        let center = self.defense_buildings[idx];
        let cr = (center / MAP_WIDTH as u32) as i32;
        let cc = (center % MAP_WIDTH as u32) as i32;

        // Clear has_building flag on 8×8 footprint.
        for dr in -4i32..4 {
            for dc in -4i32..4 {
                let r = cr + dr;
                let c = cc + dc;
                if r >= 0 && r < MAP_HEIGHT as i32 && c >= 0 && c < MAP_WIDTH as i32 {
                    let cell = r as usize * MAP_WIDTH + c as usize;
                    self.cell_data[cell] &= !BUILDING_MASK;
                    self.last_modified_tick[cell] = self.current_tick;
                }
            }
        }

        // Reset defense tier to 0 in the influence zone.
        let radius: i32 = BUILDING_RADIUS;
        let r_min = (cr - radius).max(0) as usize;
        let r_max = (cr + radius).min(MAP_HEIGHT as i32 - 1) as usize;
        let c_min = (cc - radius).max(0) as usize;
        let c_max = (cc + radius).min(MAP_WIDTH as i32 - 1) as usize;

        for r in r_min..=r_max {
            for c in c_min..=c_max {
                let dr = r as i32 - cr;
                let dc = c as i32 - cc;
                if dr * dr + dc * dc <= radius * radius {
                    let cell = r * MAP_WIDTH + c;
                    self.set_cell_defense(cell, 0);
                    self.last_modified_tick[cell] = self.current_tick;
                }
            }
        }

        self.destroyed_buildings_buf.push(center);
        // Keep the parallel vecs index-aligned (see INVARIANT). This also cancels
        // construction for free if the building was still being built — the client
        // removes its icon + progress bar on building-destroyed.
        self.defense_buildings.swap_remove(idx);
        self.defense_build_complete.swap_remove(idx);
        self.building_type.swap_remove(idx);
        self.building_owner.swap_remove(idx);
        self.building_charges.swap_remove(idx);
        self.building_cooldown.swap_remove(idx);
    }

    #[wasm_bindgen]
    pub fn get_destroyed_buildings_count(&self) -> u32 {
        self.destroyed_buildings_buf.len() as u32
    }

    #[wasm_bindgen]
    pub fn get_destroyed_buildings_ptr(&self) -> *const u32 {
        self.destroyed_buildings_buf.as_ptr()
    }

    #[wasm_bindgen]
    pub fn clear_destroyed_buildings(&mut self) {
        self.destroyed_buildings_buf.clear();
    }

    /// Number of (center, faction_id, type) triplets in the just-completed buffer.
    #[wasm_bindgen]
    pub fn get_completed_buildings_count(&self) -> u32 {
        (self.completed_buildings_buf.len() / 3) as u32
    }

    #[wasm_bindgen]
    pub fn get_completed_buildings_ptr(&self) -> *const u32 {
        self.completed_buildings_buf.as_ptr()
    }

    #[wasm_bindgen]
    pub fn clear_completed_buildings(&mut self) {
        self.completed_buildings_buf.clear();
    }

    /// Number of (center, new_owner) pairs in the transferred-silos buffer.
    #[wasm_bindgen]
    pub fn get_transferred_buildings_count(&self) -> u32 {
        (self.transferred_buildings_buf.len() / 2) as u32
    }

    #[wasm_bindgen]
    pub fn get_transferred_buildings_ptr(&self) -> *const u32 {
        self.transferred_buildings_buf.as_ptr()
    }

    #[wasm_bindgen]
    pub fn clear_transferred_buildings(&mut self) {
        self.transferred_buildings_buf.clear();
    }

    /// Number of (center, faction_id, type) triplets in the bot-placed buffer.
    #[wasm_bindgen]
    pub fn get_placed_buildings_count(&self) -> u32 {
        (self.placed_buildings_buf.len() / 3) as u32
    }

    #[wasm_bindgen]
    pub fn get_placed_buildings_ptr(&self) -> *const u32 {
        self.placed_buildings_buf.as_ptr()
    }

    #[wasm_bindgen]
    pub fn clear_placed_buildings(&mut self) {
        self.placed_buildings_buf.clear();
    }

    /// Number of (source_row, source_col, target_row, target_col, faction_id) tuples in the fired missiles buffer.
    #[wasm_bindgen]
    pub fn get_fired_missiles_count(&self) -> u32 {
        (self.fired_missiles_buf.len() / 5) as u32
    }

    #[wasm_bindgen]
    pub fn get_fired_missiles_ptr(&self) -> *const u32 {
        self.fired_missiles_buf.as_ptr()
    }

    #[wasm_bindgen]
    pub fn clear_fired_missiles(&mut self) {
        self.fired_missiles_buf.clear();
    }

    #[wasm_bindgen]
    pub fn get_intercepted_missiles_count(&self) -> u32 {
        (self.intercepted_missiles_buf.len() / 8) as u32
    }

    #[wasm_bindgen]
    pub fn get_intercepted_missiles_ptr(&self) -> *const u32 {
        self.intercepted_missiles_buf.as_ptr()
    }

    #[wasm_bindgen]
    pub fn clear_intercepted_missiles(&mut self) {
        self.intercepted_missiles_buf.clear();
    }

    /// Drive every bot faction one building decision. A bot that can afford a
    /// defense building and holds enough territory attempts to place one near
    /// its territory centroid (interior, most likely fully owned), with a jitter
    /// that scales with territory size so larger empires spread their forts out.
    /// `place_defense_building` validates the footprint and only charges gold on
    /// success, so a miss (jitter landing on a border/unowned cell) is harmless.
    #[wasm_bindgen]
    pub fn bot_build_all(&mut self) {
        for f in 1..PLAYER_ARRAY_SIZE {
            if self.player_is_bot[f] != 1 || self.player_is_alive[f] == 0 { continue; }
            if self.player_gold[f] < DEFENSE_BUILDING_COST { continue; }
            let cells = self.player_owned_cells[f];
            // Need a territory comfortably bigger than an 8×8 footprint.
            if cells < 300 { continue; }

            // Cap buildings per bot (~one per 4000 cells) so a rich bot can't
            // spam towers — both for balance and to keep the per-cell building
            // radius scan in process_war_fronts cheap.
            let mut my_buildings = 0u32;
            for &c in self.defense_buildings.iter() {
                if self.cell_owner(c as usize) as usize == f { my_buildings += 1; }
            }
            if my_buildings >= (cells / 4000).max(1) { continue; }

            let crow = (self.player_row_sum[f] / cells as f32).round() as i32;
            let ccol = (self.player_col_sum[f] / cells as f32).round() as i32;

            // Jitter ~30% of the territory's linear extent around the centroid.
            let jitter = ((cells as f32).sqrt() * 0.3) as i32 + 1;
            let span = (2 * jitter + 1) as u32;
            let jr = (self.next_rand() % span) as i32 - jitter;
            let jc = (self.next_rand() % span) as i32 - jitter;

            let roll = self.next_rand() % 100;
            let tr = crow + jr;
            let tc = ccol + jc;

            // 15% chance to build a silo if they can afford it and enemy in range
            if roll < 15 && self.player_gold[f] >= SILO_BUILDING_COST {
                let mut can_reach_enemy = false;
                let r_min = (tr - SILO_RANGE).max(0);
                let r_max = (tr + SILO_RANGE).min(MAP_HEIGHT as i32 - 1);
                let c_min = (tc - SILO_RANGE).max(0);
                let c_max = (tc + SILO_RANGE).min(MAP_WIDTH as i32 - 1);
                
                for _ in 0..30 {
                    let r_diff = (r_max - r_min + 1) as u32;
                    let c_diff = (c_max - c_min + 1) as u32;
                    if r_diff == 0 || c_diff == 0 { break; }
                    let test_r = r_min + (self.next_rand() % r_diff) as i32;
                    let test_c = c_min + (self.next_rand() % c_diff) as i32;
                    let dr = test_r - tr;
                    let dc = test_c - tc;
                    if dr * dr + dc * dc <= SILO_RANGE * SILO_RANGE {
                        let owner = self.cell_owner((test_r * MAP_WIDTH as i32 + test_c) as usize) as usize;
                        if owner != 0 && owner != f {
                            can_reach_enemy = true;
                            break;
                        }
                    }
                }
                
                if can_reach_enemy {
                    self.place_silo(f as u32, tr, tc);
                    continue;
                }
            } else if roll < 30 && self.player_gold[f] >= ANTIAIR_BUILDING_COST {
                // 15% chance for Anti-Air
                self.place_antiair(f as u32, tr, tc);
                continue;
            } else if roll < 45 && self.player_gold[f] >= MINE_BUILDING_COST {
                // 15% chance for Gold Mine
                self.place_mine(f as u32, tr, tc);
                continue;
            }
            
            // Default: 55% chance for Defense Tower (or fallback if silo fails)
            self.place_defense_building(f as u32, tr, tc);
        }
    }

    /// Drive every bot faction to optionally fire missiles.
    #[wasm_bindgen]
    pub fn bot_fire_missiles(&mut self) {
        for f in 1..PLAYER_ARRAY_SIZE {
            if self.player_is_bot[f] != 1 || self.player_is_alive[f] == 0 { continue; }
            if self.player_gold[f] < MISSILE_COST { continue; }

            // Collect this bot's active silos
            let mut silo_centers = Vec::new();
            for i in 0..self.defense_buildings.len() {
                if self.building_type[i] == BTYPE_SILO 
                    && self.defense_build_complete[i] <= self.current_tick 
                    && self.building_owner[i] as usize == f 
                {
                    silo_centers.push(self.defense_buildings[i]);
                }
            }

            if silo_centers.is_empty() { continue; }

            // Prefer targeting enemy buildings (silos > antiair/defense > mines)
            let mut best_target: Option<(i32, i32)> = None;
            let mut best_score = 0;
            for i in 0..self.defense_buildings.len() {
                let owner = self.building_owner[i] as usize;
                if owner != 0 && owner != f {
                    let btype = self.building_type[i];
                    let score = if btype == BTYPE_SILO {
                        3
                    } else if btype == BTYPE_ANTIAIR || btype == BTYPE_DEFENSE {
                        2
                    } else {
                        1
                    };
                    
                    if score > best_score {
                        let center = self.defense_buildings[i];
                        let r = (center / MAP_WIDTH as u32) as i32;
                        let c = (center % MAP_WIDTH as u32) as i32;
                        // Check if in range of any silo
                        for &sc in &silo_centers {
                            let sr = (sc / MAP_WIDTH as u32) as i32;
                            let sc_col = (sc % MAP_WIDTH as u32) as i32;
                            let dr = r - sr;
                            let dc = c - sc_col;
                            if dr * dr + dc * dc <= SILO_RANGE * SILO_RANGE {
                                best_target = Some((r, c));
                                best_score = score;
                                break;
                            }
                        }
                    }
                }
            }

            if let Some((r, c)) = best_target {
                self.fire_missile(f as u32, r, c);
            } else {
                // If no building found, sample random cells within range of a random silo
                let sc_idx = self.next_rand() as usize % silo_centers.len();
                let sc = silo_centers[sc_idx];
                let sr = (sc / MAP_WIDTH as u32) as i32;
                let s_col = (sc % MAP_WIDTH as u32) as i32;
                let r_min = (sr - SILO_RANGE).max(0);
                let r_max = (sr + SILO_RANGE).min(MAP_HEIGHT as i32 - 1);
                let c_min = (s_col - SILO_RANGE).max(0);
                let c_max = (s_col + SILO_RANGE).min(MAP_WIDTH as i32 - 1);

                let r_diff = (r_max - r_min + 1) as u32;
                let c_diff = (c_max - c_min + 1) as u32;
                if r_diff > 0 && c_diff > 0 {
                    for _ in 0..15 {
                        let test_r = r_min + (self.next_rand() % r_diff) as i32;
                        let test_c = c_min + (self.next_rand() % c_diff) as i32;
                        let dr = test_r - sr;
                        let dc = test_c - s_col;
                        if dr * dr + dc * dc <= SILO_RANGE * SILO_RANGE {
                            let owner = self.cell_owner((test_r * MAP_WIDTH as i32 + test_c) as usize) as usize;
                            if owner != 0 && owner != f {
                                self.fire_missile(f as u32, test_r, test_c);
                                break;
                            }
                        }
                    }
                }
            }
        }
    }
}
