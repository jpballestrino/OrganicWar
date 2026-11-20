import { login, register, fetchProfile, logout, isLoggedIn, getUser, getToken, setToken, setUser } from './auth.js';
import { setServerMode, renderProgressCards } from './progression.js';
import { socket, socketAuth } from './network.js';
import { updateGuildChatVisibility } from './guildUI.js';
import { escapeHtml } from './escape.js';
import { tierFor, MODE_LABELS, ordinal } from './ranks.js';

function getE(id) { return document.getElementById(id); }

export async function initAuthUI() {
  const stateAuth = getE('homeStateAuth');
  const stateGuest = getE('homeStateGuest');

  // --- URL param callbacks (OAuth, email verification) ---
  const urlParams = new URLSearchParams(window.location.search);
  const oauthToken = urlParams.get('token');
  const oauthUser = urlParams.get('user');
  const oauthError = urlParams.get('oauth_error');
  const emailVerified = urlParams.get('email_verified');

  if (oauthToken && oauthUser) {
    setToken(oauthToken);
    setUser(JSON.parse(decodeURIComponent(oauthUser)));
    window.history.replaceState({}, '', '/');
    setupLoggedInState();
    return;
  }
  if (oauthError) {
    window.history.replaceState({}, '', '/');
    setTimeout(() => {
      const el = getE('loginError');
      if (el) { el.textContent = decodeURIComponent(oauthError); el.classList.add('visible'); }
    }, 100);
  }
  if (emailVerified === 'success') {
    window.history.replaceState({}, '', '/');
    setTimeout(() => {
      const el = getE('loginError');
      if (el) {
        el.textContent = 'Email verified! You can now log in.';
        el.style.color = '#4ade80';
        el.classList.add('visible');
        setTimeout(() => { el.classList.remove('visible'); el.style.color = ''; }, 5000);
      }
    }, 100);
  }
  if (emailVerified === 'invalid') {
    window.history.replaceState({}, '', '/');
    setTimeout(() => {
      const el = getE('loginError');
      if (el) { el.textContent = 'Verification link is invalid or expired.'; el.classList.add('visible'); }
    }, 100);
  }

  const tabLogin = getE('tabLogin');
  const tabRegister = getE('tabRegister');
  const formLogin = getE('formLogin');
  const formRegister = getE('formRegister');

  // Tab Switching
  tabLogin.addEventListener('click', () => {
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    formLogin.classList.add('active');
    formRegister.classList.remove('active');
    getE('forgotPasswordForm').style.display = 'none';
    formLogin.style.display = '';
  });

  tabRegister.addEventListener('click', () => {
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    formRegister.classList.add('active');
    formLogin.classList.remove('active');
    getE('forgotPasswordForm').style.display = 'none';
    formLogin.style.display = '';
  });

  // Play as Guest
  getE('linkGuest').addEventListener('click', (e) => {
    e.preventDefault();
    stateAuth.style.display = 'none';
    stateGuest.style.display = 'block';
  });

  getE('linkBackToAuth').addEventListener('click', (e) => {
    e.preventDefault();
    stateGuest.style.display = 'none';
    stateAuth.style.display = 'block';
  });

  // --- OAuth Buttons ---
  getE('btnGoogleLogin').addEventListener('click', () => {
    window.location.href = '/api/auth/google';
  });
  getE('btnDiscordLogin').addEventListener('click', () => {
    window.location.href = '/api/auth/discord';
  });

  // Display Error function
  const showError = (elId, msg) => {
    const el = getE(elId);
    el.textContent = msg;
    el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 5000);
  };

  // --- Forgot Password UI ---
  getE('linkForgotPassword').addEventListener('click', (e) => {
    e.preventDefault();
    getE('formLogin').style.display = 'none';
    getE('forgotPasswordForm').style.display = 'block';
  });
  getE('linkBackToLogin').addEventListener('click', (e) => {
    e.preventDefault();
    getE('forgotPasswordForm').style.display = 'none';
    getE('formLogin').style.display = '';
  });
  getE('btnForgotSubmit').addEventListener('click', async () => {
    const email = getE('forgotEmail').value.trim();
    getE('forgotSuccess').style.display = 'none';
    if (!email) {return showError('forgotError', 'Enter your email');}
    try {
      getE('btnForgotSubmit').style.opacity = '0.5';
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {return showError('forgotError', data.error || 'Failed to send reset email');}
      getE('forgotSuccess').textContent = data.message;
      getE('forgotSuccess').style.display = 'block';
    } catch (e) {
      showError('forgotError', 'Failed to send reset email');
    } finally {
      getE('btnForgotSubmit').style.opacity = '1';
    }
  });

  // --- Verification pending state ---
  let pendingVerifyEmail = '';

  function showVerificationState(email) {
    pendingVerifyEmail = email || '';
    getE('homeStateAuth').style.display = 'none';
    getE('homeStateGuest').style.display = 'none';
    const stateVerify = getE('homeStateVerification');
    if (stateVerify) {
      stateVerify.style.display = 'block';
      const lbl = getE('verifyEmailDisplay');
      if (lbl) { lbl.textContent = email || ''; }
      const msg = getE('verifyResendMsg');
      if (msg) { msg.style.display = 'none'; }
    }
  }

  const btnResend = getE('btnResendVerification');
  if (btnResend) {
    btnResend.addEventListener('click', async () => {
      btnResend.style.opacity = '0.5';
      try {
        await fetch('/api/auth/resend-verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: pendingVerifyEmail }),
        });
        const msg = getE('verifyResendMsg');
        if (msg) { msg.style.display = 'block'; }
      } catch (_) { /* silent */ } finally {
        btnResend.style.opacity = '1';
      }
    });
  }

  const linkBackFromVerify = getE('linkBackFromVerify');
  if (linkBackFromVerify) {
    linkBackFromVerify.addEventListener('click', (e) => {
      e.preventDefault();
      const stateVerify = getE('homeStateVerification');
      if (stateVerify) { stateVerify.style.display = 'none'; }
      setupLoggedOutState();
    });
  }

  // Forms Submission
  getE('btnLoginSubmit').addEventListener('click', async () => {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;

    if (!username || !password) {return showError('loginError', 'Username and password required.');}

    try {
      getE('btnLoginSubmit').style.opacity = '0.5';
      await login(username, password);
      await setupLoggedInState();
    } catch(e) {
      if (e.requiresVerification) {
        showVerificationState(e.email);
        return;
      }
      showError('loginError', e.message);
    } finally {
      getE('btnLoginSubmit').style.opacity = '1';
    }
  });

  getE('btnRegSubmit').addEventListener('click', async () => {
    const username = document.getElementById('regUsername').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;

    if (!username || !email || !password) {return showError('regError', 'All fields required.');}

    try {
      getE('btnRegSubmit').style.opacity = '0.5';
      const result = await register(username, email, password);
      if (result && result.requiresVerification) {
        showVerificationState(result.email);
        return;
      }
      await setupLoggedInState();
    } catch(e) {
      showError('regError', e.message);
    } finally {
      getE('btnRegSubmit').style.opacity = '1';
    }
  });

  // Enter submits the visible form (login, register, forgot password).
  const submitOnEnter = (inputIds, buttonId) => inputIds.forEach((id) => {
    getE(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); getE(buttonId).click(); }
    });
  });
  submitOnEnter(['loginUsername', 'loginPassword'], 'btnLoginSubmit');
  submitOnEnter(['regUsername', 'regEmail', 'regPassword'], 'btnRegSubmit');
  submitOnEnter(['forgotEmail'], 'btnForgotSubmit');

  // Hide the Google / Discord buttons when the server has no keys for them
  // (they would only lead to "not enabled on this server").
  fetch('/api/client-config', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (!cfg || !cfg.oauth) {return;}
      getE('btnGoogleLogin').style.display = cfg.oauth.google ? '' : 'none';
      getE('btnDiscordLogin').style.display = cfg.oauth.discord ? '' : 'none';
      if (!cfg.oauth.google && !cfg.oauth.discord) {
        document.querySelectorAll('.auth-oauth-divider, .auth-oauth-buttons').forEach((el) => { el.style.display = 'none'; });
      }
    })
    .catch(() => {});

  // Logout
  getE('linkLogout').addEventListener('click', (e) => {
    e.preventDefault();
    logout();
  });

  // Tutorial Modal
  getE('linkTutorial').addEventListener('click', (e) => {
    e.preventDefault();
    const tModal = getE('tutorialModal');
    if (tModal) {tModal.style.display = 'flex';}
  });

  const btnCloseTutorial = getE('btnCloseTutorial');
  if (btnCloseTutorial) {
    btnCloseTutorial.addEventListener('click', () => {
      getE('tutorialModal').style.display = 'none';
    });
  }

  // Profile Modal
  const profileModal = getE('profileModal');
  getE('linkProfile').addEventListener('click', async (e) => {
    e.preventDefault();
    const user = getUser();
    if (!user) {return;}
    await showUserProfile(user.username);
  });

  getE('btn-close-profile').addEventListener('click', () => {
    profileModal.style.opacity = 0;
    setTimeout(() => profileModal.style.display = 'none', 300);
  });

  // Check initial state
  if (isLoggedIn()) {
    const user = await fetchProfile(); // Validate token
    if (user) {
      setupLoggedInState();
    } else {
      setupLoggedOutState();
    }
  } else {
    setupLoggedOutState();
  }
}

export async function setupLoggedInState() {
  getE('homeStateAuth').style.display = 'none';
  getE('homeStateGuest').style.display = 'none';
  getE('homeStateLoggedIn').style.display = 'block';
  const sv = getE('homeStateVerification');
  if (sv) { sv.style.display = 'none'; }

  renderAccountHeader();

  const footerLinks = document.querySelectorAll('.auth-footer-links');
  footerLinks.forEach(l => l.style.display = 'inline');
  const footerAuthRow = document.querySelector('.home-footer-auth-row');
  if (footerAuthRow) footerAuthRow.style.display = 'flex';

  getE('nicknameInput').value = getUser().displayName || getUser().display_name;

  // Refresh socket connection so it sends auth token (the server then pushes
  // this account's progression — show "loading" instead of the guest profile).
  setServerMode(true);
  renderProgressCards();
  socket.disconnect();
  socket.auth = socketAuth();
  socket.connect();

  updateGuildChatVisibility();
}

// The logged-in header (name, ELO, guild tag) from the stored user. Used on
// login and whenever the guild changes (no reconnect needed then: the server
// moves the socket between guild chat rooms itself).
export function renderAccountHeader() {
  const user = getUser();
  if (!user) {return;}
  getE('lblWelcomeName').textContent = `Welcome, ${user.displayName || user.display_name}`;
  getE('lblElo').textContent = `ELO: ${user.eloRating !== undefined ? user.eloRating : user.elo_rating}`;
    
  const lblGuild = getE('lblGuild');
  if (lblGuild) {
    if (user.guildTag) {
      lblGuild.textContent = `[${user.guildTag}] ${user.guildName || ''}`;
      lblGuild.style.display = 'inline-block';
    } else {
      lblGuild.style.display = 'none';
    }
  }
}

function setupLoggedOutState() {
  getE('homeStateAuth').style.display = 'block';
  getE('homeStateGuest').style.display = 'none';
  getE('homeStateLoggedIn').style.display = 'none';
  const sv = getE('homeStateVerification');
  if (sv) { sv.style.display = 'none'; }
    
  const footerLinks = document.querySelectorAll('.auth-footer-links');
  footerLinks.forEach(l => l.style.display = 'none');
    
  updateGuildChatVisibility();
}

export async function showUserProfile(username) {
  try {
    const profileModal = getE('profileModal');
    const res = await fetch(`/api/profile/${username}`, {
      headers: { 'Authorization': `Bearer ${getToken() || ''}` },
    });
    const data = await res.json();
    if (res.ok) {
      renderProfileModal(data);
      profileModal.style.display = 'flex';
      profileModal.style.opacity = 0;
      setTimeout(() => profileModal.style.opacity = 1, 10);
    } else {
      console.error('Profile fetch error:', data.error);
    }
  } catch(err) {
    console.error('Failed to load profile', err);
  }
}

// Profile: ranked first (tier, rating, position, record), then every mode
// (placements, kills, land), recent form and the last matches.
function renderProfileModal({ profile, history, stats = {} }) {
  const esc = (v) => escapeHtml(String(v ?? ''));
  const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');
  const num = (v) => Math.round(v || 0).toLocaleString('en-US');
  const box = (label, value, color = '#fff', title = '') =>
    `<div class="stat-box" title="${esc(title)}"><div class="stat-label">${esc(label)}</div><div class="stat-value" style="color:${color}">${esc(value)}</div></div>`;

  getE('profileDisplayName').textContent = profile.display_name;
  getE('profileUsername').textContent = `@${profile.username}`;
  const badge = getE('profileGuildBadge');
  if (profile.guild_name) {
    badge.textContent = `[${profile.guild_tag}] ${profile.guild_name}`;
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }

  // ── Ranked ──
  const r = stats.ranked;
  const games = r ? r.ranked_games : 0;
  const tier = tierFor(profile.elo_rating, games);
  const rankEl = getE('profileRankTier');
  rankEl.textContent = tier.name;
  rankEl.style.color = tier.color;
  getE('profileEloRating').textContent = games ? `${profile.elo_rating} rating` : 'Play ranked to get rated';
  getE('profilePosition').textContent = r ? `#${r.position} of ${r.ranked_players} ranked players` : '';
  getE('profileRankedStats').innerHTML = r ? [
    box('Ranked games', games, '#60a5fa'),
    box('Win rate', pct(r.ranked_wins, games), '#4ade80', 'Matches finished 1st among the human players'),
    box('Avg place', r.avg_place ? r.avg_place.toFixed(1) : '—', '#fbbf24', 'Average finishing place among the human players'),
    box('Wins', r.ranked_wins || 0, '#4ade80'),
    box('Peak rating', r.peak_rating, '#ffc107'),
    box('Rating', profile.elo_rating, tier.color),
  ].join('') : '<div class="profile-empty">No ranked matches yet.</div>';
  getE('profileTierProgress').textContent = r && tier.next
    ? `${tier.toNext} rating to ${tier.next.name}` : (r ? 'Top tier' : '');

  // ── All modes ──
  const o = stats.overall || {};
  getE('profileOverallStats').innerHTML = [
    box('Games', profile.total_games, '#60a5fa'),
    box('Victories', profile.total_wins, '#4ade80', 'Matches won outright'),
    box('Top 3', o.placed_games ? pct(o.top3, o.placed_games) : '—', '#4ade80', 'Share of matches finished in the top 3'),
    box('Avg place', o.avg_placement ? o.avg_placement.toFixed(1) : '—', '#fbbf24', 'Average finishing place among all factions'),
    box('Kills', num(profile.total_kills), '#f87171', 'Enemy troops destroyed, all matches'),
    box('Land taken', num(profile.total_cells_conquered), '#a78bfa', 'Cells held at the end of matches, all matches'),
  ].join('');

  // ── Recent form: last 10 placements, newest first ──
  const form = stats.form || [];
  getE('profileForm').innerHTML = form.length ? form.map((m) => {
    const place = m.mode === 'ranked' ? m.human_place : m.placement;
    const of = m.mode === 'ranked' ? m.humans : m.players;
    const cls = m.result === 'abandoned' ? 'quit' : place === 1 ? 'win' : (place && of && place <= Math.max(3, Math.ceil(of / 4))) ? 'good' : 'loss';
    const label = m.result === 'abandoned' ? 'Q' : (place ? ordinal(place) : '–');
    return `<span class="form-chip ${cls}" title="${esc(MODE_LABELS[m.mode] || m.mode)}${place ? ` · ${ordinal(place)} of ${of}` : ''}${m.elo_delta ? ` · ${m.elo_delta > 0 ? '+' : ''}${m.elo_delta}` : ''}">${esc(label)}</span>`;
  }).join('') : '<div class="profile-empty">No matches yet.</div>';

  // ── Recent matches ──
  const historyList = getE('profileHistoryList');
  if (!history || history.length === 0) {
    historyList.innerHTML = '<div class="profile-empty">No recent matches found.</div>';
    return;
  }
  historyList.innerHTML = history.map((m) => {
    const ranked = m.mode === 'ranked';
    const place = ranked ? m.human_place : m.placement;
    const of = ranked ? m.humans : m.players;
    const res = m.result === 'win' ? ['W', '#4ade80'] : m.result === 'abandoned' ? ['Q', '#9ca3af'] : ['L', '#f87171'];
    const delta = ranked && m.elo_delta ? `<span style="color:${m.elo_delta > 0 ? '#4ade80' : '#f87171'}">${m.elo_delta > 0 ? '+' : ''}${m.elo_delta}</span>` : '';
    const dur = m.duration_seconds ? `${Math.floor(m.duration_seconds / 60)}:${String(m.duration_seconds % 60).padStart(2, '0')}` : '';
    return `<div class="profile-match">
        <span class="pm-res" style="color:${res[1]}">${res[0]}</span>
        <span class="pm-mode">${esc(MODE_LABELS[m.mode] || 'Match')}</span>
        <span class="pm-place">${place ? `${ordinal(place)}/${of}` : ''}</span>
        <span class="pm-delta">${delta}</span>
        <span class="pm-stat" title="Kills">⚔ ${num(m.kills)}</span>
        <span class="pm-stat" title="Land">▦ ${num(m.cells_conquered)}</span>
        <span class="pm-date">${dur} · ${new Date(`${m.played_at}Z`).toLocaleDateString()}</span>
      </div>`;
  }).join('');
}
