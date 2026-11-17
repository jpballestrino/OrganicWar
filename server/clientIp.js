// The real client IP of a Socket.IO connection.
//
// Behind a reverse proxy (Render's load balancer, Caddy, nginx) the TCP peer is
// the proxy, so every player would share one address — and the per-IP
// connection limits would cap the whole game at a handful of players. With
// TRUST_PROXY=N (N proxy hops in front of the server) the address is taken from
// X-Forwarded-For instead: the N-th entry from the right, i.e. the address the
// outermost trusted proxy saw. Entries further left are client-supplied and
// never trusted. TRUST_PROXY=0 (default, e.g. local dev) uses the TCP peer.

export const TRUST_PROXY = Math.max(0, parseInt(process.env.TRUST_PROXY, 10) || 0);

export function clientIp(socket) {
  const peer = socket.handshake.address;
  if (TRUST_PROXY === 0) return peer;
  const header = socket.handshake.headers['x-forwarded-for'];
  if (typeof header !== 'string' || !header) return peer;
  const hops = header.split(',').map(s => s.trim()).filter(Boolean);
  return hops[Math.max(0, hops.length - TRUST_PROXY)] || peer;
}
