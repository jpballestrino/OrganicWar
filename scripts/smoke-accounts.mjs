// Browser check of the account and guild screens: register → verify by email
// → log in (Enter key, email address) → log out → forgot / reset password, and
// two players side by side using the Guild Hall and guild chat (invite,
// accept, chat, kick, open guild + join, disband), checking that every change
// shows up live, without a reload, and that the page logs no errors (CSP
// violations included).
//
// Needs Playwright (not a project dependency) and the server set up as in
// scripts/e2e-accounts.mjs (mail-catcher + SMTP_* pointing at it), on a
// throw-away DB_PATH, built client (`npm run build`).

import { createRequire } from 'module';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.URL || 'http://localhost:3000';
const MAIL = process.env.MAIL_URL || 'http://127.0.0.1:2526/mails';
const RUN = Date.now().toString(36).slice(-5);
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitMail(addr, n) {
  for (let i = 0; i < 60; i++) {
    const all = await (await fetch(MAIL)).json();
    const list = all.filter((m) => (m.to || '').toLowerCase().includes(addr.toLowerCase()));
    if (list.length >= n) return list;
    await sleep(100);
  }
  return [];
}
const link = (mail, re) => ((mail?.html || '').match(re) || [null])[0];

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function newPlayer() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|favicon|fonts\.g/.test(m.text())) errors.push(m.text());
  });
  page.on('dialog', (d) => d.accept()); // confirm() for kick / disband
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#homeStateAuth', { state: 'visible' });
  return { page, errors };
}
const visible = (page, sel) => page.locator(sel).isVisible();
const text = (page, sel) => page.locator(sel).innerText();

// Register through the form, verify through the emailed link, log in with the
// email address and Enter. Returns the account.
async function registerAndLogin(page, name) {
  const username = `${name}_${RUN}`;
  const email = `${username}@example.test`;
  await page.click('#tabRegister');
  await page.fill('#regUsername', username);
  await page.fill('#regEmail', email);
  await page.fill('#regPassword', 'secret123');
  await page.press('#regPassword', 'Enter');
  await page.waitForSelector('#homeStateVerification', { state: 'visible', timeout: 10000 });
  const [mail] = await waitMail(email, 1);
  await page.goto(link(mail, /https?:\/\/[^"'\s]+verify-email\?token=[0-9a-f]+/));
  await page.waitForSelector('#homeStateAuth', { state: 'visible' });
  const verifiedMsg = await page.locator('#loginError').innerText().catch(() => '');
  await page.fill('#loginUsername', email);
  await page.fill('#loginPassword', 'secret123');
  await page.press('#loginPassword', 'Enter');
  await page.waitForSelector('#homeStateLoggedIn', { state: 'visible', timeout: 10000 });
  return { username, email, verifiedMsg };
}

// ── accounts ──
const A = await newPlayer();
check('social login buttons are hidden when not configured',
  !(await visible(A.page, '#btnGoogleLogin')) && !(await visible(A.page, '#btnDiscordLogin')));
check('login field says username or email', /email/i.test(await A.page.getAttribute('#loginUsername', 'placeholder')));
check('register username box allows the server\'s max (15)', (await A.page.getAttribute('#regUsername', 'maxlength')) === '15');
const alice = await registerAndLogin(A.page, 'alice');
check('verification link → "Email verified" on the home screen', /verified/i.test(alice.verifiedMsg), alice.verifiedMsg);
check('logged in: welcome shows the name', (await text(A.page, '#lblWelcomeName')).includes(alice.username));

await A.page.click('#linkLogout');
await A.page.waitForSelector('#homeStateAuth', { state: 'visible' });
check('log out returns to the login screen', await visible(A.page, '#formLogin'));
await A.page.fill('#loginUsername', alice.username);
await A.page.fill('#loginPassword', 'wrong');
await A.page.press('#loginPassword', 'Enter');
await A.page.waitForSelector('#loginError.visible');
check('wrong password shows an error', /invalid/i.test(await text(A.page, '#loginError')));

await A.page.click('#linkForgotPassword');
await A.page.fill('#forgotEmail', alice.email);
await A.page.press('#forgotEmail', 'Enter');
await A.page.waitForSelector('#forgotSuccess', { state: 'visible' });
check('forgot password confirms', /reset link/i.test(await text(A.page, '#forgotSuccess')));
const resetMail = (await waitMail(alice.email, 2))[1];
await A.page.goto(link(resetMail, /https?:\/\/[^"'\s]+reset-password\?token=[0-9a-f]+/));
await A.page.fill('#newPassword', 'newpass99');
await A.page.fill('#confirmPassword', 'different');
await A.page.click('#btnReset');
check('reset page catches a mismatched confirmation', /match/i.test(await text(A.page, '#errorMsg')));
await A.page.fill('#confirmPassword', 'newpass99');
await A.page.press('#confirmPassword', 'Enter');
await A.page.waitForSelector('#successMsg', { state: 'visible' });
check('reset page sets the new password', true);
await A.page.goto(BASE);
await A.page.waitForSelector('#homeStateAuth', { state: 'visible' });
await A.page.fill('#loginUsername', alice.username);
await A.page.fill('#loginPassword', 'newpass99');
await A.page.click('#btnLoginSubmit');
await A.page.waitForSelector('#homeStateLoggedIn', { state: 'visible', timeout: 10000 });
check('log in with the new password', true);
await A.page.reload();
await A.page.waitForSelector('#homeStateLoggedIn', { state: 'visible', timeout: 10000 });
check('the session survives a page reload', true);

// ── guilds: create ──
const B = await newPlayer();
const bob = await registerAndLogin(B.page, 'bob');
check('no guild chat panel without a guild', !(await visible(A.page, '#guildChatPanel')));
await A.page.click('#btn-guild-hall');
await A.page.waitForSelector('#guildViewNoGuild', { state: 'visible' });
const tag = `G${RUN.slice(0, 3)}`.toUpperCase();
await A.page.fill('#cgName', `Guild ${RUN}`);
await A.page.fill('#cgTag', tag.toLowerCase());
check('guild tag input upper-cases', (await A.page.inputValue('#cgTag')) === tag);
await A.page.click('#btnCreateGuildSubmit');
await A.page.waitForSelector('#guildViewInGuild', { state: 'visible', timeout: 10000 });
check('creating a guild opens its page', (await text(A.page, '#guildTitleText')).includes(tag));
check('the header shows the guild tag', (await text(A.page, '#lblGuild')).includes(tag));
check('the guild chat panel appears', await visible(A.page, '#guildChatPanel'));

// ── invite → accept ──
await A.page.click('#tabGuildSettings');
await A.page.click('#guildSettingsView >> text=Invite Player');
await A.page.fill('#inviteUsername', bob.username);
await A.page.click('#btnSendInvite');
await B.page.waitForSelector('#guildInviteBadge', { state: 'visible', timeout: 5000 });
check('the invited player sees the invite badge live', (await text(B.page, '#guildInviteBadge')) === '1');
await B.page.click('#btn-guild-hall');
await B.page.click('#tabPendingInvites');
await B.page.click('#guildInvitesList >> text=Accept');
await B.page.waitForSelector('#guildViewInGuild', { state: 'visible', timeout: 10000 });
check('accepting shows the guild page', (await text(B.page, '#guildMemberList')).includes(alice.username));
check('…and the chat panel, without a reload', await visible(B.page, '#guildChatPanel'));
await B.page.click('#btn-close-guild-hall');

// ── chat both ways ──
await A.page.click('#btn-close-guild-hall');
await A.page.fill('#guildChatInput', 'hi bob <3 & co');
await A.page.press('#guildChatInput', 'Enter');
await B.page.waitForSelector('#guildChatMessages >> text=hi bob <3 & co', { timeout: 5000 }).catch(() => {});
check('chat arrives, text exactly as typed', (await text(B.page, '#guildChatMessages')).includes('hi bob <3 & co'));
await B.page.fill('#guildChatInput', 'hey alice');
await B.page.press('#guildChatInput', 'Enter');
await A.page.waitForSelector('#guildChatMessages >> text=hey alice', { timeout: 5000 }).catch(() => {});
check('chat back the other way', (await text(A.page, '#guildChatMessages')).includes('hey alice'));
check('own messages are styled as mine', await A.page.locator('#guildChatMessages .chat-msg.self').count() === 1);

// ── kick (live, without the Guild Hall open on the kicked side) ──
await A.page.click('#btn-guild-hall');
await A.page.click('#tabGuildRoster');
await A.page.click('#guildMemberList >> text=Kick');
await sleep(1000);
check('the leader sees the member gone', !(await text(A.page, '#guildMemberList')).includes(bob.username));
check('the kicked player\'s chat panel closes live', !(await visible(B.page, '#guildChatPanel')));
check('the kicked player\'s header drops the guild tag', !(await visible(B.page, '#lblGuild')));

// ── open the guild, join from the list ──
await A.page.click('#tabGuildSettings');
await A.page.click('#guildSettingsView >> text=Edit Settings');
await A.page.check('#egIsOpen');
await A.page.click('#btnSaveGuildEdit');
await sleep(500);
await B.page.click('#btn-guild-hall');
await B.page.click('#tabSearchGuilds');
await B.page.fill('#searchInputGuilds', tag);
await B.page.waitForSelector(`#guildSearchResults >> text=[${tag}]`, { timeout: 5000 }).catch(() => {});
await B.page.click('#guildSearchResults >> text=Join');
await B.page.waitForSelector('#guildViewInGuild', { state: 'visible', timeout: 10000 });
check('join an open guild from the list', await visible(B.page, '#guildChatPanel'));
check('the chat history is there after joining', (await text(B.page, '#guildChatMessages')).includes('hey alice'));
await B.page.click('#btn-close-guild-hall');

// ── disband ──
await A.page.click('#tabGuildSettings');
await A.page.click('#guildSettingsView >> text=Disband Guild');
await A.page.waitForSelector('#guildViewNoGuild', { state: 'visible', timeout: 10000 });
check('disbanding returns the leader to "no guild"', !(await visible(A.page, '#guildChatPanel')));
await sleep(800);
check('members see the guild gone live', !(await visible(B.page, '#guildChatPanel')) && !(await visible(B.page, '#lblGuild')));

check('no page errors (player A)', A.errors.length === 0, A.errors.slice(0, 3).join(' | '));
check('no page errors (player B)', B.errors.length === 0, B.errors.slice(0, 3).join(' | '));

await browser.close();
if (failures.length) { console.log(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log('\nAll checks passed.');
