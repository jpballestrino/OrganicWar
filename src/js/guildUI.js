import { getUser, fetchProfile } from './auth.js';
import { setupLoggedInState } from './authUI.js';
import { socket } from './network.js';
import { escapeHtml } from './escape.js';
import 'emoji-picker-element';

const getE = id => document.getElementById(id);

export function showToast(message, type = 'info') {
  const container = document.getElementById('notificationContainer');
  if (!container) {return;}
  const toast = document.createElement('div');
  toast.className = `toast-notification ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode === container) {container.removeChild(toast);}
  }, 3000);
}

let currentGuildId = null;
let currentGuildRole = null;
let selectedColor = '#ffc107';
let onlineMembers = new Set();
let isCurrentlyInGame = false;

export function updateGuildChatVisibility() {
  const panel = getE('guildChatPanel');
  if (!panel) {return;}
    
  const user = getUser();
  const hasGuild = currentGuildId || (user && (user.guild_id || user.guildId || user.guildTag));
    
  if (hasGuild && !isCurrentlyInGame) {
    panel.style.display = 'flex';
  } else {
    panel.style.display = 'none';
  }
}

const FACTION_COLORS = [
  '#ffc107', '#dc3c3c', '#3c8cdc', '#3cc850', 
  '#dcb428', '#b43cdc', '#dc7828', '#28c8c8', '#dc50a0',
];

export function initGuildUI() {
  const cp = getE('cgColorPicker');
  const ecp = getE('egColorPicker');
  if (cp && ecp) {
    FACTION_COLORS.forEach(color => {
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch';
      swatch.style.backgroundColor = color;
      swatch.onclick = () => selectColor(color, 'cgColorPicker');
      cp.appendChild(swatch);
            
      const swatch2 = document.createElement('div');
      swatch2.className = 'color-swatch';
      swatch2.style.backgroundColor = color;
      swatch2.onclick = () => selectColor(color, 'egColorPicker');
      ecp.appendChild(swatch2);
    });
    selectColor(FACTION_COLORS[0], 'cgColorPicker');
    selectColor(FACTION_COLORS[0], 'egColorPicker');
  }

  getE('btn-guild-hall')?.addEventListener('click', openGuildHall);
  getE('btn-close-guild-hall')?.addEventListener('click', closeGuildHall);

  getE('tabCreateGuild')?.addEventListener('click', () => switchGuildTab('CreateGuild'));
  getE('tabSearchGuilds')?.addEventListener('click', () => { switchGuildTab('SearchGuilds'); loadGuildSearch(''); });
  getE('tabPendingInvites')?.addEventListener('click', () => { switchGuildTab('PendingInvites'); loadPendingInvites(); });

  getE('tabGuildRoster')?.addEventListener('click', () => switchGuildViewTab('Roster'));
  getE('tabGuildWar')?.addEventListener('click', () => switchGuildViewTab('War'));
  getE('tabGuildSettings')?.addEventListener('click', () => switchGuildViewTab('Settings'));

  getE('btnGuildWarQueue')?.addEventListener('click', queueForGuildWar);
  getE('btnGuildWarDequeue')?.addEventListener('click', dequeueGuildWar);
  getE('btnDirectChallenge')?.addEventListener('click', sendDirectChallenge);
  getE('btnAcceptWar')?.addEventListener('click', acceptWarChallenge);
  getE('btnDeclineWar')?.addEventListener('click', declineWarChallenge);
  getE('btnJoinWarLobby')?.addEventListener('click', joinWarLobby);

  getE('cgTag')?.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  getE('searchInputGuilds')?.addEventListener('input', (e) => loadGuildSearch(e.target.value));

  getE('btnCreateGuildSubmit')?.addEventListener('click', createGuild);

  getE('btnCancelInvite')?.addEventListener('click', () => getE('guildInviteModal').style.display = 'none');
  getE('btnCancelGuildEdit')?.addEventListener('click', () => getE('guildEditModal').style.display = 'none');
  getE('btnSendInvite')?.addEventListener('click', sendInvite);
  getE('btnSaveGuildEdit')?.addEventListener('click', saveGuildEdit);

  socket.on('guild-invite', (data) => {
    showToast(`You've been invited to [${data.guildTag}] ${data.guildName} by ${data.inviterName}!`, 'info');
    updateInviteBadge();
  });

  socket.on('guild-update', async (data) => {
    if (getE('guildHallOverlay').style.display === 'flex') {
      if (data.type === 'kicked') {
        showToast('You have been kicked from the guild.', 'error');
        currentGuildId = null;
        updateGuildChatVisibility();
        await fetchProfile();
        if (typeof setupLoggedInState === 'function') {await setupLoggedInState();}
        openGuildHall();
      } else if (data.type === 'disbanded') {
        showToast('Your guild has been disbanded.', 'error');
        currentGuildId = null;
        updateGuildChatVisibility();
        await fetchProfile();
        if (typeof setupLoggedInState === 'function') {await setupLoggedInState();}
        openGuildHall();
      } else if (currentGuildId) {
        renderGuildView();
      }
    }
  });

  socket.on('guild-war-queue-status', (data) => {
    if (data.status === 'queued') {
      getE('guildWarQueueControls').style.display = 'none';
      getE('guildWarQueuedState').style.display = 'block';
      getE('guildWarQueueTime').textContent = '0:00';
      window.guildWarQueueStart = Date.now();
      if (!window.guildWarQueueInterval) {
        window.guildWarQueueInterval = setInterval(() => {
          let elapsed = Math.floor((Date.now() - window.guildWarQueueStart) / 1000);
          let m = Math.floor(elapsed / 60);
          let s = elapsed % 60;
          getE('guildWarQueueTime').textContent = `${m}:${s.toString().padStart(2, '0')}`;
        }, 1000);
      }
    } else {
      getE('guildWarQueueControls').style.display = 'block';
      getE('guildWarQueuedState').style.display = 'none';
      clearInterval(window.guildWarQueueInterval);
      window.guildWarQueueInterval = null;
    }
  });

  socket.on('guild-war-challenge-received', (data) => {
    window.currentWarChallenge = data;
    getE('challengerGuildName').textContent = `[${data.challengerGuild.tag}]`;
    getE('challengerTeamSize').textContent = `${data.teamSize}v${data.teamSize}`;
    getE('incomingWarModal').style.display = 'flex';
        
    let timeLeft = 60;
    getE('warChallengeTimer').textContent = timeLeft;
    if (window.warChallengeInterval) {clearInterval(window.warChallengeInterval);}
    window.warChallengeInterval = setInterval(() => {
      timeLeft--;
      getE('warChallengeTimer').textContent = timeLeft;
      if (timeLeft <= 0) {
        declineWarChallenge();
      }
    }, 1000);
  });

  socket.on('guild-war-matched', (data) => {
    getE('matchedGuildTag').textContent = `[${data.opponent.tag}]`;
    getE('matchedTeamSize').textContent = data.teamSize;
    getE('warMatchFoundModal').style.display = 'flex';
    window.guildWarRoomId = data.roomId;
        
    getE('guildWarQueueControls').style.display = 'block';
    getE('guildWarQueuedState').style.display = 'none';
    clearInterval(window.guildWarQueueInterval);
  });

  getE('guildChatHeader')?.addEventListener('click', () => {
    const body = getE('guildChatBody');
    const icon = getE('guildChatToggleIcon');
    if (body.style.display === 'none') {
      body.style.display = 'flex';
      icon.textContent = '▼';
    } else {
      body.style.display = 'none';
      icon.textContent = '▲';
    }
  });

  getE('guildChatInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = e.target.value.trim();
      if (val.length > 0) {
        socket.emit('guild-chat', { message: val });
        e.target.value = '';
      }
    }
  });

  socket.on('guild-chat-history', (history) => {
    const container = getE('guildChatMessages');
    if (!container) {return;}
    container.innerHTML = '';
    history.forEach(appendChatMessage);
    container.scrollTop = container.scrollHeight;
  });

  socket.on('guild-chat-message', (msg) => {
    appendChatMessage(msg);
    const container = getE('guildChatMessages');
    if (container) {container.scrollTop = container.scrollHeight;}
  });

  socket.on('guild-online-members', (userIds) => {
    onlineMembers = new Set(userIds);
    updateOnlinePresenceUI();
  });

  socket.on('guild-member-online', (data) => {
    onlineMembers.add(data.userId);
    updateOnlinePresenceUI();
  });

  socket.on('guild-member-offline', (data) => {
    onlineMembers.delete(data.userId);
    updateOnlinePresenceUI();
  });

  socket.on('guild-chat-error', (msg) => showToast(msg, 'error'));

  if (getUser()) {
    updateInviteBadge();
  }

  const btnEmojiToggle = getE('btnEmojiToggle');
  const emojiPickerContainer = getE('emojiPickerContainer');
  const chatInput = getE('guildChatInput');

  if (btnEmojiToggle && emojiPickerContainer && chatInput) {
    const picker = document.createElement('emoji-picker');
    picker.classList.add('dark');
    picker.dataSource = '/emoji-data.json';
    
    fetch(picker.dataSource, { method: 'HEAD' })
      .then(res => {
        if (!res.ok) {throw new Error('Local emoji data missing');}
      })
      .catch(() => {
        console.warn('Local emoji data failed, falling back to CDN');
        picker.dataSource = 'https://cdn.jsdelivr.net/npm/emoji-picker-element-data@^1/en/emojibase/data.json';
      });

    emojiPickerContainer.appendChild(picker);
        
    btnEmojiToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (emojiPickerContainer.style.display === 'none') {
        emojiPickerContainer.style.display = 'block';
      } else {
        emojiPickerContainer.style.display = 'none';
      }
    });

    picker.addEventListener('emoji-click', event => {
      const cursor = chatInput.selectionStart || chatInput.value.length;
      const text = chatInput.value;
      chatInput.value = text.slice(0, cursor) + event.detail.unicode + text.slice(cursor);
      chatInput.focus();
      chatInput.selectionStart = cursor + event.detail.unicode.length;
      chatInput.selectionEnd = chatInput.selectionStart;
    });

    document.addEventListener('click', (e) => {
      if (!emojiPickerContainer.contains(e.target) && e.target !== btnEmojiToggle) {
        emojiPickerContainer.style.display = 'none';
      }
    });
  }
}

function selectColor(color, containerId) {
  selectedColor = color;
  const container = getE(containerId);
  Array.from(container.children).forEach(c => {
    if (c.style.backgroundColor === color || c.style.backgroundColor === hexToRgb(color)) {
      c.classList.add('active');
    } else {
      c.classList.remove('active');
    }
  });
}

function hexToRgb(hex) {
  let r = 0, g = 0, b = 0;
  if (hex.length == 4) {
    r = '0x' + hex[1] + hex[1]; g = '0x' + hex[2] + hex[2]; b = '0x' + hex[3] + hex[3];
  } else if (hex.length == 7) {
    r = '0x' + hex[1] + hex[2]; g = '0x' + hex[3] + hex[4]; b = '0x' + hex[5] + hex[6];
  }
  return `rgb(${+r}, ${+g}, ${+b})`;
}

function switchGuildTab(tabName) {
  ['CreateGuild', 'SearchGuilds', 'PendingInvites'].forEach(t => {
    const el = getE(`panel${t}`);
    if(el) {el.style.display = (t === tabName) ? 'block' : 'none';}
    const tabEl = getE(`tab${t}`);
    if(tabEl) {tabEl.classList.toggle('active', t === tabName);}
  });
}

function switchGuildViewTab(tabName) {
  getE('guildRosterView').style.display = (tabName === 'Roster') ? 'block' : 'none';
  getE('guildWarView').style.display = (tabName === 'War') ? 'block' : 'none';
  getE('guildSettingsView').style.display = (tabName === 'Settings') ? 'block' : 'none';
    
  getE('tabGuildRoster').style.backgroundColor = (tabName === 'Roster') ? '#ffc107' : 'rgba(255,255,255,0.1)';
  getE('tabGuildRoster').style.color = (tabName === 'Roster') ? '#000' : '#ccc';
  getE('tabGuildWar').style.backgroundColor = (tabName === 'War') ? 'rgba(220,53,69,0.2)' : 'rgba(255,255,255,0.1)';
  getE('tabGuildSettings').style.backgroundColor = (tabName === 'Settings') ? '#ffc107' : 'rgba(255,255,255,0.1)';
  getE('tabGuildSettings').style.color = (tabName === 'Settings') ? '#000' : '#ccc';
}

async function api(path, method = 'GET', body = null) {
  const token = localStorage.getItem('organicwar_auth_token');
  const options = {
    method,
    headers: { 'Authorization': `Bearer ${token}` },
  };
  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`/api/guilds${path}`, options);
  const data = await res.json();
  if (!res.ok) {throw new Error(data.error || 'API Error');}
  return data;
}

export async function openGuildHall() {
  const user = getUser();
  if (!user) {return;}

  try {
    const token = localStorage.getItem('organicwar_auth_token');
    const res = await fetch(`/api/profile/${user.username}?t=${Date.now()}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      cache: 'no-store',
    });
    const data = await res.json();
        
    currentGuildId = data.profile.guild_id;
    currentGuildRole = data.profile.guild_role;

    getE('guildHallOverlay').style.display = 'flex';
    getE('guildErrorMsg').style.display = 'none';

    if (currentGuildId) {
      getE('guildViewNoGuild').style.display = 'none';
      getE('guildViewInGuild').style.display = 'block';
      updateGuildChatVisibility();
      await renderGuildView();
    } else {
      getE('guildViewNoGuild').style.display = 'block';
      getE('guildViewInGuild').style.display = 'none';
      updateGuildChatVisibility();
      switchGuildTab('CreateGuild');
      updateInviteBadge();
    }
  } catch (err) {
    console.error(err);
    showGuildError('Failed to load guild data.');
  }
}

function closeGuildHall() {
  getE('guildHallOverlay').style.display = 'none';
}

function showGuildError(msg) {
  const el = getE('guildErrorMsg');
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 5000);
}

async function createGuild() {
  const name = getE('cgName').value;
  const tag = getE('cgTag').value;
  const desc = getE('cgDesc').value;

  try {
    const res = await api('', 'POST', { name, tag, description: desc, color: selectedColor });
    showToast('Guild created successfully!', 'success');
    currentGuildId = res.guild.id;
    currentGuildRole = 'leader';
    await fetchProfile();
    if (typeof setupLoggedInState === 'function') {await setupLoggedInState();}
    openGuildHall();
  } catch (err) {
    showGuildError(err.message);
  }
}

async function loadGuildSearch(query) {
  const list = getE('guildSearchResults');
  if (query.length < 2 && query.length > 0) {return;}
    
  list.innerHTML = '<div style="text-align:center; color:#888;">Searching...</div>';
  try {
    const res = await api(`/search?q=${query}`);
    list.innerHTML = '';
    if (res.guilds.length === 0) {
      list.innerHTML = '<div style="text-align:center; color:#888;">No guilds found.</div>';
      return;
    }

    res.guilds.forEach(g => {
      const item = document.createElement('div');
      item.style.display = 'flex';
      item.style.justifyContent = 'space-between';
      item.style.alignItems = 'center';
      item.style.background = 'rgba(255,255,255,0.05)';
      item.style.padding = '10px';
      item.style.borderRadius = '6px';
            
      const canJoin = g.is_open && g.member_count < g.max_members;
      const canRequest = !g.is_open && g.member_count < g.max_members;

      const infoDiv = document.createElement('div');
      infoDiv.innerHTML = `
                <div style="font-weight:bold; font-size:14px;"><span class="guild-tag-badge" style="color:${escapeHtml(g.color)}">[${escapeHtml(g.tag)}]</span> ${escapeHtml(g.name)}</div>
                <div style="font-size:11px; color:#aaa; margin-top:4px;">${g.member_count}/${g.max_members} Members • ${g.elo_rating} ELO</div>
            `;

      const actionDiv = document.createElement('div');
      if (canJoin) {
        const joinBtn = document.createElement('button');
        joinBtn.className = 'home-btn home-btn-play';
        joinBtn.style.cssText = 'padding: 6px 12px; font-size:11px;';
        joinBtn.textContent = 'Join';
        joinBtn.addEventListener('click', () => window.joinGuild(g.id, joinBtn));
        actionDiv.appendChild(joinBtn);
      } else if (canRequest) {
        const reqBtn = document.createElement('button');
        reqBtn.className = 'home-btn';
        reqBtn.style.cssText = 'padding: 6px 12px; font-size:11px; background: #3c8cdc;';
        reqBtn.textContent = 'Request';
        reqBtn.addEventListener('click', () => window.requestGuildJoin(g.id, reqBtn));
        actionDiv.appendChild(reqBtn);
      } else {
        actionDiv.innerHTML = `<span style="color:#888; font-size:11px; text-transform:uppercase;">${g.is_open ? 'Full' : 'Closed/Full'}</span>`;
      }

      item.appendChild(infoDiv);
      item.appendChild(actionDiv);
      list.appendChild(item);
    });
  } catch (err) {
    const errDiv = document.createElement('div');
    errDiv.style.color = 'red';
    errDiv.textContent = `Error: ${err.message}`;
    list.replaceChildren(errDiv);
  }
}

window.joinGuild = async function(id, btnElement) {
  try {
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.textContent = 'Joining...';
    }
    await api(`/${id}/join`, 'POST');
    showToast('Successfully joined the guild!', 'success');
    await fetchProfile();
    if (typeof setupLoggedInState === 'function') {await setupLoggedInState();}
    
    currentGuildId = id;
    if (getE('guildHallOverlay').style.display === 'flex') {
      openGuildHall();
    }
  } catch (err) {
    if (btnElement) {
      btnElement.disabled = false;
      btnElement.textContent = 'Join';
    }
    showToast(err.message, 'error');
    showGuildError(err.message);
  }
};

window.requestGuildJoin = async function(id, btnElement) {
  try {
    if (btnElement) {
      btnElement.disabled = true;
      btnElement.textContent = 'Requesting...';
    }
    await api(`/${id}/request`, 'POST');
    if (btnElement) {
      btnElement.className = 'cancel-shop-btn';
      btnElement.textContent = 'Requested';
    }
    showToast('Join request sent!', 'success');
  } catch (err) {
    if (btnElement) {
      btnElement.disabled = false;
      btnElement.textContent = 'Request';
    }
    showToast(err.message, 'error');
    showGuildError(err.message);
  }
};

async function updateInviteBadge() {
  try {
    const token = localStorage.getItem('organicwar_auth_token');
    const res = await fetch('/api/guilds/me/invites', { headers: { 'Authorization': `Bearer ${token}` }});
    const data = await res.json();
        
    const count = data.invites.length;
    getE('guildInviteBadge').style.display = count > 0 ? 'block' : 'none';
    getE('guildInviteBadge').textContent = count;
        
    getE('inviteTabBadge').style.display = count > 0 ? 'inline-block' : 'none';
    getE('inviteTabBadge').textContent = count;
  } catch(e) {
    console.error('Failed to update invite badge:', e);
  }
}

async function loadPendingInvites() {
  const list = getE('guildInvitesList');
  list.innerHTML = '<div style="text-align:center; color:#888;">Loading...</div>';
    
  try {
    const res = await api('/me/invites');
    list.innerHTML = '';
    if (res.invites.length === 0) {
      list.innerHTML = '<div style="text-align:center; color:#888;">No pending invites.</div>';
      return;
    }

    res.invites.forEach(inv => {
      const item = document.createElement('div');
      item.style.display = 'flex';
      item.style.justifyContent = 'space-between';
      item.style.alignItems = 'center';
      item.style.background = 'rgba(255,255,255,0.05)';
      item.style.padding = '10px';
      item.style.borderRadius = '6px';
            
      const infoDiv = document.createElement('div');
      infoDiv.innerHTML = `
                <div style="font-weight:bold; font-size:14px;">[${escapeHtml(inv.guild_tag)}] ${escapeHtml(inv.guild_name)}</div>
                <div style="font-size:11px; color:#aaa; margin-top:4px;">Invited on ${new Date(inv.created_at).toLocaleDateString()}</div>
            `;

      const btnsDiv = document.createElement('div');
      btnsDiv.style.cssText = 'display:flex; gap: 5px;';

      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'home-btn home-btn-play';
      acceptBtn.style.cssText = 'padding: 6px 12px; font-size:11px;';
      acceptBtn.textContent = 'Accept';
      acceptBtn.addEventListener('click', () => respondInvite(inv.id, true));

      const declineBtn = document.createElement('button');
      declineBtn.className = 'cancel-shop-btn';
      declineBtn.style.cssText = 'display:block; padding: 6px 12px; margin:0;';
      declineBtn.textContent = 'Decline';
      declineBtn.addEventListener('click', () => respondInvite(inv.id, false));

      btnsDiv.appendChild(acceptBtn);
      btnsDiv.appendChild(declineBtn);

      item.appendChild(infoDiv);
      item.appendChild(btnsDiv);
      list.appendChild(item);
    });
  } catch (err) {
    const errDiv = document.createElement('div');
    errDiv.style.color = 'red';
    errDiv.textContent = `Error: ${err.message}`;
    list.replaceChildren(errDiv);
  }
}

async function respondInvite(id, accept) {
  try {
    await api(`/invites/${id}/respond`, 'POST', { accept });
    showToast(accept ? 'Joined guild!' : 'Invite declined.', accept ? 'success' : 'info');
    if (accept) {
      await fetchProfile();
      if (typeof setupLoggedInState === 'function') {await setupLoggedInState();}
      openGuildHall();
    } else {
      loadPendingInvites();
      updateInviteBadge();
    }
  } catch (err) {
    showGuildError(err.message);
  }
}
window.respondInvite = respondInvite;

async function renderGuildView() {
  try {
    const res = await api(`/${currentGuildId}`);
    const g = res.guild;
        
    getE('guildTitleText').textContent = `[${g.tag}] ${g.name}`;
    getE('guildTitleText').style.color = g.color;
    getE('guildEloText').textContent = g.elo_rating;
    getE('guildDescText').textContent = g.description || 'No description provided.';

    const list = getE('guildMemberList');
    list.innerHTML = '';
    g.members.sort((a,b) => {
      const roleOrder = { leader: 1, officer: 2, member: 3 };
      return roleOrder[a.role] - roleOrder[b.role];
    });

    g.members.forEach(m => {
      const item = document.createElement('div');
      item.style.display = 'flex';
      item.style.justifyContent = 'space-between';
      item.style.alignItems = 'center';
      item.style.padding = '8px';
      item.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
            
      const isMe = m.username === getUser().username;
      if (isMe) {currentGuildRole = m.role;}

      let actionsFragment = null;
      if (currentGuildRole === 'leader' && !isMe) {
        actionsFragment = document.createDocumentFragment();
        const sel = document.createElement('select');
        sel.style.cssText = 'background:#222; color:#fff; border:1px solid #555; border-radius:3px; font-size:10px; margin-right:5px;';
        sel.innerHTML = `<option value="member" ${m.role==='member'?'selected':''}>Member</option><option value="officer" ${m.role==='officer'?'selected':''}>Officer</option>`;
        sel.addEventListener('change', () => window.promoteMember(m.user_id, sel.value));
        const kickBtn = document.createElement('button');
        kickBtn.className = 'cancel-shop-btn';
        kickBtn.style.cssText = 'display:inline-block; padding: 2px 6px; font-size:10px; margin:0;';
        kickBtn.textContent = 'Kick';
        kickBtn.addEventListener('click', () => window.kickMember(m.user_id));
        actionsFragment.appendChild(sel);
        actionsFragment.appendChild(kickBtn);
      } else if (currentGuildRole === 'officer' && m.role === 'member') {
        actionsFragment = document.createDocumentFragment();
        const kickBtn = document.createElement('button');
        kickBtn.className = 'cancel-shop-btn';
        kickBtn.style.cssText = 'display:inline-block; padding: 2px 6px; font-size:10px; margin:0;';
        kickBtn.textContent = 'Kick';
        kickBtn.addEventListener('click', () => window.kickMember(m.user_id));
        actionsFragment.appendChild(kickBtn);
      }

      const isOnline = onlineMembers.has(m.user_id) || isMe;
      const dotClass = isOnline ? 'online' : 'offline';
            
      const leftDiv = document.createElement('div');
      leftDiv.style.cssText = 'display:flex; align-items:center; gap: 8px;';
      leftDiv.innerHTML = `
                <span class="status-dot ${dotClass}"></span>
                <span class="role-badge role-${escapeHtml(m.role)}">${escapeHtml(m.role)}</span>
                <span style="font-weight:bold; font-size:13px; color: ${isMe ? '#ffc107' : '#fff'}">${escapeHtml(m.display_name)}</span>
                <span style="color:#888; font-size:11px;">@${escapeHtml(m.username)}</span>
            `;

      const rightDiv = document.createElement('div');
      rightDiv.style.cssText = 'display:flex; align-items:center; gap: 10px;';
      if (actionsFragment) {rightDiv.appendChild(actionsFragment);}
      const eloSpan = document.createElement('span');
      eloSpan.style.cssText = 'color:#aaa; font-size:11px; width:50px; text-align:right;';
      eloSpan.textContent = `${m.elo_rating} ELO`;
      rightDiv.appendChild(eloSpan);

      item.appendChild(leftDiv);
      item.appendChild(rightDiv);
      list.appendChild(item);
    });
        
    getE('guildRoleBadge').textContent = currentGuildRole.toUpperCase();
    getE('guildRoleBadge').className = `role-badge role-${currentGuildRole}`;

    if (currentGuildRole === 'leader' || currentGuildRole === 'officer') {
      if (getE('guildRequestsContainer')) {getE('guildRequestsContainer').style.display = 'block';}
      loadGuildRequests();
    } else {
      if (getE('guildRequestsContainer')) {getE('guildRequestsContainer').style.display = 'none';}
    }

    const btns = getE('guildSettingsView');
    if (btns) {
      btns.innerHTML = '';
      const flexContainer = document.createElement('div');
      flexContainer.style.cssText = 'display:flex; gap:10px; flex-direction: column;';
        
      if (currentGuildRole === 'leader' || currentGuildRole === 'officer') {
        const inviteBtn = document.createElement('button');
        inviteBtn.className = 'home-btn home-btn-play';
        inviteBtn.style.cssText = 'flex:1; padding: 10px;';
        inviteBtn.textContent = 'Invite Player';
        inviteBtn.addEventListener('click', () => window.openInviteModal());
        flexContainer.appendChild(inviteBtn);
      }
      if (currentGuildRole === 'leader') {
        const editBtn = document.createElement('button');
        editBtn.className = 'home-btn home-btn-lobby';
        editBtn.style.cssText = 'flex:1; padding: 10px;';
        editBtn.textContent = 'Edit Settings';
        editBtn.addEventListener('click', () => window.openEditModal(g.name, g.tag, g.is_open, g.max_members, g.color, g.description));
        flexContainer.appendChild(editBtn);

        const disbandBtn = document.createElement('button');
        disbandBtn.className = 'cancel-shop-btn';
        disbandBtn.style.cssText = 'display:block; flex:1; padding: 10px; margin:0;';
        disbandBtn.textContent = 'Disband Guild';
        disbandBtn.addEventListener('click', () => window.disbandGuild());
        flexContainer.appendChild(disbandBtn);
      }
    
      const leaveBtn = document.createElement('button');
      leaveBtn.className = 'cancel-shop-btn';
      leaveBtn.style.cssText = 'display:block; flex:1; padding: 10px; margin:0;';
      leaveBtn.textContent = 'Leave Guild';
      leaveBtn.addEventListener('click', () => window.leaveGuild());
      flexContainer.appendChild(leaveBtn);
      btns.appendChild(flexContainer);
    }
  } catch (err) {
    showGuildError(err.message);
  }
}

window.leaveGuild = async function() {
  if(!confirm('Are you sure you want to leave this guild?')) {return;}
  try {
    const res = await api(`/${currentGuildId}/leave`, 'POST');
    if (res.disbanded) {
      showToast('You left, and since you were the last member, the guild was disbanded.', 'info');
    } else {
      showToast('You left the guild.', 'info');
    }
    currentGuildId = null;
    await fetchProfile();
    if (typeof setupLoggedInState === 'function') {await setupLoggedInState();}
    openGuildHall();
  } catch(e) { showGuildError(e.message); }
};

window.disbandGuild = async function() {
  if(!confirm('Are you sure you want to DISBAND this guild? This cannot be undone.')) {return;}
  try {
    await api(`/${currentGuildId}`, 'DELETE');
    showToast('Guild disbanded.', 'info');
    currentGuildId = null;
    await fetchProfile();
    if (typeof setupLoggedInState === 'function') {await setupLoggedInState();}
    openGuildHall();
  } catch(e) { showGuildError(e.message); }
};

window.kickMember = async function(userId) {
  if(!confirm('Kick this member?')) {return;}
  try {
    await api(`/${currentGuildId}/kick`, 'POST', { userId });
    renderGuildView();
  } catch(e) { showGuildError(e.message); }
};

window.promoteMember = async function(userId, role) {
  try {
    await api(`/${currentGuildId}/promote`, 'POST', { userId, role });
    renderGuildView();
  } catch(e) { showGuildError(e.message); }
};

async function loadGuildRequests() {
  const list = getE('guildRequestsList');
  if (!list) {return;}
  try {
    const res = await api(`/${currentGuildId}/requests`);
    list.innerHTML = '';
    if (res.requests.length === 0) {
      list.innerHTML = '<div style="color:#888; font-size:11px;">No pending requests.</div>';
      return;
    }
    res.requests.forEach(r => {
      const item = document.createElement('div');
      item.style.display = 'flex';
      item.style.justifyContent = 'space-between';
      item.style.alignItems = 'center';
      item.style.padding = '8px';
      item.style.borderBottom = '1px solid rgba(255,255,255,0.05)';

      const infoDiv = document.createElement('div');
      infoDiv.innerHTML = `
                <span style="font-weight:bold; font-size:13px; color:#fff">${escapeHtml(r.display_name)}</span>
                <span style="color:#888; font-size:11px;">@${escapeHtml(r.username)}</span>
            `;

      const btnsDiv = document.createElement('div');
      btnsDiv.style.cssText = 'display:flex; gap: 5px;';

      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'home-btn home-btn-play';
      acceptBtn.style.cssText = 'padding: 4px 8px; font-size:10px;';
      acceptBtn.textContent = 'Accept';
      acceptBtn.addEventListener('click', () => window.respondGuildRequest(r.id, true));

      const declineBtn = document.createElement('button');
      declineBtn.className = 'cancel-shop-btn';
      declineBtn.style.cssText = 'padding: 4px 8px; font-size:10px; margin:0;';
      declineBtn.textContent = 'Decline';
      declineBtn.addEventListener('click', () => window.respondGuildRequest(r.id, false));

      btnsDiv.appendChild(acceptBtn);
      btnsDiv.appendChild(declineBtn);

      item.appendChild(infoDiv);
      item.appendChild(btnsDiv);
      list.appendChild(item);
    });
  } catch (e) {
    list.innerHTML = '<div style="color:red; font-size:11px;">Error loading requests</div>';
  }
}

window.respondGuildRequest = async function(reqId, accept) {
  try {
    await api(`/requests/${reqId}/respond`, 'POST', { accept });
    showToast(accept ? 'Request accepted.' : 'Request declined.', 'success');
    renderGuildView();
  } catch(e) {
    showGuildError(e.message);
  }
};

window.openInviteModal = function() {
  getE('inviteUsername').value = '';
  getE('inviteErrorMsg').style.display = 'none';
  getE('guildInviteModal').style.display = 'flex';
};

async function sendInvite() {
  const username = getE('inviteUsername').value;
  try {
    await api(`/${currentGuildId}/invite`, 'POST', { username });
    showToast('Invite sent!', 'success');
    getE('guildInviteModal').style.display = 'none';
  } catch(err) {
    getE('inviteErrorMsg').textContent = err.message;
    getE('inviteErrorMsg').style.display = 'block';
  }
}

window.openEditModal = function(name, tag, isOpen, maxMembers, color, desc) {
  getE('editGuildErrorMsg').style.display = 'none';
    
  if (!getE('egName')) {
    const nameTagHtml = `
            <div style="margin-bottom: 20px;">
                <label style="display: block; font-size: 12px; font-weight: bold; color: #ccc; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 1px;">Guild Name</label>
                <input type="text" id="egName" class="login-input" maxlength="25" style="width: 100%; padding: 14px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.15); color: #fff; border-radius: 8px; font-size: 14px; outline: none; transition: border-color 0.2s, box-shadow 0.2s; box-sizing: border-box;" onfocus="this.style.borderColor='#ffc107'; this.style.boxShadow='0 0 8px rgba(255,193,7,0.3)';" onblur="this.style.borderColor='rgba(255,255,255,0.15)'; this.style.boxShadow='none';">
            </div>
            <div style="margin-bottom: 20px;">
                <label style="display: block; font-size: 12px; font-weight: bold; color: #ccc; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 1px;">Guild Tag</label>
                <input type="text" id="egTag" class="login-input" maxlength="5" style="width: 100%; padding: 14px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.15); color: #fff; border-radius: 8px; font-size: 14px; outline: none; transition: border-color 0.2s, box-shadow 0.2s; box-sizing: border-box; text-transform: uppercase;" onfocus="this.style.borderColor='#ffc107'; this.style.boxShadow='0 0 8px rgba(255,193,7,0.3)';" onblur="this.style.borderColor='rgba(255,255,255,0.15)'; this.style.boxShadow='none';">
            </div>
        `;
    getE('editGuildErrorMsg').insertAdjacentHTML('afterend', nameTagHtml);
  }
  getE('egName').value = name;
  getE('egTag').value = tag;
  getE('egDesc').value = desc;
  getE('egIsOpen').checked = isOpen == 1;
  selectColor(color, 'egColorPicker');
  getE('guildEditModal').style.display = 'flex';
};

async function saveGuildEdit() {
  try {
    await api(`/${currentGuildId}`, 'PUT', {
      name: getE('egName').value,
      tag: getE('egTag').value,
      description: getE('egDesc').value,
      color: selectedColor,
      isOpen: getE('egIsOpen').checked,
    });
    showToast('Settings saved.', 'success');
    getE('guildEditModal').style.display = 'none';
    renderGuildView();
  } catch(err) {
    getE('editGuildErrorMsg').textContent = err.message;
    getE('editGuildErrorMsg').style.display = 'block';
  }
}

function appendChatMessage(msg) {
  const container = getE('guildChatMessages');
  if (!container) {return;}
  const isMe = msg.userId === getUser()?.id;
  const div = document.createElement('div');
  div.className = `chat-msg ${isMe ? 'self' : 'other'}`;
    
  const time = new Date(msg.timestamp + (msg.timestamp.endsWith('Z') ? '' : 'Z')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const header = document.createElement('div');
  header.className = 'chat-msg-header';
  header.style.flexDirection = 'column';
  const author = document.createElement('span');
  author.className = 'chat-msg-author';
  author.textContent = msg.displayName;
  const timeEl = document.createElement('span');
  timeEl.style.cssText = 'font-size: 9px; opacity: 0.8; margin-top: 2px;';
  timeEl.textContent = time;
  header.append(author, timeEl);
  const body = document.createElement('div');
  body.className = 'chat-msg-body';
  body.textContent = msg.message;
  div.append(header, body);
  container.appendChild(div);
}

export function updateOnlinePresenceUI() {
  if (getE('guildHallOverlay').style.display === 'flex' && currentGuildId) {
    renderGuildView();
  }
  const ind = getE('ingameGuildIndicator');
  const cnt = getE('ingameGuildOnlineCount');
  if (ind && cnt) {
    cnt.textContent = Math.max(1, onlineMembers.size);
  }
}

export function toggleInGameIndicator(show) {
  isCurrentlyInGame = show;
  const ind = getE('ingameGuildIndicator');
  if (ind) {
    ind.style.display = (show && currentGuildId) ? 'block' : 'none';
  }
  updateGuildChatVisibility();
}

function queueForGuildWar() {
  const size = parseInt(getE('guildWarSizeSelect').value);
  socket.emit('guild-war-queue', { teamSize: size });
}

function dequeueGuildWar() {
  socket.emit('guild-war-dequeue');
}

function sendDirectChallenge() {
  const tag = getE('directChallengeTag').value.trim();
  if (!tag) {return;}
  const size = parseInt(getE('guildWarSizeSelect').value);
  socket.emit('guild-war-challenge', { tag, teamSize: size });
}

function acceptWarChallenge() {
  if (!window.currentWarChallenge) {return;}
  socket.emit('guild-war-accept', { 
    challengerGuildId: window.currentWarChallenge.challengerGuild.id,
    teamSize: window.currentWarChallenge.teamSize,
  });
  getE('incomingWarModal').style.display = 'none';
  clearInterval(window.warChallengeInterval);
}

function declineWarChallenge() {
  getE('incomingWarModal').style.display = 'none';
  clearInterval(window.warChallengeInterval);
}

function joinWarLobby() {
  getE('warMatchFoundModal').style.display = 'none';
  getE('guildHallOverlay').style.display = 'none';
  if (window.guildWarRoomId) {
    socket.emit('join-room', window.guildWarRoomId);
    getE('homeScreen').style.display = 'none';
    getE('waitingOverlay').style.display = 'flex';
  }
}
