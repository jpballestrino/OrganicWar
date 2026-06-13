import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.NODE_ENV === 'test' ? ':memory:' : path.join(__dirname, 'organicwar.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// Prepared statements for guild chat (initialized in prepareStatements)
let guildChatStmts = {};

export function addGuildMessage(guildId, userId, message) {
  return db.transaction(() => {
    const info = guildChatStmts.insert.run(guildId, userId, message);

    // Delete older messages keeping only the last 200
    guildChatStmts.cleanup.run(guildId, guildId);

    return guildChatStmts.fetch.get(info.lastInsertRowid);
  })();
}

export function getGuildMessages(guildId, limit = 50) {
  const stmt = db.prepare(`
        SELECT m.*, u.display_name, u.username
        FROM guild_chat_messages m
        JOIN users u ON m.user_id = u.id
        WHERE m.guild_id = ?
        ORDER BY m.id DESC LIMIT ?
    `);
  const msgs = stmt.all(guildId, limit);
  return msgs.reverse(); // Return in chronological order
}

// Prepared Statements
export const stmts = {};

export function prepareStatements() {
  // Guild chat prepared statements
  guildChatStmts = {
    insert: db.prepare('INSERT INTO guild_chat_messages (guild_id, user_id, message) VALUES (?, ?, ?)'),
    cleanup: db.prepare('DELETE FROM guild_chat_messages WHERE guild_id = ? AND id NOT IN (SELECT id FROM guild_chat_messages WHERE guild_id = ? ORDER BY id DESC LIMIT 200)'),
    fetch: db.prepare('SELECT m.*, u.display_name, u.username FROM guild_chat_messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?'),
  };

  Object.assign(stmts, {
    createUser: db.prepare('INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)'),
    findUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    findUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    findUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
    updateLastLogin: db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?'),
    updateUserStats: db.prepare('UPDATE users SET total_wins = total_wins + ?, total_losses = total_losses + ?, total_games = total_games + ?, total_cells_conquered = total_cells_conquered + ?, total_kills = total_kills + ? WHERE id = ?'),
    createGuild: db.prepare('INSERT INTO guilds (name, tag, description, leader_id, color) VALUES (?, ?, ?, ?, ?)'),
    findGuildById: db.prepare('SELECT * FROM guilds WHERE id = ?'),
    addGuildMember: db.prepare('INSERT INTO guild_members (user_id, guild_id, role) VALUES (?, ?, ?)'),
    removeGuildMember: db.prepare('DELETE FROM guild_members WHERE user_id = ? AND guild_id = ?'),
    decrementGuildMemberCount: db.prepare('UPDATE guilds SET member_count = member_count - 1 WHERE id = ?'),
    incrementGuildMemberCount: db.prepare('UPDATE guilds SET member_count = member_count + 1 WHERE id = ?'),
    updateUserGuild: db.prepare('UPDATE users SET guild_id = ? WHERE id = ?'),
    getGuildMembers: db.prepare('SELECT gm.user_id, u.username, u.display_name, gm.role, u.elo_rating FROM guild_members gm JOIN users u ON gm.user_id = u.id WHERE gm.guild_id = ?'),
    createGuildInvite: db.prepare('INSERT INTO guild_invites (guild_id, inviter_id, invitee_id) VALUES (?, ?, ?)'),
    getPendingInvites: db.prepare('SELECT gi.*, g.name as guild_name, g.tag as guild_tag FROM guild_invites gi JOIN guilds g ON gi.guild_id = g.id WHERE gi.invitee_id = ? AND gi.status = \'pending\''),
    recordMatch: db.prepare('INSERT INTO match_history (room_id, user_id, faction_id, result, cells_conquered, kills, gold_earned, duration_seconds, is_guild_match, guild_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    getUserProfile: db.prepare('SELECT u.id, u.username, u.display_name, u.total_wins, u.total_losses, u.total_games, u.total_cells_conquered, u.total_kills, u.elo_rating, u.guild_id, g.name as guild_name, g.tag as guild_tag, g.color as guild_color, g.elo_rating as guild_elo, gm.role as guild_role FROM users u LEFT JOIN guilds g ON u.guild_id = g.id LEFT JOIN guild_members gm ON gm.user_id = u.id AND gm.guild_id = u.guild_id WHERE u.username = ?'),
    getMatchHistory: db.prepare('SELECT * FROM match_history WHERE user_id = (SELECT id FROM users WHERE username = ?) ORDER BY played_at DESC LIMIT ? OFFSET ?'),
    updateUserElo: db.prepare('UPDATE users SET elo_rating = MAX(0, elo_rating + ?) WHERE id = ?'),
    updateGuildSettings: db.prepare('UPDATE guilds SET name = ?, tag = ?, description = ?, color = ?, is_open = ?, max_members = ? WHERE id = ?'),
    searchGuilds: db.prepare('SELECT id, name, tag, member_count, is_open, max_members, description, color, elo_rating FROM guilds WHERE name LIKE ? OR tag LIKE ?'),
    findInviteById: db.prepare('SELECT * FROM guild_invites WHERE id = ?'),
    updateInviteStatus: db.prepare('UPDATE guild_invites SET status = ? WHERE id = ?'),
    updateGuildMemberRole: db.prepare('UPDATE guild_members SET role = ? WHERE user_id = ? AND guild_id = ?'),
    updateGuildLeader: db.prepare('UPDATE guilds SET leader_id = ? WHERE id = ?'),
    deleteGuild: db.prepare('DELETE FROM guilds WHERE id = ?'),
    updateGuildMatchStats: db.prepare('UPDATE guilds SET total_guild_wins = total_guild_wins + ?, total_guild_losses = total_guild_losses + ?, elo_rating = MAX(0, elo_rating + ?) WHERE id = ?'),
    findGuildByTag: db.prepare('SELECT * FROM guilds WHERE tag = ?'),
    createGuildRequest: db.prepare('REPLACE INTO guild_requests (guild_id, user_id, status) VALUES (?, ?, \'pending\')'),
    getGuildRequests: db.prepare('SELECT gr.*, u.username, u.display_name FROM guild_requests gr JOIN users u ON gr.user_id = u.id WHERE gr.guild_id = ? AND gr.status = \'pending\''),
    findGuildRequestById: db.prepare('SELECT * FROM guild_requests WHERE id = ?'),
    updateGuildRequestStatus: db.prepare('UPDATE guild_requests SET status = ? WHERE id = ?'),
    getTopPlayers: db.prepare('SELECT u.id, u.username, u.display_name, u.total_wins, u.total_losses, u.total_games, u.elo_rating, u.guild_id, g.tag as guild_tag, g.name as guild_name, g.color as guild_color FROM users u LEFT JOIN guilds g ON u.guild_id = g.id ORDER BY u.elo_rating DESC LIMIT ?'),
    getTopGuilds: db.prepare('SELECT id, name, tag, member_count, elo_rating, total_guild_wins, total_guild_losses, color, is_open, max_members FROM guilds ORDER BY elo_rating DESC LIMIT ?'),
  });
}

export function createUser(username, email, passwordHash, displayName) {
  const info = stmts.createUser.run(username, email, passwordHash, displayName);
  return findUserById(info.lastInsertRowid);
}

export function findUserByEmail(email) {
  return stmts.findUserByEmail.get(email);
}

export function findUserByUsername(username) {
  return stmts.findUserByUsername.get(username);
}

export function findUserById(id) {
  return stmts.findUserById.get(id);
}

export function updateLastLogin(userId) {
  stmts.updateLastLogin.run(userId);
}

export function updateUserStats(userId, { wins, losses, games, cells, kills }) {
  stmts.updateUserStats.run(wins, losses, games, cells, kills, userId);
}

export function createGuild(name, tag, description, leaderId, color) {
  let guildId;
  const transaction = db.transaction(() => {
    const info = stmts.createGuild.run(name, tag, description, leaderId, color);
    guildId = info.lastInsertRowid;
    stmts.addGuildMember.run(leaderId, guildId, 'leader');
    stmts.updateUserGuild.run(guildId, leaderId);
  });
  transaction();
  return findGuildById(guildId);
}

export function findGuildById(id) {
  const guild = stmts.findGuildById.get(id);
  if (guild) {
    guild.members = getGuildMembers(id);
  }
  return guild;
}

export function addGuildMember(userId, guildId, role = 'member') {
  const transaction = db.transaction(() => {
    stmts.addGuildMember.run(userId, guildId, role);
    stmts.incrementGuildMemberCount.run(guildId);
    stmts.updateUserGuild.run(guildId, userId);
  });
  transaction();
}

export function removeGuildMember(userId, guildId) {
  const transaction = db.transaction(() => {
    stmts.removeGuildMember.run(userId, guildId);
    stmts.decrementGuildMemberCount.run(guildId);
    stmts.updateUserGuild.run(null, userId);
  });
  transaction();
}

export function updateGuildSettings(guildId, name, tag, description, color, isOpen, maxMembers) {
  stmts.updateGuildSettings.run(name, tag, description, color, isOpen, maxMembers, guildId);
}

export function searchGuilds(query) {
  const escaped = query.replace(/[%_]/g, '\\$&');
  return stmts.searchGuilds.all(`%${escaped}%`, `%${escaped}%`);
}

export function findInviteById(inviteId) {
  return stmts.findInviteById.get(inviteId);
}

export function respondToGuildInvite(inviteId, accept, userId, guildId) {
  const transaction = db.transaction(() => {
    if (accept) {
      stmts.addGuildMember.run(userId, guildId, 'member');
      stmts.incrementGuildMemberCount.run(guildId);
      stmts.updateUserGuild.run(guildId, userId);
      stmts.updateInviteStatus.run('accepted', inviteId);
    } else {
      stmts.updateInviteStatus.run('declined', inviteId);
    }
  });
  transaction();
}

export function createGuildRequest(guildId, userId) {
  const info = stmts.createGuildRequest.run(guildId, userId);
  return { id: info.lastInsertRowid, guild_id: guildId, user_id: userId, status: 'pending' };
}

export function getGuildRequests(guildId) {
  return stmts.getGuildRequests.all(guildId);
}

export function findGuildRequestById(requestId) {
  return stmts.findGuildRequestById.get(requestId);
}

export function respondToGuildRequest(requestId, accept, userId, guildId) {
  const transaction = db.transaction(() => {
    if (accept) {
      stmts.addGuildMember.run(userId, guildId, 'member');
      stmts.incrementGuildMemberCount.run(guildId);
      stmts.updateUserGuild.run(guildId, userId);
      stmts.updateGuildRequestStatus.run('accepted', requestId);
    } else {
      stmts.updateGuildRequestStatus.run('declined', requestId);
    }
  });
  transaction();
}

export function promoteGuildMember(userId, guildId, role) {
  stmts.updateGuildMemberRole.run(role, userId, guildId);
}

export function transferLeadership(newLeaderId, guildId) {
  const transaction = db.transaction(() => {
    const guild = stmts.findGuildById.get(guildId);
    if (guild && guild.leader_id) {
      stmts.updateGuildMemberRole.run('member', guild.leader_id, guildId);
    }
    stmts.updateGuildMemberRole.run('leader', newLeaderId, guildId);
    stmts.updateGuildLeader.run(newLeaderId, guildId);
  });
  transaction();
}

export function disbandGuild(guildId) {
  const transaction = db.transaction(() => {
    const members = stmts.getGuildMembers.all(guildId);
    for (const member of members) {
      stmts.updateUserGuild.run(null, member.user_id);
    }
    stmts.deleteGuild.run(guildId);
  });
  transaction();
}

export function updateGuildMatchStats(guildId, isWin, eloDelta) {
  const winsDelta = isWin ? 1 : 0;
  const lossesDelta = isWin ? 0 : 1;
  stmts.updateGuildMatchStats.run(winsDelta, lossesDelta, eloDelta, guildId);
}

export function findGuildByTag(tag) {
  return stmts.findGuildByTag.get(tag);
}

export function getGuildMembers(guildId) {
  return stmts.getGuildMembers.all(guildId);
}

export function createGuildInvite(guildId, inviterId, inviteeId) {
  const info = stmts.createGuildInvite.run(guildId, inviterId, inviteeId);
  return { id: info.lastInsertRowid, guild_id: guildId, inviter_id: inviterId, invitee_id: inviteeId, status: 'pending' };
}

export function getPendingInvites(userId) {
  return stmts.getPendingInvites.all(userId);
}

export function recordMatch(roomId, userId, factionId, result, stats) {
  stmts.recordMatch.run(roomId, userId, factionId, result, stats.cells || 0, stats.kills || 0, stats.gold || 0, stats.duration || 0, stats.isGuildMatch ? 1 : 0, stats.guildId || null);
}

export function getUserProfile(username) {
  return stmts.getUserProfile.get(username);
}

export function getMatchHistory(username, page = 1, limit = 20) {
  const offset = (page - 1) * limit;
  return stmts.getMatchHistory.all(username, limit, offset);
}

export function updateUserElo(userId, delta) {
  stmts.updateUserElo.run(delta, userId);
}

export function getTopPlayers(limit = 100) {
  return stmts.getTopPlayers.all(limit);
}

export function getTopGuilds(limit = 20) {
  return stmts.getTopGuilds.all(limit);
}

// ---------- OAUTH -----------
export function findUserByOAuth(provider, providerId) {
  return db.prepare('SELECT * FROM users WHERE oauth_provider = ? AND oauth_provider_id = ?').get(provider, providerId);
}

export function createOAuthUser(username, email, displayName, provider, providerId) {
  const stmt = db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name, oauth_provider, oauth_provider_id) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const info = stmt.run(username, email, 'OAUTH_NO_PASSWORD', displayName, provider, providerId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

export function linkOAuthToUser(userId, provider, providerId) {
  db.prepare('UPDATE users SET oauth_provider = ?, oauth_provider_id = ? WHERE id = ?').run(provider, providerId, userId);
}

// ---------- PASSWORD RESET -----------
export function createPasswordResetToken(userId, token, expiresAt) {
  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expiresAt);
}

export function findValidResetToken(token) {
  return db.prepare(
    'SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime("now")',
  ).get(token);
}

export function markResetTokenUsed(tokenId) {
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(tokenId);
}

export function updateUserPassword(userId, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}

export default db;
