import { matchmakeGuildWars, matchmakeRanked } from './roomManager.js';
import { io } from '../server.js';

export const guildWarMatchmakerInterval = setInterval(matchmakeGuildWars, 5000);
export const rankedMatchmakerInterval = setInterval(matchmakeRanked, 5000);

export const playerCountInterval = setInterval(() => {
  if (io && io.engine) {
    io.emit('player-count-update', io.engine.clientsCount);
  }
}, 5000);
