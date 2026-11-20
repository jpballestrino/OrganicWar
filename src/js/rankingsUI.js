import { showUserProfile } from './authUI.js';
import { getUser } from './auth.js';
import { tierFor } from './ranks.js';
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
      <div style="width: 80px; text-align: center;" title="Tier from the ranked rating">Tier</div>
      <div style="width: 70px; text-align: center;" title="Ranked matches played">Ranked</div>
      <div style="width: 70px; text-align: center;" title="Ranked matches finished 1st among the human players">Win rate</div>
      <div style="width: 70px; text-align: center;" title="Average finishing place among the human players">Avg place</div>
      <div style="width: 70px; text-align: right;">Rating</div>
    `;
  } else {
    tabGuilds.classList.add('active');
    tabPlayers.classList.remove('active');
    if (searchEl) searchEl.placeholder = 'Search guilds...';
    header.innerHTML = `
      <div style="width: 50px; text-align: center;">Rank</div>
      <div style="flex: 1;">Guild</div>
      <div style="width: 70px; text-align: center;">Members</div>
      <div style="width: 70px; text-align: center;" title="Guild wars won – lost">W – L</div>
      <div style="width: 70px; text-align: center;">Win rate</div>
      <div style="width: 70px; text-align: right;">Rating</div>
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
      list.innerHTML = `<div style="text-align:center; padding: 20px; color:#888;">${search ? 'No ranked player matches your search.' : 'No ranked players yet — play a Ranked Match to appear here.'}</div>`;
      renderPagination(data.page, data.pages);
      return;
    }

    data.players.forEach((p, index) => {
      // The global position (also when searching), from the server.
      const rank = p.position || (page - 1) * PAGE_SIZE + index + 1;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; padding:10px; background:rgba(255,255,255,0.05); border-radius:4px; cursor:pointer; transition:background 0.2s;';
      row.addEventListener('mouseover', () => { row.style.background = 'rgba(255,255,255,0.1)'; });
      row.addEventListener('mouseout',  () => { row.style.background = 'rgba(255,255,255,0.05)'; });
      row.addEventListener('click', () => showUserProfile(p.username));

      const rankHtml = medal(rank);

      const guildText = p.guild_tag
        ? `<span style="color:${escapeHtml(p.guild_color) || '#ffc107'}; font-size:11px;">[${escapeHtml(p.guild_tag)}]</span> `
        : '';
      const winRate = p.ranked_games > 0 ? Math.round((p.ranked_wins / p.ranked_games) * 100) : 0;
      const winRateColor = winRate >= 50 ? '#4ade80' : (winRate > 0 ? '#fbbf24' : '#888');
      const tier = tierFor(p.elo_rating, p.ranked_games);

      row.innerHTML = `
        <div style="width:50px; text-align:center; font-size:14px; align-self:center;">${rankHtml}</div>
        <div style="flex:1; align-self:center;">${guildText}<span style="font-weight:bold; color:#fff;">${escapeHtml(p.display_name)}</span></div>
        <div style="width:80px; text-align:center; color:${tier.color}; align-self:center; font-size:12px; font-weight:bold;">${tier.name}</div>
        <div style="width:70px; text-align:center; color:#ccc; align-self:center; font-size:13px;">${p.ranked_games}</div>
        <div style="width:70px; text-align:center; color:${winRateColor}; align-self:center; font-size:13px; font-weight:bold;">${winRate}%</div>
        <div style="width:70px; text-align:center; color:#ccc; align-self:center; font-size:13px;">${p.avg_place ? Number(p.avg_place).toFixed(1) : '—'}</div>
        <div style="width:70px; text-align:right; color:#ffc107; font-weight:bold; align-self:center;" title="Peak ${p.peak_rating}">${p.elo_rating}</div>
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
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; padding:10px; background:rgba(255,255,255,0.05); border-radius:4px;';

      // Rated guilds (at least one war) have a global position; the rest are unrated.
      const rankHtml = g.position ? medal(g.position) : '<span style="color:#666; font-size:11px;">—</span>';
      const matches = g.total_guild_wins + g.total_guild_losses;
      const gRate = matches ? Math.round((g.total_guild_wins / matches) * 100) : null;
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
        <div style="width:70px; text-align:center; color:${membersColor}; align-self:center; font-size:13px;">${g.member_count}/${g.max_members}</div>
        <div style="width:70px; text-align:center; color:#ccc; align-self:center; font-size:13px;">${matches ? `${g.total_guild_wins} – ${g.total_guild_losses}` : '—'}</div>
        <div style="width:70px; text-align:center; color:${gRate === null ? '#888' : gRate >= 50 ? '#4ade80' : '#fbbf24'}; align-self:center; font-size:13px; font-weight:bold;">${gRate === null ? '—' : `${gRate}%`}</div>
        <div style="width:70px; text-align:right; color:${matches ? '#ffc107' : '#666'}; font-weight:bold; align-self:center; padding-right:10px;">${matches ? g.elo_rating : 'Unrated'}</div>
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

function medal(rank) {
  if (rank === 1) return '<span style="color:#ffd700; font-weight:bold;">🥇 1</span>';
  if (rank === 2) return '<span style="color:#c0c0c0; font-weight:bold;">🥈 2</span>';
  if (rank === 3) return '<span style="color:#cd7f32; font-weight:bold;">🥉 3</span>';
  return `<span>${rank}</span>`;
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
