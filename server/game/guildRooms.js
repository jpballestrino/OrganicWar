// Guild chat rooms on the live sockets.
//
// A logged-in socket sits in the Socket.IO room `guild:<id>` of its guild, so
// it receives that guild's chat and presence. Membership changes happen over
// REST (create / join / invite or request accepted / leave / kick / disband)
// while the player stays connected, so those routes must move the socket in
// and out of the room themselves — otherwise a new member sees no chat until
// they reload, and someone who left keeps receiving the old guild's messages.

import { userSocketMap } from './state.js';
import { getGuildMessages } from '../database.js';

export const guildRoom = (guildId) => `guild:${guildId}`;

// The connected socket of a user, if any (one socket per account: a second
// login disconnects the first).
export function socketOfUser(io, userId) {
  const sid = userSocketMap.get(Number(userId));
  return sid ? io.sockets.sockets.get(sid) || null : null;
}

function chatHistory(guildId) {
  return getGuildMessages(guildId, 200).map(row => ({
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    message: row.message,
    timestamp: row.created_at,
  }));
}

function onlineMemberIds(io, guildId) {
  const ids = [];
  const room = io.sockets.adapter.rooms.get(guildRoom(guildId));
  if (room) {
    for (const sid of room) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.userId) ids.push(s.userId);
    }
  }
  return ids;
}

// Put `socket` in its guild's room and send it the chat history and who is
// online; tell the other members it is online.
export function joinGuildRoom(io, socket, guildId, displayName) {
  if (!socket || !guildId) return;
  const room = guildRoom(guildId);
  socket.join(room);
  socket.to(room).emit('guild-member-online', { userId: socket.userId, displayName });
  socket.emit('guild-chat-history', chatHistory(guildId));
  socket.emit('guild-online-members', onlineMemberIds(io, guildId));
}

// Take `socket` out of the guild's room (it left, was kicked, or the guild was
// disbanded) and clear its chat.
export function leaveGuildRoom(io, socket, guildId) {
  if (!socket || !guildId) return;
  const room = guildRoom(guildId);
  socket.leave(room);
  socket.to(room).emit('guild-member-offline', { userId: socket.userId });
  socket.emit('guild-chat-history', []);
  socket.emit('guild-online-members', []);
}
