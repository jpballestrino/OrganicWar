export const COLS = 1920;
export const ROWS = 1080;
export const CELL_SIZE = 1;
// Faction capacity of one room — mirrors MAX_PLAYERS in simulation-core/src/lib.rs
// (the server checks the two agree at room start). Index 0 is neutral land, so
// per-faction arrays have MAX_FACTIONS + 1 entries.
export const MAX_FACTIONS = 64;
// Players in a Quick Battle. Pacing, missions and milestones are calibrated
// for 20 (see progression.js / matchFeel.js) — re-measure before changing.
export const QUICK_PLAY_PLAYERS = 20;
export const BORDER_BRIGHTNESS = 65;
export const MAP_WIDTH = COLS * CELL_SIZE;
export const MAP_HEIGHT = ROWS * CELL_SIZE;
export const TOTAL_CELLS = MAP_WIDTH * MAP_HEIGHT;

// Packed per-cell layout (one u16 per cell). Mirrors the bit layout in
// simulation-core/src/lib.rs — keep both in lockstep.
//   bits 0-6   owner (0-127), bits 7-10 terrain (0-15),
//   bits 11-14 defense (0-15), bit 15 has-building.
export const CELL_OWNER_MASK = 0x007F;
export const CELL_TERRAIN_SHIFT = 7;
export const CELL_TERRAIN_MASK = 0x000F << CELL_TERRAIN_SHIFT; // 0x0780

// Population growth model — MUST mirror simulation-core/src/lib.rs. Used only to
// display the growth rate in the HUD (the server runs the authoritative sim).
export const POP_CAP_PER_CELL = 2;
// Gold income per owned cell per second — mirrors GOLD_PER_CELL_PER_SEC in
// simulation-core/src/lib.rs. Used to show the income rate in the economy HUD.
export const GOLD_PER_CELL_PER_SEC = 0.00333;
// Gold cost of a defense building — mirrors DEFENSE_BUILDING_COST in
// simulation-core/src/lib.rs. The server is authoritative; this is for the HUD
// and a client-side pre-check so we don't send unaffordable build requests.
export const DEFENSE_BUILDING_COST = 2000;
// Defense building construction time (ms) — mirrors DEFENSE_BUILD_SECONDS (5s) in
// simulation-core/src/lib.rs. Used as the client fill-bar duration; the server
// sends the authoritative value in the building-placed event (this is a fallback).
export const DEFENSE_BUILD_MS = 5000;
// Missile silo + missiles — mirror SILO_* / MISSILE_* in simulation-core/src/lib.rs.
// The server is authoritative; these drive HUD labels, client-side affordability
// pre-checks, the dashed range/blast previews, and the build-time fill bar.
export const SILO_BUILDING_COST = 10000;
export const SILO_BUILD_MS = 10000;
export const SILO_RANGE = 240;      // missile firing range from a completed silo (cells)

// Gold Mine building
export const MINE_BUILDING_COST = 3000;
export const MINE_BUILD_MS = 10000;

// Anti-Air Battery building
export const ANTIAIR_BUILDING_COST = 5000;
export const ANTIAIR_BUILD_MS = 10000;
export const ANTIAIR_RADIUS = 400;
export const ANTIAIR_MAX_CHARGES = 3;

// City building — boosts max pop by CITY_POP_BONUS per completed city.
// Mirrors BTYPE_CITY / CITY_BUILDING_COST / CITY_BUILD_SECONDS / CITY_POP_BONUS in lib.rs.
export const CITY_BUILDING_COST = 2000;
export const CITY_BUILD_MS = 5000;
export const CITY_POP_BONUS = 0.05;
export const MISSILE_COST = 2000;
export const MISSILE_BLAST_RADIUS = 15;
export const GROWTH_PEAK_RATIO = 0.40;   // growth peaks at this population fill
export const PEAK_GROWTH_FRACTION = 0.05; // peak troops/sec as a fraction of cap
export const MIN_GROWTH_PER_SEC = 5.0;    // recovery floor

// Max troops a single defended cell can cost (defender troops-per-cell density is
// clamped to this in the sim). Also the top of the territory render-opacity ramp:
// difficulty 0..DIFFICULTY_CAP maps to colour opacity 0..100%. Mirror lib.rs.
export const DIFFICULTY_CAP = 50;
// Floor so freshly-taken, low-density territory still reads as owned (not invisible).
export const MIN_TERRITORY_OPACITY = 0.12;

// ── Build bar ────────────────────────────────────────────────────────────────
// Every purchasable action, in hotkey order. This table is the single source of
// truth for the HUD build bar, the hotkeys, click placement, the affordability
// state and the server's reject messages (see src/js/buildBar.js). `mode` is the
// value held in state.activePurchaseMode; `type` is the building's wire `type`
// (null for the missile, which is an action, not a building); `input` is the
// sim-input type sent to the server; `preview` names the renderer method that
// draws the placement/targeting overlay.
export const BUILD_ACTIONS = [
  { mode: 'missile', key: '2', name: 'Missile', type: null, input: 'fire_missile', cost: MISSILE_COST,
    preview: 'drawMissileTargeting',
    desc: 'Fire from a completed silo at an enemy cell in range. Razes troops and buildings in the blast.' },
  { mode: 'defense_building', key: '3', name: 'Defense Tower', type: 'defense', input: 'build_defense', cost: DEFENSE_BUILDING_COST,
    preview: 'drawBuildingPlacementPreview',
    desc: 'Fortifies your land around it: attackers pay far more per cell. Destroyed if any of its cells falls.' },
  { mode: 'silo', key: '4', name: 'Missile Silo', type: 'silo', input: 'build_silo', cost: SILO_BUILDING_COST,
    preview: 'drawSiloPlacementPreview',
    desc: 'Lets you fire missiles at targets within its range. Changes hands only if fully conquered.' },
  { mode: 'mine', key: '5', name: 'Gold Mine', type: 'mine', input: 'build_mine', cost: MINE_BUILDING_COST,
    preview: 'drawMinePlacementPreview',
    desc: 'Raises your gold income by 10%.' },
  { mode: 'antiair', key: '6', name: 'Anti-Air', type: 'antiair', input: 'build_antiair', cost: ANTIAIR_BUILDING_COST,
    preview: 'drawAntiAirPlacementPreview',
    desc: 'Shoots down missiles aimed at your land. Holds 3 interceptors.' },
  { mode: 'city', key: '7', name: 'City', type: 'city', input: 'build_city', cost: CITY_BUILDING_COST,
    preview: 'drawCityPlacementPreview',
    desc: 'Raises your maximum population by 5%.' },
];

// Whole numbers in the HUD are always shown with thousands separators.
export function fmtInt(n) {
  return Math.max(0, Math.floor(n || 0)).toLocaleString('en-US');
}

// Troops/sec a player gains right now, given current troops and max population.
// Same downward parabola the sim uses (peak at GROWTH_PEAK_RATIO, 0 at full pop).
export function troopGrowthPerSec(troops, maxPop) {
  if (maxPop <= 0 || troops >= maxPop) { return 0; }
  const p = Math.min(Math.max(troops / maxPop, 0), 1);
  const root2 = 2 * GROWTH_PEAK_RATIO - 1;                       // -0.2
  const shapePeak = (1 - GROWTH_PEAK_RATIO) * (GROWTH_PEAK_RATIO - root2); // 0.36
  const shape = Math.max((1 - p) * (p - root2) / shapePeak, 0);
  return Math.max(maxPop * PEAK_GROWTH_FRACTION * shape, MIN_GROWTH_PER_SEC);
}

// Faction colours. The first 30 are hand-picked; the rest (rooms bigger than
// 30) are spread around the hue wheel by the golden angle so neighbours in id
// order never look alike. One list feeds every format the UI needs.
const HAND_PICKED_RGB = [
  [84, 153, 199], [205, 97, 85], [240, 178, 122], [175, 122, 197], [72, 201, 176],
  [244, 208, 63], [133, 146, 158], [241, 148, 138], [118, 215, 196], [133, 193, 233],
  [236, 112, 99], [187, 143, 206], [245, 183, 177], [229, 152, 102], [163, 228, 215],
  [247, 220, 111], [171, 235, 198], [204, 209, 209], [235, 152, 78], [169, 204, 227],
  [141, 110, 99], [255, 152, 0], [205, 220, 57], [0, 188, 212], [156, 39, 176],
  [233, 30, 99], [96, 125, 139], [255, 193, 7], [139, 195, 74], [3, 169, 244],
];

function hslToRgb(h, sat, light) {
  const k = (n) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

export const factionRGB = {};
export const factionBaseColors = {};
export const factionHexColors = {};
for (let fid = 1; fid <= MAX_FACTIONS; fid++) {
  const rgb = HAND_PICKED_RGB[fid - 1]
    || hslToRgb((fid * 137.508) % 360, 0.55 + (fid % 3) * 0.1, 0.58 + (fid % 2) * 0.08);
  factionRGB[fid] = rgb;
  factionBaseColors[fid] = rgb.join(', ');
  factionHexColors[fid] = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export const terrainRGB = {
  0: [241, 245, 237],  // Plains (Light Pale Greenish-Tan)
  1: [230, 223, 210],  // Highlands (Soft Tan)
  2: [215, 215, 215],  // Mountains (Pale Grey)
  3: [120, 190, 220],   // Water (Soft Light Blue)
};

export const terrainColors = {
  0: '#f1f5ed', // Plains
  1: '#e6dfd2', // Highlands
  2: '#d7d7d7', // Mountains
  3: '#78bedc',  // Water
};

export const TERRAIN_WATER = 3;
export const CAPTURE_COST_PLAINS = 0.15;
export const CAPTURE_COST_HIGHLANDS = 0.45;
export const CAPTURE_COST_MOUNTAINS = 1.00;
export const MIN_ATTACK_FORCE = 12;
export const INITIAL_TROOPS = 200;
export const INITIAL_GOLD = 100;
export const BASE_CAPACITY = 150;
export const SHOP_COST_MULTIPLIER = 1.0;
export const SHOP_COSTS = {
  factory: 3000,
  city: 4500,
  defense: 2000,
  missile: 6000,
  silo: 3500,
  port: 2500,
  artillery: 4000,
};
export const INITIAL_MISSILE_COOLDOWN = -0.8;
export const SILO_UPGRADE_COST_L2 = 20000;
export const SILO_UPGRADE_COST_L3 = 50000;
export const SILO_UPGRADE_RANGES = [100, 150, 200];
export const SILO_BLAST_RADIUS = [18, 30, 46];
export const EXPLOSION_VISUAL_MULTIPLIER = 3;
export const VITAL_SPACE_RADIUS = 40;

// Defense building influence radius (cells). Must match BUILDING_RADIUS in
// simulation-core/src/lib.rs and the radius emitted in the building-placed event.
export const BUILDING_RADIUS = 40;

// Faction & Doctrine modifiers
export const CAPACITY_GAIN_STANDARD = 0.125;
export const CAPACITY_GAIN_EXPANSIONIST = 0.1875;
export const CAPACITY_CITY_MULTIPLIER = 0.25;

export const DOCTRINE_FACTORY_COST_INDUSTRIAL = 0.8;
export const DOCTRINE_FACTORY_COST_MILITARIST = 1.2;

// Expansion velocity limits
export const MIN_EXPANSION_STEPS = 3;
export const MAX_EXPANSION_STEPS = 500;
export const MAX_NATURE_EXPANSION_STEPS = 300;
export const MIN_NATURE_EXPANSION_STEPS = 10;
