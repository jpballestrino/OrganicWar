import { showUserProfile } from './authUI.js';
import { getUser } from './auth.js';
import { escapeHtml } from './escape.js';

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
}

async function switchRankingsTab(tabName) {
  const tabPlayers = getE('tabRankingsPlayers');
  const tabGuilds = getE('tabRankingsGuilds');
  const list = getE('rankingsList');
  const header = getE('rankingsHeader');
    
  list.innerHTML = '<div style="text-align:center; padding: 20px; color:#888;">Loading...</div>';

  if (tabName === 'Players') {
    tabPlayers.classList.add('active');
    tabGuilds.classList.remove('active');
    header.innerHTML = `
            <div style="width: 50px; text-align: center;">Rank</div>
            <div style="flex: 1;">Player</div>
            <div style="width: 80px; text-align: center;">Matches</div>
            <div style="width: 100px; text-align: center;">Win Rate</div>
            <div style="width: 80px; text-align: right;">Elo</div>
        `;
    await fetchAndRenderPlayers();
  } else {
    tabGuilds.classList.add('active');
    tabPlayers.classList.remove('active');
    header.innerHTML = `
            <div style="width: 50px; text-align: center;">Rank</div>
            <div style="flex: 1;">Guild</div>
            <div style="width: 80px; text-align: center;">Members</div>
            <div style="width: 100px; text-align: center;">Matches</div>
            <div style="width: 80px; text-align: right;">Elo</div>
            <div style="width: 80px; text-align: center;">Action</div>
        `;
    await fetchAndRenderGuilds();
  }
}

async function fetchAndRenderPlayers() {
  const list = getE('rankingsList');
  try {
    const res = await fetch('/api/rankings/players?limit=100');
    const data = await res.json();
        
    if (!res.ok) {throw new Error(data.error || 'Failed to fetch players');}
        
    list.innerHTML = '';
    if (data.players.length === 0) {
      list.innerHTML = '<div style="text-align:center; padding: 20px; color:#888;">No players found.</div>';
      return;
    }

    data.players.forEach((p, index) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.padding = '10px';
      row.style.background = 'rgba(255,255,255,0.05)';
      row.style.borderRadius = '4px';
      row.style.cursor = 'pointer';
      row.style.transition = 'background 0.2s';
      row.addEventListener('mouseover', () => row.style.background = 'rgba(255,255,255,0.1)');
      row.addEventListener('mouseout', () => row.style.background = 'rgba(255,255,255,0.05)');
            
      row.addEventListener('click', () => {
        showUserProfile(p.username);
      });

      const rank = index + 1;
      let rankHtml = `<span>${rank}</span>`;
      if (rank === 1) {rankHtml = '<span style="color:#ffd700; font-weight:bold;">🥇 1</span>';}
      else if (rank === 2) {rankHtml = '<span style="color:#c0c0c0; font-weight:bold;">🥈 2</span>';}
      else if (rank === 3) {rankHtml = '<span style="color:#cd7f32; font-weight:bold;">🥉 3</span>';}

      let guildText = p.guild_tag ? `<span style="color:${escapeHtml(p.guild_color) || '#ffc107'}; font-size:11px;">[${escapeHtml(p.guild_tag)}]</span> ` : '';
      let winRate = p.total_games > 0 ? Math.round((p.total_wins / p.total_games) * 100) : 0;
      let winRateColor = winRate >= 50 ? '#4ade80' : (winRate > 0 ? '#f87171' : '#888');

      row.innerHTML = `
                <div style="width: 50px; text-align: center; font-size: 14px; align-self: center;">${rankHtml}</div>
                <div style="flex: 1; align-self: center;">
                    ${guildText}<span style="font-weight:bold; color:#fff;">${escapeHtml(p.display_name)}</span>
                </div>
                <div style="width: 80px; text-align: center; color:#ccc; align-self: center; font-size:13px;">${p.total_games}</div>
                <div style="width: 100px; text-align: center; color:${winRateColor}; align-self: center; font-size:13px; font-weight:bold;">${winRate}%</div>
                <div style="width: 80px; text-align: right; color:#ffc107; font-weight:bold; align-self: center;">${p.elo_rating}</div>
            `;
      list.appendChild(row);
    });
  } catch (err) {
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'color:red; text-align:center; padding:20px;';
    errDiv.textContent = `Error: ${err.message}`;
    list.replaceChildren(errDiv);
  }
}

async function fetchAndRenderGuilds() {
  const list = getE('rankingsList');
  try {
    const res = await fetch('/api/rankings/guilds?limit=20');
    const data = await res.json();
        
    if (!res.ok) {throw new Error(data.error || 'Failed to fetch guilds');}
        
    list.innerHTML = '';
    if (data.guilds.length === 0) {
      list.innerHTML = '<div style="text-align:center; padding: 20px; color:#888;">No guilds found.</div>';
      return;
    }

    const currentUser = getUser();

    data.guilds.forEach((g, index) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.padding = '10px';
      row.style.background = 'rgba(255,255,255,0.05)';
      row.style.borderRadius = '4px';

      const rank = index + 1;
      let rankHtml = `<span>${rank}</span>`;
      if (rank === 1) {rankHtml = '<span style="color:#ffd700; font-weight:bold;">🥇 1</span>';}
      else if (rank === 2) {rankHtml = '<span style="color:#c0c0c0; font-weight:bold;">🥈 2</span>';}
      else if (rank === 3) {rankHtml = '<span style="color:#cd7f32; font-weight:bold;">🥉 3</span>';}

      let matches = g.total_guild_wins + g.total_guild_losses;
      let membersColor = g.member_count >= g.max_members ? '#f87171' : '#4ade80';

      let actionHtml = '';
      let canJoin = false;
      let canRequest = false;
            
      if (g.member_count >= g.max_members) {
        actionHtml = '<span style="color:#888; font-size:11px; text-transform:uppercase;">Full</span>';
      } else if (currentUser && !(currentUser.guildId || currentUser.guild_id)) {
        if (g.is_open) {
          canJoin = true;
          actionHtml = '<button class="home-btn home-btn-play join-btn" style="padding: 4px 10px; font-size:11px; margin:0; width:100%;">Join</button>';
        } else {
          canRequest = true;
          actionHtml = '<button class="home-btn join-btn" style="padding: 4px 10px; font-size:11px; margin:0; width:100%; background: #3c8cdc;">Request</button>';
        }
      } else {
        actionHtml = '';
      }

      row.innerHTML = `
                <div style="width: 50px; text-align: center; font-size: 14px; align-self: center;">${rankHtml}</div>
                <div style="flex: 1; align-self: center;">
                    <span style="color:${escapeHtml(g.color) || '#ffc107'}; font-weight:bold;">[${escapeHtml(g.tag)}]</span>
                    <span style="color:#fff;">${escapeHtml(g.name)}</span>
                </div>
                <div style="width: 80px; text-align: center; color:${membersColor}; align-self: center; font-size:13px;">${g.member_count}/${g.max_members}</div>
                <div style="width: 100px; text-align: center; color:#ccc; align-self: center; font-size:13px;">${matches}</div>
                <div style="width: 80px; text-align: right; color:#ffc107; font-weight:bold; align-self: center; padding-right:10px;">${g.elo_rating}</div>
                <div style="width: 80px; text-align: center; align-self: center;" class="action-container">
                    ${actionHtml}
                </div>
            `;
            
      if (canJoin) {
        const btn = row.querySelector('.join-btn');
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.joinGuild) {
            window.joinGuild(g.id, btn);
          }
        });
      } else if (canRequest) {
        const btn = row.querySelector('.join-btn');
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.requestGuildJoin) {
            window.requestGuildJoin(g.id, btn);
          }
        });
      }

      list.appendChild(row);
    });
  } catch (err) {
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'color:red; text-align:center; padding:20px;';
    errDiv.textContent = `Error: ${err.message}`;
    list.replaceChildren(errDiv);
  }
}
