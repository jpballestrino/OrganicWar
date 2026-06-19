import { showUserProfile } from './authUI.js';
import { getUser } from './auth.js';
import { escapeHtml } from './escape.js';

const PAGE_SIZE = 20;

const tabState = {
  Players: { page: 1, search: '' },
  Guilds:  { page: 1, search: '' },
};
let currentTab = 'Players';
let fetchRequestId = 0;
let searchDebounceTimer = null;

function getE(id) { return document.getElementById(id); }

export function initRankingsUI() {
  const btnShowRankings = getE('btn-show-rankings');
  const rankingsModal = getE('rankingsModal');
  const btnCloseRankings = getE('btnCloseRankings');

  if (btnShowRankings) {
    btnShowRankings.addEventListener('click', () => {
      rankingsModal.style.display = 'flex';
      switchRankingsTab('Players');
    });
  }

  if (btnCloseRankings) {
    btnCloseRankings.addEventListener('click', () => {
      rankingsModal.style.display = 'none';
    });
  }

  getE('tabRankingsPlayers')?.addEventListener('click', () => switchRankingsTab('Players'));
  getE('tabRankingsGuilds')?.addEventListener('click', () => switchRankingsTab('Guilds'));

  getE('rankingsPrevBtn')?.addEventListener('click', () => {
    const state = tabState[currentTab];
    if (state.page > 1) { state.page--; fetchAndRender(); }
  });

  getE('rankingsNextBtn')?.addEventListener('click', () => {
    tabState[currentTab].page++;
    fetchAndRender();
  });

  getE('rankingsSearch')?.addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      tabState[currentTab].search = e.target.value.trim();
      tabState[currentTab].page = 1;
      fetchAndRender();
    }, 300);
  });
}

function switchRankingsTab(tabName) {
  currentTab = tabName;

  const tabPlayers = getE('tabRankingsPlayers');
  const tabGuilds  = getE('tabRankingsGuilds');
  const searchEl   = getE('rankingsSearch');
  const header     = getE('rankingsHeader');

  if (tabName === 'Players') {
    tabPlayers.classList.add('active');
    tabGuilds.classList.remove('active');
    if (searchEl) searchEl.placeholder = 'Search players...';
    header.innerHTML = `
      <div style="width: 50px; text-align: center;">Rank</div>
      <div style="flex: 1;">Player</div>
      <div style="width: 80px; text-align: center;">Matches</div>
      <div style="width: 100px; text-align: center;">Win Rate</div>
      <div style="width: 80px; text-align: right;">Elo</div>
    `;
  } else {
    tabGuilds.classList.add('active');
    tabPlayers.classList.remove('active');
    if (searchEl) searchEl.placeholder = 'Search guilds...';
    header.innerHTML = `
      <div style="width: 50px; text-align: center;">Rank</div>
      <div style="flex: 1;">Guild</div>
      <div style="width: 80px; text-align: center;">Members</div>
      <div style="width: 100px; text-align: center;">Matches</div>
      <div style="width: 80px; text-align: right;">Elo</div>
      <div style="width: 80px; text-align: center;">Action</div>
    `;
  }

  // Sync search input to this tab's last known search term
  if (searchEl) searchEl.value = tabState[tabName].search;

  fetchAndRender();
}

function fetchAndRender() {
  const { page, search } = tabState[currentTab];
  if (currentTab === 'Players') {
    fetchAndRenderPlayers(page, search);
  } else {
    fetchAndRenderGuilds(page, search);
  }
}

async function fetchAndRenderPlayers(page, search) {
  const rid = ++fetchRequestId;
  const list = getE('rankingsList');
  list.innerHTML = '<div style="text-align:center; padding: 20px; color:#888;">Loading...</div>';

  const params = new URLSearchParams({ page });
  if (search) params.set('search', search);

  try {
    const res = await fetch(`/api/rankings/players?${params}`);
    if (rid !== fetchRequestId) return;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch players');

    list.innerHTML = '';
    if (!data.players.length) {
      list.innerHTML = '<div style="text-align:center; padding: 20px; color:#888;">No players found.</div>';
      renderPagination(data.page, data.pages);
      return;
    }

    data.players.forEach((p, index) => {
      const rank = (page - 1) * PAGE_SIZE + index + 1;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; padding:10px; background:rgba(255,255,255,0.05); border-radius:4px; cursor:pointer; transition:background 0.2s;';
      row.addEventListener('mouseover', () => { row.style.background = 'rgba(255,255,255,0.1)'; });
      row.addEventListener('mouseout',  () => { row.style.background = 'rgba(255,255,255,0.05)'; });
      row.addEventListener('click', () => showUserProfile(p.username));

      let rankHtml = `<span>${rank}</span>`;
      if (!search) {
        if (rank === 1) rankHtml = '<span style="color:#ffd700; font-weight:bold;">🥇 1</span>';
        else if (rank === 2) rankHtml = '<span style="color:#c0c0c0; font-weight:bold;">🥈 2</span>';
        else if (rank === 3) rankHtml = '<span style="color:#cd7f32; font-weight:bold;">🥉 3</span>';
      }

      const guildText = p.guild_tag
        ? `<span style="color:${escapeHtml(p.guild_color) || '#ffc107'}; font-size:11px;">[${escapeHtml(p.guild_tag)}]</span> `
        : '';
      const winRate = p.total_games > 0 ? Math.round((p.total_wins / p.total_games) * 100) : 0;
      const winRateColor = winRate >= 50 ? '#4ade80' : (winRate > 0 ? '#f87171' : '#888');

      row.innerHTML = `
        <div style="width:50px; text-align:center; font-size:14px; align-self:center;">${rankHtml}</div>
        <div style="flex:1; align-self:center;">${guildText}<span style="font-weight:bold; color:#fff;">${escapeHtml(p.display_name)}</span></div>
        <div style="width:80px; text-align:center; color:#ccc; align-self:center; font-size:13px;">${p.total_games}</div>
        <div style="width:100px; text-align:center; color:${winRateColor}; align-self:center; font-size:13px; font-weight:bold;">${winRate}%</div>
        <div style="width:80px; text-align:right; color:#ffc107; font-weight:bold; align-self:center;">${p.elo_rating}</div>
      `;
      list.appendChild(row);
    });

    renderPagination(data.page, data.pages);
  } catch (err) {
    if (rid !== fetchRequestId) return;
    list.innerHTML = `<div style="color:red; text-align:center; padding:20px;">Error: ${escapeHtml(err.message)}</div>`;
  }
}

async function fetchAndRenderGuilds(page, search) {
  const rid = ++fetchRequestId;
  const list = getE('rankingsList');
  list.innerHTML = '<div style="text-align:center; padding: 20px; color:#888;">Loading...</div>';

  const params = new URLSearchParams({ page });
  if (search) params.set('search', search);

  try {
    const res = await fetch(`/api/rankings/guilds?${params}`);
    if (rid !== fetchRequestId) return;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch guilds');

    list.innerHTML = '';
    if (!data.guilds.length) {
      list.innerHTML = '<div style="text-align:center; padding: 20px; color:#888;">No guilds found.</div>';
      renderPagination(data.page, data.pages);
      return;
    }

    const currentUser = getUser();

    data.guilds.forEach((g, index) => {
      const rank = (page - 1) * PAGE_SIZE + index + 1;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; padding:10px; background:rgba(255,255,255,0.05); border-radius:4px;';

      let rankHtml = `<span>${rank}</span>`;
      if (!search) {
        if (rank === 1) rankHtml = '<span style="color:#ffd700; font-weight:bold;">🥇 1</span>';
        else if (rank === 2) rankHtml = '<span style="color:#c0c0c0; font-weight:bold;">🥈 2</span>';
        else if (rank === 3) rankHtml = '<span style="color:#cd7f32; font-weight:bold;">🥉 3</span>';
      }

      const matches = g.total_guild_wins + g.total_guild_losses;
      const membersColor = g.member_count >= g.max_members ? '#f87171' : '#4ade80';

      let actionHtml = '';
      let canJoin = false;
      let canRequest = false;

      if (g.member_count >= g.max_members) {
        actionHtml = '<span style="color:#888; font-size:11px; text-transform:uppercase;">Full</span>';
      } else if (currentUser && !(currentUser.guildId || currentUser.guild_id)) {
        if (g.is_open) {
          canJoin = true;
          actionHtml = '<button class="home-btn home-btn-play join-btn" style="padding:4px 10px; font-size:11px; margin:0; width:100%;">Join</button>';
        } else {
          canRequest = true;
          actionHtml = '<button class="home-btn join-btn" style="padding:4px 10px; font-size:11px; margin:0; width:100%; background:#3c8cdc;">Request</button>';
        }
      }

      row.innerHTML = `
        <div style="width:50px; text-align:center; font-size:14px; align-self:center;">${rankHtml}</div>
        <div style="flex:1; align-self:center;">
          <span style="color:${escapeHtml(g.color) || '#ffc107'}; font-weight:bold;">[${escapeHtml(g.tag)}]</span>
          <span style="color:#fff;">${escapeHtml(g.name)}</span>
        </div>
        <div style="width:80px; text-align:center; color:${membersColor}; align-self:center; font-size:13px;">${g.member_count}/${g.max_members}</div>
        <div style="width:100px; text-align:center; color:#ccc; align-self:center; font-size:13px;">${matches}</div>
        <div style="width:80px; text-align:right; color:#ffc107; font-weight:bold; align-self:center; padding-right:10px;">${g.elo_rating}</div>
        <div style="width:80px; text-align:center; align-self:center;" class="action-container">${actionHtml}</div>
      `;

      if (canJoin || canRequest) {
        const btn = row.querySelector('.join-btn');
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (canJoin && window.joinGuild) window.joinGuild(g.id, btn);
          else if (canRequest && window.requestGuildJoin) window.requestGuildJoin(g.id, btn);
        });
      }

      list.appendChild(row);
    });

    renderPagination(data.page, data.pages);
  } catch (err) {
    if (rid !== fetchRequestId) return;
    list.innerHTML = `<div style="color:red; text-align:center; padding:20px;">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function renderPagination(page, pages) {
  const prev = getE('rankingsPrevBtn');
  const next = getE('rankingsNextBtn');
  const info = getE('rankingsPageInfo');
  if (!prev || !next || !info) return;

  info.textContent = `Page ${page} of ${pages}`;
  prev.disabled = page <= 1;
  next.disabled = page >= pages;
  prev.style.opacity = page <= 1 ? '0.35' : '1';
  next.style.opacity = page >= pages ? '0.35' : '1';
  prev.style.cursor = page <= 1 ? 'default' : 'pointer';
  next.style.cursor = page >= pages ? 'default' : 'pointer';
}
