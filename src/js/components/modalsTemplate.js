export function modalsTemplate() {
  return `
    <!-- Incoming Guild War Challenge Modal -->
    <div id="incomingWarModal"
        style="display: none; position: fixed; left: 50%; top: 20%; transform: translate(-50%, -50%); border: 2px solid #ff6b6b; z-index: 1050; box-shadow: 0 0 30px rgba(220, 53, 69, 0.6); width: 350px; background: rgba(15,15,20,0.95); border-radius: 10px; padding: 20px;">
        <div
            style="font-size: 20px; font-weight: bold; color: #ff6b6b; margin-bottom: 15px; text-align: center; text-transform: uppercase;">
            ⚔️ Guild War Challenge!</div>
        <div style="text-align: center; margin-bottom: 20px; color: #fff;">
            Guild <span id="challengerGuildName" style="color: #ffc107; font-weight: bold;">[TAG]</span> has challenged
            your guild to a <span id="challengerTeamSize" style="color:#4ade80; font-weight:bold;">5v5</span> battle!
        </div>
        <div style="display: flex; gap: 10px;">
            <button id="btnAcceptWar" class="shop-btn"
                style="flex: 1; text-align: center; background: rgba(40, 167, 69, 0.8); border: 1px solid #28a745; color: white;">Accept
                War</button>
            <button id="btnDeclineWar" class="shop-btn"
                style="flex: 1; text-align: center; background: rgba(220, 53, 69, 0.8); border: 1px solid #dc3545; color: white;">Decline</button>
        </div>
        <div style="text-align: center; margin-top: 10px; font-size: 11px; color: #888;">Auto-declines in <span
            id="warChallengeTimer">60</span>s</div>
    </div>

    <!-- Match Found Prompt (For all members) -->
    <div id="warMatchFoundModal"
        style="display: none; position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 1055; width: 500px; text-align: center; background: rgba(15, 10, 10, 0.95); border: 2px solid #ffc107; border-radius: 10px; padding: 30px; box-shadow: 0 0 50px rgba(255, 193, 7, 0.5); pointer-events: auto;">
        <h1
            style="color: #ffc107; font-size: 40px; margin-top: 0; margin-bottom: 10px; font-family: 'Orbitron', sans-serif;">
            WAR FOUND!</h1>
        <h3 style="color: #fff; margin-bottom: 30px; font-weight: normal;">Your Guild vs <span id="matchedGuildTag"
                style="color: #ff6b6b; font-weight: bold;">[ENEMY]</span></h3>
        <p style="color: #aaa; margin-bottom: 25px; font-size: 14px;">The lobby is ready. Join now to claim your faction
            slot. First come, first served for the <span id="matchedTeamSize">5</span> available slots!</p>
        <button id="btnJoinWarLobby" class="home-btn"
            style="padding: 15px 40px; font-size: 20px; background: #28a745; color: white; font-weight: bold; text-transform: uppercase; border-radius: 30px; box-shadow: 0 0 20px rgba(40, 167, 69, 0.6); border: 2px solid #3bd95d; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; width: auto; margin: 0 auto;">JOIN
            BATTLE</button>
    </div>

    <!-- Profile Modal -->
    <div id="profileModal" class="game-overlay"
        style="display: none; pointer-events: auto; justify-content: center; z-index: 1060; background-color: rgba(10, 10, 10, 0.88); backdrop-filter: blur(10px); transition: opacity 0.3s ease;">
        <div class="setup-container profile-container" style="width: 450px;">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px; margin-bottom: 15px;">
                <div style="font-size: 14px; font-weight: bold; color: #888; text-transform: uppercase; letter-spacing: 1px;">Commander Profile</div>
                <button id="btn-close-profile" style="background: transparent; border: none; color: #aaa; font-size: 24px; cursor: pointer; transition: color 0.2s; padding: 0; line-height: 1;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='#aaa'">&times;</button>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px;">
                <div>
                    <h2 id="profileDisplayName"
                        style="color: #ffc107; font-size: 24px; text-transform: uppercase; font-weight: bold; margin: 0; text-shadow: 0 0 10px rgba(255, 193, 7, 0.4);">
                        Player</h2>
                    <div id="profileUsername" style="color: #888; font-size: 14px; margin-top: 4px;">@username</div>
                    <div id="profileGuildBadge"
                        style="display: none; margin-top: 8px; font-size: 12px; background: rgba(255, 193, 7, 0.1); border: 1px solid rgba(255, 193, 7, 0.3); color: #ffc107; padding: 2px 8px; border-radius: 4px; width: fit-content;">
                        [TAG] Guild</div>
                </div>
                <div style="text-align: right;">
                    <div id="profileRankTier" style="font-size: 18px; font-weight: bold; color: #ccc;">Unranked</div>
                    <div id="profileEloRating" style="font-size: 14px; color: #888; margin-top: 4px;">1000 ELO</div>
                </div>
            </div>

            <div class="profile-stats-grid"
                style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 15px;">
                <div class="stat-box"
                    style="background: rgba(255, 255, 255, 0.05); padding: 10px; border-radius: 6px; text-align: center; border: 1px solid rgba(255,255,255,0.1);">
                    <div style="font-size: 11px; color: #888; text-transform: uppercase;">Wins</div>
                    <div id="profileWins" style="font-size: 20px; color: #4ade80; font-weight: bold;">0</div>
                </div>
                <div class="stat-box"
                    style="background: rgba(255, 255, 255, 0.05); padding: 10px; border-radius: 6px; text-align: center; border: 1px solid rgba(255,255,255,0.1);">
                    <div style="font-size: 11px; color: #888; text-transform: uppercase;">Losses</div>
                    <div id="profileLosses" style="font-size: 20px; color: #f87171; font-weight: bold;">0</div>
                </div>
                <div class="stat-box"
                    style="background: rgba(255, 255, 255, 0.05); padding: 10px; border-radius: 6px; text-align: center; border: 1px solid rgba(255,255,255,0.1);">
                    <div style="font-size: 11px; color: #888; text-transform: uppercase;">Games</div>
                    <div id="profileGames" style="font-size: 20px; color: #60a5fa; font-weight: bold;">0</div>
                </div>
            </div>

            <div style="margin-bottom: 20px;">
                <div
                    style="display: flex; justify-content: space-between; font-size: 12px; color: #ccc; margin-bottom: 4px;">
                    <span>Win Rate</span>
                    <span id="profileWinRateText">0%</span>
                </div>
                <div style="width: 100%; height: 6px; background: #333; border-radius: 3px; overflow: hidden;">
                    <div id="profileWinRateBar"
                        style="height: 100%; width: 0%; background: #ffc107; border-radius: 3px; transition: width 0.5s ease;">
                    </div>
                </div>
            </div>

            <div style="margin-bottom: 20px;">
                <h3
                    style="font-size: 14px; color: #ccc; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px; margin-bottom: 10px;">
                    Recent Matches</h3>
                <div id="profileHistoryList"
                    style="max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;">
                    <div style="text-align: center; color: #666; font-size: 13px; padding: 10px;">No recent matches
                        found.</div>
                </div>
            </div>

        </div>
    </div>

    <!-- Dummy elements for alliance variables to prevent JS reference crashes -->
    <div id="allianceModal" style="display: none;">
        <div id="allianceCurrentStatus"></div>
        <div id="alliancePlayersList"></div>
        <button id="closeAllianceBtn"></button>
    </div>
    <div id="allianceProposalModal" style="display: none;">
        <div id="allianceProposalText"></div>
        <button id="btnAcceptAlliance"></button>
        <button id="btnRejectAlliance"></button>
    </div>

    <!-- Tutorial / Template Info Modal -->
    <div id="tutorialModal"
        style="display: none; position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 600px; max-height: 80vh; z-index: 1100; background: rgba(15,15,20,0.98); border: 2px solid #00e5ff; border-radius: 10px; padding: 25px; box-shadow: 0 0 30px rgba(0, 229, 255, 0.3); overflow-y: auto; color: #fff;">
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px; margin-bottom: 15px;">
            <div style="font-size: 24px; font-weight: bold; color: #00e5ff; font-family: 'Orbitron', sans-serif;">📖 Developer Template Info</div>
            <button id="btnCloseTutorial" style="background: transparent; border: none; color: #fff; font-size: 20px; cursor: pointer;">&times;</button>
        </div>
        
        <div style="font-size: 14px; line-height: 1.6; color: #ccc;">
            <h3 style="color: #00e5ff; margin-top: 0;">🎮 Project Architecture</h3>
            <p>Welcome to <strong>OrganicWar.io</strong>. This is a blank starter dashboard designed for multiplayer game prototypes. It provides all outer-game mechanics, leaving a clean workspace to build your game logic.</p>
            
            <h3 style="color: #00e5ff;">✨ Included Features</h3>
            <ul style="padding-left: 20px; margin-bottom: 20px;">
                <li><strong>Authentication:</strong> User sign up, login, forgot password resets, guest sessions, and token persistence.</li>
                <li><strong>Guild System:</strong> Roster management, request system, chat logs with emojis, guild ELO, and guild matchmaking searches.</li>
                <li><strong>Lobby & Matchmaker:</strong> Create custom lobbies, choose map size presets, and auto-matchmaking queues.</li>
                <li><strong>Profile ELO System:</strong> Global rankings leaderboard, match history records, and dynamic win-rate tracking.</li>
            </ul>

            <h3 style="color: #00e5ff;">🧪 How to Test</h3>
            <ul style="padding-left: 20px; margin-bottom: 20px;">
                <li><strong>1. Open Multiple Sessions:</strong> Open two browser tabs (one in incognito mode).</li>
                <li><strong>2. Create custom lobby:</strong> Log in on both accounts (or play as Guest) and navigate to the Lobby Browser to create a lobby.</li>
                <li><strong>3. Claim slot & Start:</strong> Select slots on both screens, then press <strong>Start Now</strong> on the host tab.</li>
                <li><strong>4. Simulate Win/Loss:</strong> You will see the developer sandbox matching screen. Click <strong>Simulate Victory</strong> or <strong>Simulate Defeat</strong>.</li>
                <li><strong>5. Verify DB:</strong> Check the Profile Modal or the Rankings Leaderboard to confirm that ELO rating changes and Match History logs were saved to the SQLite database.</li>
            </ul>

            <h3 style="color: #00e5ff;">⚙️ Customizing the Game Screen</h3>
            <p>To implement your custom gameplay logic, graphics, and network syncer:</p>
            <ul style="padding-left: 20px; margin-bottom: 10px;">
                <li>Add your Canvas drawing scripts or UI loops inside <code>src/js/components/gameUITemplate.js</code>.</li>
                <li>Write game-state handling in <code>src/js/network.js</code> and client main loops in <code>src/main.js</code>.</li>
                <li>Extend the room instance in <code>server/game/roomManager.js</code>.</li>
            </ul>
        </div>
    </div>

    <!-- Rankings Modal -->
    <div id="rankingsModal" class="game-overlay"
        style="display: none; pointer-events: auto; justify-content: center; z-index: 1045; background-color: rgba(10, 10, 10, 0.95); backdrop-filter: blur(10px); transition: opacity 0.3s ease;">
        <div class="setup-container profile-container" style="width: 600px; max-height: 80vh; display: flex; flex-direction: column;">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 15px; margin-bottom: 20px;">
                <div style="font-size: 24px; font-weight: bold; color: #ffc107; font-family: 'Orbitron', sans-serif;">🏆 Global Rankings</div>
                <button id="btnCloseRankings" style="background: transparent; border: none; color: #fff; font-size: 24px; cursor: pointer;">&times;</button>
            </div>
            
            <div class="auth-tabs" style="margin-bottom: 15px; justify-content: center; gap: 20px;">
                <button class="auth-tab active" id="tabRankingsPlayers" style="flex: none; padding: 10px 30px;">Players</button>
                <button class="auth-tab" id="tabRankingsGuilds" style="flex: none; padding: 10px 30px;">Guilds</button>
            </div>

            <div style="flex: 1; overflow-y: auto; background: rgba(0,0,0,0.3); border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); padding: 10px;">
                <!-- Header Row -->
                <div id="rankingsHeader" style="display: flex; padding: 10px; font-weight: bold; font-size: 12px; color: #888; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 5px;">
                    <div style="width: 50px; text-align: center;">Rank</div>
                    <div style="flex: 1;">Player</div>
                    <div style="width: 80px; text-align: center;">Matches</div>
                    <div style="width: 100px; text-align: center;">Win Rate</div>
                    <div style="width: 80px; text-align: right;">Elo</div>
                </div>
                
                <!-- List Content -->
                <div id="rankingsList" style="display: flex; flex-direction: column; gap: 5px;">
                    <div style="text-align:center; padding: 20px; color:#888;">Loading...</div>
                </div>
            </div>
        </div>
    </div>
  `;
}
