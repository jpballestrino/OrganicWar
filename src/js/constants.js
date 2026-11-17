// Shared client + server constants. Values that mirror simulation-core/src/lib.rs
// say so; the sim is always authoritative. Economy numbers (income, growth,
// population cap, live prices) are NOT mirrored: the HUD reads them from the
// sim-stats message (see simBridge.decodeStats).

export const COLS = 1920;
export const ROWS = 1080;
export const MAP_WIDTH = COLS;
export const MAP_HEIGHT = ROWS;
export const TOTAL_CELLS = MAP_WIDTH * MAP_HEIGHT;
// Faction capacity of one room — mirrors MAX_PLAYERS in simulation-core/src/lib.rs
// (the worker refuses to start a room if the two disagree). Index 0 is neutral
// land, so per-faction arrays have MAX_FACTIONS + 1 entries.
export const MAX_FACTIONS = 64;
// Players in a Quick Battle. Pacing, missions and milestones are calibrated
// for 20 (see progression.js / matchFeel.js) — re-measure before changing.
export const QUICK_PLAY_PLAYERS = 20;

// Packed per-cell layout (one u16 per cell). Mirrors the bit layout in
// simulation-core/src/lib.rs — keep both in lockstep.
//   bits 0-6   owner (0-127), bits 7-10 terrain (0-15),
//   bits 11-14 defense (0-15), bit 15 has-building.
export const CELL_OWNER_MASK = 0x007F;
export const CELL_TERRAIN_SHIFT = 7;
export const CELL_TERRAIN_MASK = 0x000F << CELL_TERRAIN_SHIFT; // 0x0780

// Base prices (the first building of each type; the sim adds 25% per one
// already owned and sends the live price in sim-stats). Mirror the *_COST
// consts in lib.rs; used before the first stats message arrives.
export const DEFENSE_BUILDING_COST = 2000;
export const SILO_BUILDING_COST = 10000;
export const MINE_BUILDING_COST = 3000;
export const ANTIAIR_BUILDING_COST = 5000;
export const CITY_BUILDING_COST = 2000;
export const MISSILE_COST = 2000;

// Geometry for previews and range rings — mirror lib.rs.
export const BUILDING_RADIUS = 40;     // defense tower fortification radius (cells)
export const SILO_RANGE = 240;         // missile range from a silo (cells)
export const ANTIAIR_RADIUS = 400;     // anti-air interception radius (cells)
export const MISSILE_BLAST_RADIUS = 15;
// Fallback progress-bar duration; building-placed carries the real buildMs.
export const DEFENSE_BUILD_MS = 5000;

// Troop growth peaks at this population fill (lib.rs GROWTH_PEAK_RATIO); the
// HUD colours the growth rate green below it and red above it.
export const GROWTH_PEAK_RATIO = 0.40;

// ── Building links (synergies) — mirror LINK_* in simulation-core/src/lib.rs ──
// Two of your COMPLETED buildings within LINK_RADIUS cells of each other link
// if their types pair up here. The sim applies the effect; the client draws the
// link and explains it. `bit` matches the LINK_* bit sent in building-updated.
export const LINK_RADIUS = 60;
export const RADAR_RANGE_MULT = 1.25;
export const BUILDING_LINKS = [
  { bit: 1,  name: 'Walled City',    types: ['city', 'defense'],    effect: 'the city gives +10% population instead of +5%' },
  { bit: 2,  name: 'Workforce',      types: ['mine', 'city'],       effect: 'the mine gives +15% gold instead of +10%' },
  { bit: 4,  name: 'Radar Guidance', types: ['silo', 'antiair'],    effect: 'the silo fires 25% farther' },
  { bit: 8,  name: 'Arms Industry',  types: ['silo', 'mine'],       effect: 'missiles from the silo cost 25% less' },
  { bit: 16, name: 'Flak Battery',   types: ['antiair', 'defense'], effect: 'the battery regains an interceptor every 20s' },
];
const NAME_BY_TYPE = { defense: 'Defense Tower', silo: 'Missile Silo', mine: 'Gold Mine', antiair: 'Anti-Air', city: 'City' };

// "Links: + City → Walled City (…)" lines for a building type's tooltip.
export function linkHelp(type) {
  return BUILDING_LINKS.filter(l => l.types.includes(type)).map((l) => {
    const other = l.types[0] === type ? l.types[1] : l.types[0];
    return `+ ${NAME_BY_TYPE[other]} nearby → ${l.name}: ${l.effect}.`;
  }).join('\n');
}

// ── Build bar ────────────────────────────────────────────────────────────────
// Every purchasable action, in hotkey order. This table is the single source of
// truth for the HUD build bar, the hotkeys, click placement, the affordability
// state and the server's reject messages (see src/js/buildBar.js). `mode` is the
// value held in state.activePurchaseMode; `type` is the building's wire `type`
// (null for actions that are not buildings); `input` is the sim-input type sent
// to the server; `preview` names the renderer method that draws the placement/
// targeting overlay; `priceKey` picks the live price from sim-stats (prices
// escalate per building owned — `cost` is only the base, shown before the first
// stats arrive). `instant` actions fire on the key press, with no map click.
export const BUILD_ACTIONS = [
  { mode: 'blitz', key: '1', name: 'Blitz', type: null, input: 'blitz', cost: 0, instant: true,
    desc: 'For 6 seconds your attacks advance twice as fast and pay 40% less to take enemy land. 45s cooldown.' },
  { mode: 'missile', key: '2', name: 'Missile', type: null, input: 'fire_missile', cost: MISSILE_COST, priceKey: 'missile',
    preview: 'drawMissileTargeting',
    desc: 'Fire from a completed silo at an enemy cell in range. Razes troops and buildings in the blast.' },
  { mode: 'defense_building', key: '3', name: 'Defense Tower', type: 'defense', input: 'build_defense', cost: DEFENSE_BUILDING_COST, priceKey: 'defense',
    preview: 'drawBuildingPlacementPreview',
    desc: 'Fortifies your land around it: attackers pay far more per cell. Destroyed if any of its cells falls.' },
  { mode: 'silo', key: '4', name: 'Missile Silo', type: 'silo', input: 'build_silo', cost: SILO_BUILDING_COST, priceKey: 'silo',
    preview: 'drawSiloPlacementPreview',
    desc: 'Lets you fire missiles at targets within its range. Changes hands only if fully conquered.' },
  { mode: 'mine', key: '5', name: 'Gold Mine', type: 'mine', input: 'build_mine', cost: MINE_BUILDING_COST, priceKey: 'mine',
    preview: 'drawMinePlacementPreview',
    desc: 'Raises your gold income by 10%.' },
  { mode: 'antiair', key: '6', name: 'Anti-Air', type: 'antiair', input: 'build_antiair', cost: ANTIAIR_BUILDING_COST, priceKey: 'antiair',
    preview: 'drawAntiAirPlacementPreview',
    desc: 'Shoots down missiles aimed at your land. Holds 3 interceptors.' },
  { mode: 'city', key: '7', name: 'City', type: 'city', input: 'build_city', cost: CITY_BUILDING_COST, priceKey: 'city',
    preview: 'drawCityPlacementPreview',
    desc: 'Raises your maximum population by 5%.' },
];

// Whole numbers in the HUD are always shown with thousands separators.
export function fmtInt(n) {
  return Math.max(0, Math.floor(n || 0)).toLocaleString('en-US');
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
export const factionHexColors = {};
for (let fid = 1; fid <= MAX_FACTIONS; fid++) {
  const rgb = HAND_PICKED_RGB[fid - 1]
    || hslToRgb((fid * 137.508) % 360, 0.55 + (fid % 3) * 0.1, 0.58 + (fid % 2) * 0.08);
  factionRGB[fid] = rgb;
  factionHexColors[fid] = '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}
