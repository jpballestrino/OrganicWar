import { login, register, fetchProfile, logout, isLoggedIn, getUser, getToken, setToken, setUser } from './auth.js';
import { socket } from './network.js';
import { updateGuildChatVisibility } from './guildUI.js';

function getE(id) { return document.getElementById(id); }

export async function initAuthUI() {
  const stateAuth = getE('homeStateAuth');
  const stateGuest = getE('homeStateGuest');

  // --- OAuth callback: detect token/user in URL params ---
  const urlParams = new URLSearchParams(window.location.search);
  const oauthToken = urlParams.get('token');
  const oauthUser = urlParams.get('user');
  const oauthError = urlParams.get('oauth_error');

  if (oauthToken && oauthUser) {
    setToken(oauthToken);
    setUser(JSON.parse(decodeURIComponent(oauthUser)));
    window.history.replaceState({}, '', '/'); // Clean URL
    setupLoggedInState();
    return; // Skip rest of init – user is now logged in
  }
  if (oauthError) {
    window.history.replaceState({}, '', '/');
    setTimeout(() => {
      const el = getE('loginError');
      if (el) { el.textContent = decodeURIComponent(oauthError); el.classList.add('visible'); }
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
    const email = getE('forgotEmail').value;
    if (!email) {return showError('forgotError', 'Enter your email');}
    try {
      getE('btnForgotSubmit').style.opacity = '0.5';
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      getE('forgotSuccess').textContent = data.message;
      getE('forgotSuccess').style.display = 'block';
    } catch (e) {
      showError('forgotError', 'Failed to send reset email');
    } finally {
      getE('btnForgotSubmit').style.opacity = '1';
    }
  });

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
      await register(username, email, password);
      await setupLoggedInState();
    } catch(e) {
      showError('regError', e.message);
    } finally {
      getE('btnRegSubmit').style.opacity = '1';
    }
  });

  // Logout
  getE('linkLogout').addEventListener('click', (e) => {
    e.preventDefault();
    logout();
  });

  // Tutorial Modal
  getE('linkTutorial').addEventListener('click', (e) => {
    e.preventDefault();
    const tModal = getE('tutorialModal');
    if (tModal) {tModal.style.display = 'block';}
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
  const user = getUser();
  getE('homeStateAuth').style.display = 'none';
  getE('homeStateGuest').style.display = 'none';
  getE('homeStateLoggedIn').style.display = 'block';

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
    
  const footerLinks = document.querySelectorAll('.auth-footer-links');
  footerLinks.forEach(l => l.style.display = 'inline');

  getE('nicknameInput').value = user.displayName || user.display_name;

  // Refresh socket connection so it sends auth token
  socket.disconnect();
  socket.auth = { token: getToken() };
  socket.connect();
    
  updateGuildChatVisibility();
}

function setupLoggedOutState() {
  getE('homeStateAuth').style.display = 'block';
  getE('homeStateGuest').style.display = 'none';
  getE('homeStateLoggedIn').style.display = 'none';
    
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

function renderProfileModal({ profile, history }) {
  getE('profileDisplayName').textContent = profile.display_name;
  getE('profileUsername').textContent = `@${profile.username}`;
  getE('profileWins').textContent = profile.total_wins;
  getE('profileLosses').textContent = profile.total_losses;
  getE('profileGames').textContent = profile.total_games;
  getE('profileEloRating').textContent = `${profile.elo_rating} ELO`;
    
  if (profile.guild_name) {
    const badge = getE('profileGuildBadge');
    badge.textContent = `[${profile.guild_tag}] ${profile.guild_name}`;
    badge.style.display = 'block';
  } else {
    getE('profileGuildBadge').style.display = 'none';
  }
    
  let rankTier = 'Bronze';
  let rankColor = '#cd7f32';
  if (profile.elo_rating >= 1800) { rankTier = 'Diamond'; rankColor = '#b9f2ff'; }
  else if (profile.elo_rating >= 1500) { rankTier = 'Platinum'; rankColor = '#e5e4e2'; }
  else if (profile.elo_rating >= 1300) { rankTier = 'Gold'; rankColor = '#ffd700'; }
  else if (profile.elo_rating >= 1100) { rankTier = 'Silver'; rankColor = '#c0c0c0'; }
    
  const rankEl = getE('profileRankTier');
  rankEl.textContent = rankTier;
  rankEl.style.color = rankColor;
    
  let winRate = profile.total_games > 0 ? Math.round((profile.total_wins / profile.total_games) * 100) : 0;
  getE('profileWinRateText').textContent = `${winRate}%`;
  getE('profileWinRateBar').style.width = `${winRate}%`;
    
  const historyList = getE('profileHistoryList');
  historyList.innerHTML = '';
    
  if (!history || history.length === 0) {
    historyList.innerHTML = '<div style="text-align: center; color: #666; font-size: 13px; padding: 10px;">No recent matches found.</div>';
    return;
  }
    
  history.forEach(match => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.justifyContent = 'space-between';
    row.style.padding = '8px 10px';
    row.style.background = 'rgba(255,255,255,0.03)';
    row.style.borderRadius = '4px';
    row.style.fontSize = '12px';
        
    let isWin = match.result === 'win';
    let resColor = isWin ? '#4ade80' : (match.result === 'loss' ? '#f87171' : '#9ca3af');
    let resText = isWin ? 'W' : (match.result === 'loss' ? 'L' : 'A');
        
    const dateStr = new Date(match.played_at).toLocaleDateString();
        
    row.innerHTML = `
            <div style="display:flex; gap: 10px; align-items: center;">
                <span style="font-weight: bold; color: ${resColor}; width: 15px; text-align: center;">${resText}</span>
                <span style="color: #ccc;">${dateStr}</span>
            </div>
            <div style="display:flex; gap: 15px; color: #888;">
                <span>${match.duration_seconds}s</span>
                <span style="color: #ffc107;">${match.cells_conquered} cells</span>
            </div>
        `;
    historyList.appendChild(row);
  });
}
