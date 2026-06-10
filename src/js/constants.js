export const COLS = 1920;
export const ROWS = 1080;
export const CELL_SIZE = 1;
export const MAX_FACTIONS = 20;
export const BORDER_BRIGHTNESS = 65;
export const MAP_WIDTH = COLS * CELL_SIZE;
export const MAP_HEIGHT = ROWS * CELL_SIZE;

export const factionRGB = {
  1: [84, 153, 199],   // Soft Blue
  2: [205, 97, 85],    // Soft Red
  3: [240, 178, 122],  // Soft Orange
  4: [175, 122, 197],  // Soft Purple
  5: [72, 201, 176],   // Soft Teal
  6: [244, 208, 63],   // Soft Yellow
  7: [133, 146, 158],  // Soft Slate
  8: [241, 148, 138],  // Soft Pink
  9: [118, 215, 196],  // Soft Mint
  10: [133, 193, 233], // Pale Blue
  11: [236, 112, 99],  // Pale Red
  12: [187, 143, 206], // Pale Purple
  13: [245, 183, 177], // Blush
  14: [229, 152, 102], // Peach
  15: [163, 228, 215], // Aqua
  16: [247, 220, 111], // Pale Mustard
  17: [171, 235, 198], // Pale Green
  18: [204, 209, 209], // Light Silver
  19: [235, 152, 78],  // Light Amber
  20: [169, 204, 227],  // Pale Indigo
  21: [141, 110, 99],  // Brown
  22: [255, 152, 0],   // Deep Orange
  23: [205, 220, 57],  // Lime
  24: [0, 188, 212],   // Cyan
  25: [156, 39, 176],  // Deep Purple
  26: [233, 30, 99],   // Pink
  27: [96, 125, 139],  // Blue Grey
  28: [255, 193, 7],   // Amber
  29: [139, 195, 74],  // Light Green
  30: [3, 169, 244],   // Light Blue
};

export const terrainRGB = {
  0: [241, 245, 237],  // Plains (Light Pale Greenish-Tan)
  1: [230, 223, 210],  // Highlands (Soft Tan)
  2: [215, 215, 215],  // Mountains (Pale Grey)
  3: [120, 190, 220],   // Water (Soft Light Blue)
};

export const factionBaseColors = {
  1: '84, 153, 199', 2: '205, 97, 85', 3: '240, 178, 122', 4: '175, 122, 197', 5: '72, 201, 176',
  6: '244, 208, 63', 7: '133, 146, 158', 8: '241, 148, 138', 9: '118, 215, 196', 10: '133, 193, 233',
  11: '236, 112, 99', 12: '187, 143, 206', 13: '245, 183, 177', 14: '229, 152, 102', 15: '163, 228, 215',
  16: '247, 220, 111', 17: '171, 235, 198', 18: '204, 209, 209', 19: '235, 152, 78', 20: '169, 204, 227',
  21: '141, 110, 99', 22: '255, 152, 0', 23: '205, 220, 57', 24: '0, 188, 212', 25: '156, 39, 176',
  26: '233, 30, 99', 27: '96, 125, 139', 28: '255, 193, 7', 29: '139, 195, 74', 30: '3, 169, 244',
};

export const factionHexColors = {
  1: '#5499C7', 2: '#CD6155', 3: '#F0B27A', 4: '#AF7AC5', 5: '#48C9B0',
  6: '#F4D03F', 7: '#85929E', 8: '#F1948A', 9: '#76D7C4', 10: '#85C1E9',
  11: '#EC7063', 12: '#BB8FCE', 13: '#F5B7B1', 14: '#E59866', 15: '#A3E4D7',
  16: '#F7DC6F', 17: '#ABEBC6', 18: '#CCD1D1', 19: '#EB984E', 20: '#A9CCE3',
  21: '#8D6E63', 22: '#FF9800', 23: '#CDDC39', 24: '#00BCD4', 25: '#9C27B0',
  26: '#E91E63', 27: '#607D8B', 28: '#FFC107', 29: '#8BC34A', 30: '#03A9F4',
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
export const SILO_RANGE = [100, 150, 200];
export const SILO_BLAST_RADIUS = [18, 30, 46];
export const EXPLOSION_VISUAL_MULTIPLIER = 3;
export const VITAL_SPACE_RADIUS = 40;

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
