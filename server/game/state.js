import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const activeRooms = {};
export const userSocketMap = new Map();
export let guildWarQueue = [];
export let rankedQueue = [];

export const MAPS_FILE = path.join(__dirname, '..', 'maps.json');
export let savedMaps = {};

if (fs.existsSync(MAPS_FILE)) {
  try {
    savedMaps = JSON.parse(fs.readFileSync(MAPS_FILE, 'utf8'));
  } catch(e) { 
    console.error('Error loading maps.json', e); 
  }
}
