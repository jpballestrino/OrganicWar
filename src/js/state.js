export const state = {
  // Game states
  map: [],
  terrain: [],
  structuresMap: new Map(),
  troops: {},
  gold: {},
  cellCounts: {},
  activeExplosions: [],
  activeAttacks: [],
  missilesFired: {},
  factionStructures: {},
  alliances: {},
  incomingProposal: null,
  rightClickTargetFaction: null,
  isHoveringQuickMenu: false,
  shopCosts: {},
  doctrines: {},
  factionCentroids: {},
  factionOpacity: null, // Float32Array(21): per-faction density ratio (troops/cell / DIFFICULTY_CAP)
  buildings: [],        // [{type, factionId, row, col, radius, defTier}] — populated from building-placed events
  activeStructuresList: [],
  camera: { x: 0, y: 0, zoom: 1.0, minZoom: 0.5, maxZoom: 3.0, baseSpeed: 8 },

  // Local client selections
  playerFaction: null,
  playerNickname: 'Commander',
  selectedSlot: null,
  selectedDoctrine: 'balanced',
  activePurchaseMode: null,
  isInGameMenuOpen: false,
  isRankedMatch: false,
  isGuildWar: false,
  guildA: null,
  guildB: null,
  teamSize: 0,
  
  // HUD variables
  attackPercentage: 20,
  playerTroops: 0,
  playerMaxPop: 0,
  playerGold: 0,
  
  navalTargetingMode: false,
  selectedSiloCell: null,
  keysPressed: {},
  hoveredCell: { r: -1, c: -1 },
  lastIncomingAttackCoords: null,
  gameState: 'SETUP', // "SETUP", "SPAWN_SELECTION", "PLAYING", "DEFEAT", "VICTORY", "SPECTATING", "END_GAME"
  spawnTimeLeft: 10,
  countdownInterval: null,
  currentPreset: 'north_america',
  activePlayerSlots: {},
  lastRenderedSiloState: { r: -1, c: -1, level: -1, canAfford: false },
  currentLeaderId: null,
  spawnSelections: {},
  mySpawnSelection: null,

  // Debug fields
  debug: false,
  lastApplyMs: 0,
  avgApplyMs: 0,
};

export function resetGameState() {
  state.map = [];
  state.terrain = [];
  state.structuresMap.clear();
  state.troops = {};
  state.gold = {};
  state.cellCounts = {};
  state.activeExplosions = [];
  state.activeAttacks = [];
  state.missilesFired = {};
  state.factionStructures = {};
  state.alliances = {};
  state.incomingProposal = null;
  state.rightClickTargetFaction = null;
  state.isHoveringQuickMenu = false;
  state.isInGameMenuOpen = false;
  state.doctrines = {};
  state.factionCentroids = {};
  state.factionOpacity = null;
  state.buildings = [];
  state.activeStructuresList = [];
  state.camera.x = 0;
  state.camera.y = 0;
  state.camera.zoom = 1.0;
  for (let k in state.keysPressed) {delete state.keysPressed[k];}

  state.playerGold = 0;
  state.playerFaction = null;
  state.selectedSlot = null;
  state.selectedDoctrine = 'balanced';
  state.activePurchaseMode = null;
  state.navalTargetingMode = false;
  state.selectedSiloCell = null;
  state.lastIncomingAttackCoords = null;
  state.gameState = 'SETUP';
  state.spawnTimeLeft = 10;
  if (state.countdownInterval) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
  state.activePlayerSlots = {};
  state.lastRenderedSiloState = { r: -1, c: -1, level: -1, canAfford: false };
  state.currentLeaderId = null;
  state.spawnSelections = {};
  state.mySpawnSelection = null;
  state.lastApplyMs = 0;
  state.avgApplyMs = 0;
}
