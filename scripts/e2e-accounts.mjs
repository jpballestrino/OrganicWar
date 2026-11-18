// End-to-end check of accounts, guilds and guild chat against a running
// server whose email goes to scripts/mail-catcher.mjs, so the verification and
// password-reset links are really received and followed.
//
//   node scripts/mail-catcher.mjs &
//   DB_PATH=/tmp/ow-e2e.db SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_USER=test SMTP_PASS=test \
//     APP_URL=http://localhost:3000 npm start
//   node scripts/e2e-accounts.mjs
//
// Use a throw-away DB_PATH: it creates accounts and guilds. Restart the server
// before running it again within an hour (the auth rate limits are per hour).

import { io as ioClient } from 'socket.io-client';

const BASE = process.env.URL || 'http://localhost:3000';
const MAIL = process.env.MAIL_URL || 'http://127.0.0.1:2526/mails';
const RUN = Date.now().toString(36).slice(-5);
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function mailsTo(addr) {
  const all = await (await fetch(MAIL)).json();
  return all.filter((m) => (m.to || '').toLowerCase().includes(addr.toLowerCase()));
}
async function waitMail(addr, n, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const list = await mailsTo(addr);
    if (list.length >= n || Date.now() > end) return list;
    await sleep(100);
  }
}
const linkIn = (mail, re) => {
  const m = (mail?.html || '').match(re);
  return m ? m[0].replace(/&amp;/g, '&') : null;
};
const VERIFY_RE = /https?:\/\/[^"'\s]+\/api\/auth\/verify-email\?token=[0-9a-f]+/;
const RESET_RE = /https?:\/\/[^"'\s]+\/reset-password\?token=[0-9a-f]+/;
const localPath = (link) => link.replace(/^https?:\/\/[^/]+/, '');

// A verified account, logged in.
async function makeUser(name) {
  const username = `${name}_${RUN}`;
  const email = `${username}@example.test`;
  const reg = await api('/api/auth/register', { method: 'POST', body: { username, email, password: 'secret123' } });
  if (!reg.data.requiresVerification) throw new Error(`register ${username}: ${JSON.stringify(reg.data)}`);
  const [mail] = await waitMail(email, 1);
  await api(localPath(linkIn(mail, VERIFY_RE)));
  const login = await api('/api/auth/login', { method: 'POST', body: { username, password: 'secret123' } });
  return { username, email, token: login.data.token, id: login.data.user.id };
}

// A logged-in socket that records every event it receives.
function connect(user) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, { auth: { token: user.token }, transports: ['websocket'], forceNew: true });
    s.events = [];
    s.onAny((ev, data) => s.events.push({ ev, data }));
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
async function waitEvent(s, ev, pred = () => true, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const hit = s.events.find((e) => e.ev === ev && pred(e.data));
    if (hit || Date.now() > end) return hit ? hit.data : null;
    await sleep(50);
  }
}
const chatTexts = (s) => s.events.filter((e) => e.ev === 'guild-chat-message').map((e) => e.data.message);
const lastHistory = (s) => [...s.events].reverse().find((e) => e.ev === 'guild-chat-history')?.data;

// ── server config ──
const cfg = (await api('/api/client-config')).data;
check('server reports email configured', cfg.email === true, JSON.stringify(cfg));
check('server reports which social logins exist', cfg.oauth && typeof cfg.oauth.google === 'boolean');

// ── register + email verification ──
const alice = { username: `alice_${RUN}`, email: `Alice_${RUN}@Example.test` };
let r = await api('/api/auth/register', { method: 'POST', body: { username: alice.username, email: alice.email, password: 'secret123' } });
check('register asks to verify the email', r.status === 200 && r.data.requiresVerification === true && !r.data.token && r.data.email === alice.email, JSON.stringify(r.data));
r = await api('/api/auth/register', { method: 'POST', body: { username: alice.username.toUpperCase(), email: `x${alice.email}`, password: 'secret123' } });
check('username is unique regardless of case', r.status === 400 && /taken/.test(r.data.error), JSON.stringify(r.data));
r = await api('/api/auth/register', { method: 'POST', body: { username: `a2_${RUN}`, email: alice.email.toLowerCase(), password: 'secret123' } });
check('email is unique regardless of case', r.status === 400 && /registered/.test(r.data.error), JSON.stringify(r.data));
r = await api('/api/auth/register', { method: 'POST', body: { username: 'ab', email: 'bad', password: '1' } });
check('register validates its fields', r.status === 400);

let mails = await waitMail(alice.email, 1);
const firstVerify = linkIn(mails[0], VERIFY_RE);
check('verification email arrives with a link to APP_URL', !!firstVerify && firstVerify.startsWith('http://localhost:3000/'), firstVerify || mails[0]?.subject);

r = await api('/api/auth/login', { method: 'POST', body: { username: alice.username, password: 'secret123' } });
check('login before verifying is refused with requiresVerification', r.status === 403 && r.data.requiresVerification && r.data.email, JSON.stringify(r.data));

r = await api('/api/auth/resend-verification', { method: 'POST', body: { email: alice.email } });
mails = await waitMail(alice.email, 2);
const secondVerify = linkIn(mails[1], VERIFY_RE);
check('resend sends a new verification email', r.status === 200 && !!secondVerify && secondVerify !== firstVerify);
r = await api(localPath(firstVerify));
check('the older verification link stops working after a resend', r.status === 302 && /email_verified=invalid/.test(r.headers.get('location')), r.headers.get('location'));
r = await api(localPath(secondVerify));
check('the verification link verifies the account', r.status === 302 && /email_verified=success/.test(r.headers.get('location')), r.headers.get('location'));
r = await api(localPath(secondVerify));
check('a verification link works only once', /email_verified=invalid/.test(r.headers.get('location') || ''));

// ── login ──
r = await api('/api/auth/login', { method: 'POST', body: { username: alice.username.toUpperCase(), password: 'secret123' } });
check('login works (username is case-insensitive)', r.status === 200 && !!r.data.token, JSON.stringify(r.data).slice(0, 120));
alice.token = r.data.token; alice.id = r.data.user?.id;
r = await api('/api/auth/login', { method: 'POST', body: { username: alice.email.toLowerCase(), password: 'secret123' } });
check('login with the email address works too', r.status === 200 && !!r.data.token);
r = await api('/api/auth/login', { method: 'POST', body: { username: alice.username, password: 'wrong-pass' } });
check('wrong password is refused', r.status === 401);
r = await api('/api/auth/me', { token: alice.token });
check('/me returns the account without its password hash', r.status === 200 && r.data.user.username === alice.username && !('password_hash' in r.data.user));
r = await api('/api/auth/me', { token: 'not-a-token' });
check('/me refuses a bad token', r.status === 401);

// ── forgot / reset password ──
r = await api('/api/auth/forgot-password', { method: 'POST', body: { email: alice.email.toUpperCase() } });
check('forgot password answers generically', r.status === 200 && /If an account/.test(r.data.message));
mails = await waitMail(alice.email, 3);
const reset1 = linkIn(mails[2], RESET_RE);
check('reset email arrives with a /reset-password link', !!reset1, mails[2]?.subject);
await api('/api/auth/forgot-password', { method: 'POST', body: { email: alice.email } });
mails = await waitMail(alice.email, 4);
const reset2 = linkIn(mails[3], RESET_RE);
const page = await api(localPath(reset2));
check('the reset page loads', page.status === 200 && /id="btnReset"/.test(page.data));
const token2 = new URL(reset2).searchParams.get('token');
r = await api('/api/auth/reset-password', { method: 'POST', body: { token: token2, newPassword: '123' } });
check('reset refuses a short password', r.status === 400);
r = await api('/api/auth/reset-password', { method: 'POST', body: { token: token2, newPassword: 'brandnew456' } });
check('reset with the link sets the new password', r.status === 200, JSON.stringify(r.data));
r = await api('/api/auth/reset-password', { method: 'POST', body: { token: token2, newPassword: 'again789' } });
check('a reset link works only once', r.status === 400);
r = await api('/api/auth/reset-password', { method: 'POST', body: { token: new URL(reset1).searchParams.get('token'), newPassword: 'again789' } });
check('older reset links stop working after a reset', r.status === 400);
r = await api('/api/auth/login', { method: 'POST', body: { username: alice.username, password: 'secret123' } });
check('the old password no longer works', r.status === 401);
r = await api('/api/auth/login', { method: 'POST', body: { username: alice.username, password: 'brandnew456' } });
check('the new password works', r.status === 200);
alice.token = r.data.token;
const before = (await mailsTo('nobody_')).length;
r = await api('/api/auth/forgot-password', { method: 'POST', body: { email: `nobody_${RUN}@example.test` } });
await sleep(500);
check('forgot password for an unknown email: same answer, no email', r.status === 200 && (await mailsTo('nobody_')).length === before);

// ── guilds + chat ──
const bob = await makeUser('bob');
const carol = await makeUser('carol');
const dave = await makeUser('dave');
const [sa, sb, sc, sd] = await Promise.all([alice, bob, carol, dave].map(connect));

r = await api('/api/guilds', { method: 'POST', token: alice.token, body: { name: `Wolves ${RUN}`, tag: `W${RUN.slice(0, 3)}`.toUpperCase(), description: 'test', color: '#3c8cdc', isOpen: false } });
check('create a guild', r.status === 200 && r.data.guild?.id, JSON.stringify(r.data));
const gid = r.data.guild.id;
const gtag = r.data.guild.tag;
check('the creator joins the guild chat at once', !!(await waitEvent(sa, 'guild-chat-history')));
r = await api('/api/guilds', { method: 'POST', token: alice.token, body: { name: `Other ${RUN}`, tag: 'OTHR' } });
check('cannot create a second guild while in one', r.status === 400);

r = await api(`/api/guilds/${gid}/invite`, { method: 'POST', token: alice.token, body: { username: bob.username } });
check('leader invites a player', r.status === 200);
const inv = await waitEvent(sb, 'guild-invite');
check('the invited player is notified live', inv && inv.guildTag === gtag, JSON.stringify(inv));
r = await api('/api/guilds/me/invites', { token: bob.token });
check('the invite is listed', r.data.invites?.length === 1);
r = await api(`/api/guilds/invites/${r.data.invites[0].id}/respond`, { method: 'POST', token: bob.token, body: { accept: true } });
check('accept the invite', r.status === 200 && r.data.accepted === true);
check('the new member gets the chat without reloading', !!(await waitEvent(sb, 'guild-chat-history')));
check('the others see the new member come online', !!(await waitEvent(sa, 'guild-member-online', (d) => d.userId === bob.id)));

sa.emit('guild-chat', { message: 'hello <3 & welcome' });
const got = await waitEvent(sb, 'guild-chat-message');
check('chat reaches guild members, text unchanged', got && got.message === 'hello <3 & welcome' && got.userId === alice.id, JSON.stringify(got));
await sleep(300);
check('chat does not reach players outside the guild', chatTexts(sc).length === 0 && chatTexts(sd).length === 0);
sa.emit('guild-chat', { message: 'second message too fast' });
check('chat is rate-limited', !!(await waitEvent(sa, 'guild-chat-error')));

r = await api(`/api/guilds/${gid}/join`, { method: 'POST', token: carol.token });
check('cannot join a closed guild directly', r.status === 403);
r = await api(`/api/guilds/${gid}/request`, { method: 'POST', token: carol.token });
check('request to join a closed guild', r.status === 200);
r = await api(`/api/guilds/${gid}/request`, { method: 'POST', token: carol.token });
check('no duplicate join requests', r.status === 400);
r = await api(`/api/guilds/${gid}/requests`, { token: bob.token });
check('a plain member cannot see join requests', r.status === 403);
r = await api(`/api/guilds/${gid}/requests`, { token: alice.token });
check('the leader sees the join request', r.data.requests?.length === 1 && r.data.requests[0].username === carol.username);
r = await api(`/api/guilds/requests/${r.data.requests[0].id}/respond`, { method: 'POST', token: alice.token, body: { accept: true } });
check('the leader accepts the request', r.status === 200);
const acc = await waitEvent(sc, 'guild-update', (d) => d.type === 'accepted');
check('the requester is told live, with the guild id', acc && acc.guildId === gid, JSON.stringify(acc));
const hist = await waitEvent(sc, 'guild-chat-history');
check('the requester gets the chat history without reloading', Array.isArray(hist) && hist.some((m) => m.message === 'hello <3 & welcome'), JSON.stringify(hist));
await sleep(1100);
sc.emit('guild-chat', { message: 'carol here' });
check('the accepted member can chat with the guild', !!(await waitEvent(sa, 'guild-chat-message', (m) => m.message === 'carol here')));

r = await api(`/api/guilds/${gid}/promote`, { method: 'POST', token: bob.token, body: { userId: carol.id, role: 'officer' } });
check('only the leader can promote', r.status === 403);
r = await api(`/api/guilds/${gid}/promote`, { method: 'POST', token: alice.token, body: { userId: String(bob.id), role: 'officer' } });
check('the leader promotes a member to officer', r.status === 200, JSON.stringify(r.data));
r = await api(`/api/guilds/${gid}/kick`, { method: 'POST', token: bob.token, body: { userId: alice.id } });
check('an officer cannot kick the leader', r.status === 403);
r = await api(`/api/guilds/${gid}/kick`, { method: 'POST', token: bob.token, body: { userId: carol.id } });
check('an officer kicks a member', r.status === 200, JSON.stringify(r.data));
check('the kicked player is told live', !!(await waitEvent(sc, 'guild-update', (d) => d.type === 'kicked')));
check('the kicked player\'s chat is cleared', Array.isArray(lastHistory(sc)) && lastHistory(sc).length === 0);
const aliceCount = chatTexts(sa).length;
await sleep(1100);
sc.emit('guild-chat', { message: 'still here?' });
await sleep(600);
check('a kicked player can no longer chat to the guild', chatTexts(sa).length === aliceCount);
sa.emit('guild-chat', { message: 'after the kick' });
await waitEvent(sb, 'guild-chat-message', (m) => m.message === 'after the kick');
check('a kicked player no longer receives the guild chat', !chatTexts(sc).includes('after the kick'));

r = await api(`/api/guilds/${gid}`, { method: 'PUT', token: alice.token, body: { isOpen: true, description: 'now open' } });
check('the leader edits the guild settings', r.status === 200);
r = await api(`/api/guilds/open?search=${encodeURIComponent(gtag)}`);
check('the open guild is listed', r.data.guilds?.some((g) => g.id === gid));
r = await api(`/api/guilds/${gid}/join`, { method: 'POST', token: dave.token });
check('join an open guild', r.status === 200);
check('the joiner gets the chat without reloading', !!(await waitEvent(sd, 'guild-chat-history')));

r = await api(`/api/guilds/${gid}/leave`, { method: 'POST', token: bob.token });
check('a member leaves', r.status === 200);
await sleep(1100);
sa.emit('guild-chat', { message: 'after bob left' });
await waitEvent(sd, 'guild-chat-message', (m) => m.message === 'after bob left');
check('a player who left no longer receives the guild chat', !chatTexts(sb).includes('after bob left'));

// ── guild wars: only a challenge that was sent can be accepted ──
r = await api('/api/guilds', { method: 'POST', token: carol.token, body: { name: `Rivals ${RUN}`, tag: `R${RUN.slice(0, 3)}`.toUpperCase() } });
check('a second guild is created', r.status === 200);
const rivalId = r.data.guild.id;
sa.emit('guild-war-accept', { challengerGuildId: rivalId, teamSize: 5 });
const refused = await waitEvent(sa, 'notification', (d) => /expired/.test(d.message));
check('accepting a challenge that was never sent is refused', !!refused && !(await waitEvent(sa, 'guild-war-matched', () => true, 300)));
sc.emit('guild-war-challenge', { tag: gtag, teamSize: 2 });
const ch = await waitEvent(sa, 'guild-war-challenge-received');
check('the challenged guild receives the challenge', ch && ch.challengerGuild.id === rivalId && ch.teamSize === 2, JSON.stringify(ch));
sa.emit('guild-war-accept', { challengerGuildId: rivalId, teamSize: 5 });
const matched = await waitEvent(sa, 'guild-war-matched');
check('accepting a real challenge creates the war, at the challenged size', matched && matched.teamSize === 2, JSON.stringify(matched));

// ── disband ──
r = await api(`/api/guilds/${gid}`, { method: 'DELETE', token: dave.token });
check('only the leader can disband', r.status === 403);
r = await api(`/api/guilds/${gid}`, { method: 'DELETE', token: alice.token });
check('the leader disbands the guild', r.status === 200, JSON.stringify(r.data));
check('members are told the guild was disbanded', !!(await waitEvent(sd, 'guild-update', (d) => d.type === 'disbanded')));
r = await api('/api/auth/me', { token: dave.token });
check('members are guildless afterwards', r.data.user.guild_id === null);

// ── one connection per account ──
const sa2 = await connect(alice);
await sleep(500);
check('logging in elsewhere disconnects the older connection', !sa.connected && sa2.connected);

// ── rate limit on reset emails ──
let limited = null;
for (let i = 0; i < 8 && !limited; i++) {
  r = await api('/api/auth/forgot-password', { method: 'POST', body: { email: dave.email } });
  if (r.status === 429) limited = r;
}
check('password-reset emails are rate-limited', !!limited && limited.headers.get('retry-after') && /try again/.test(limited.data.error), limited ? limited.data.error : 'never limited');

[sa, sa2, sb, sc, sd].forEach((s) => s.close());
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
