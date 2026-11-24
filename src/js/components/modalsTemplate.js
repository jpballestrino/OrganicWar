export function modalsTemplate() {
  return `
    <!-- Incoming Guild War Challenge Modal -->
    <div id="incomingWarModal" class="modal-float" style="display: none; z-index: 1050;">
        <div class="modal-card" style="width: 360px;">
            <div class="modal-header">
                <span class="modal-title">⚔️ War Challenge</span>
            </div>
            <div style="text-align: center; margin-bottom: 20px; color: #ccc; font-size: 14px; line-height: 1.7;">
                Guild <span id="challengerGuildName" style="color: #ffc107; font-weight: bold;">[TAG]</span> has challenged
                your guild to a <span id="challengerTeamSize" style="color: #4ade80; font-weight: bold;">5v5</span> battle!
            </div>
            <div class="modal-actions">
                <button id="btnAcceptWar" class="modal-btn modal-btn-primary">Accept War</button>
                <button id="btnDeclineWar" class="modal-btn modal-btn-danger">Decline</button>
            </div>
            <div style="text-align: center; margin-top: 12px; font-size: 11px; color: #555;">
                Auto-declines in <span id="warChallengeTimer">60</span>s
            </div>
        </div>
    </div>

    <!-- Match Found Prompt (For all members) -->
    <div id="warMatchFoundModal" class="modal-float" style="display: none; z-index: 1055;">
        <div class="modal-card" style="width: 480px; text-align: center;">
            <div style="font-family: 'Orbitron', sans-serif; font-size: 34px; font-weight: 900; color: #ffc107; margin-bottom: 10px; text-shadow: 0 0 20px rgba(255,193,7,0.35); letter-spacing: 2px;">WAR FOUND!</div>
            <div style="color: #ccc; font-size: 16px; margin-bottom: 10px;">
                Your Guild vs <span id="matchedGuildTag" style="color: #ff6b6b; font-weight: bold;">[ENEMY]</span>
            </div>
            <div style="color: #888; margin-bottom: 28px; font-size: 13px; line-height: 1.6;">
                The lobby is ready. Join now to claim your faction slot. First come, first served for the
                <span id="matchedTeamSize">5</span> available slots!
            </div>
            <button id="btnJoinWarLobby" class="modal-btn modal-btn-primary" style="width: 100%; padding: 16px; font-size: 15px;">JOIN BATTLE</button>
        </div>
    </div>

    <!-- Profile Modal -->
    <div id="profileModal" class="game-overlay"
        style="display: none; pointer-events: auto; justify-content: center; z-index: 1060;">
        <div class="setup-container profile-container" style="width: 520px; max-width: 94vw;">
            <div class="modal-header">
                <span class="modal-title" style="font-size: 13px;">Commander Profile</span>
                <button id="btn-close-profile" class="modal-close">&times;</button>
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
                    <div id="profileEloRating" style="font-size: 14px; color: #888; margin-top: 4px;">1000 rating</div>
                    <div id="profilePosition" style="font-size: 12px; color: #ffc107; margin-top: 2px;"></div>
                </div>
            </div>

            <!-- Ranked: rating, leaderboard position, record (filled by authUI.renderProfileModal) -->
            <div class="profile-section-title">Ranked</div>
            <div id="profileRankedStats" class="profile-stats-grid"></div>
            <div id="profileTierProgress" class="profile-tier-progress"></div>

            <div class="profile-section-title">All modes</div>
            <div id="profileOverallStats" class="profile-stats-grid"></div>

            <div class="profile-section-title">Recent form</div>
            <div id="profileForm" class="profile-form"></div>

            <div style="margin-bottom: 20px;">
                <h3 style="font-size: 14px; color: #ccc; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 4px; margin-bottom: 10px;">
                    Recent Matches</h3>
                <div id="profileHistoryList"
                    style="max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;">
                    <div style="text-align: center; color: #666; font-size: 13px; padding: 10px;">No recent matches found.</div>
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

    <!-- How to Play Modal -->
    <div id="tutorialModal" class="modal-float" style="display: none; z-index: 1100;">
        <div class="modal-card" style="width: 680px; max-height: 86vh; box-sizing: border-box;">
            <div class="modal-header">
                <span class="modal-title">📖 How to Play OrganicWar.io</span>
                <button id="btnCloseTutorial" class="modal-close">&times;</button>
            </div>

            <div class="tutorial-body" style="font-size: 14px; line-height: 1.7; color: #ccc;">
                <h3 style="color: #ffc107; margin-top: 0; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 1px;">🎮 The Basics</h3>
                <p>Welcome to <strong>OrganicWar.io</strong>, a real-time territory-conquest game. Grow your empire, build up your economy and defenses, and break your rivals before they break you.</p>
                <ul style="padding-left: 20px; margin-bottom: 20px;">
                    <li><strong>Pick a start:</strong> At the start of a match you have 8 seconds to click a land spot to begin from (each start has a small safe zone around it). If you don't pick, you're placed automatically.</li>
                    <li><strong>Troops &amp; gold:</strong> Your troop cap, troop growth and gold income all grow with the land you hold. Troops grow fastest when your army is around 40% full, so keeping troops on the attack pays.</li>
                    <li><strong>Leaderboard:</strong> Top right. Below it you can see how close the biggest empire is to winning.</li>
                </ul>

                <h3 style="color: #ffc107; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 1px;">⚔️ Conquest &amp; Expansion</h3>
                <ul style="padding-left: 20px; margin-bottom: 20px;">
                    <li><strong>Attack / Expand:</strong> Click neutral land to expand, or an enemy's land to attack that faction only. Your troops push forward along the whole border on their own.</li>
                    <li><strong>Attack size:</strong> The Attack slider (or <strong>Shift + mouse wheel</strong>) sets what share of your troops each click sends.</li>
                    <li><strong>Cancel:</strong> Right-click a faction's land to call off the attack on it (right-click your own land to stop expanding). <strong>Space</strong> calls off every attack and refunds the troops.</li>
                    <li><strong>Blitz (Press '1'):</strong> For 6 seconds your attacks advance twice as fast and pay 40% less to take enemy land. Recharges in 45 seconds, so save it for the breakthrough.</li>
                    <li><strong>Bounty:</strong> When one empire runs away with the map (over twice its fair share and 1.5× the runner-up), it gets a 🎯 bounty. Everyone else pays 25% fewer troops to take its land and earns gold for every cell taken.</li>
                    <li><strong>Plunder:</strong> Eliminate a rival and you take their whole treasury. Razing an enemy Defense Tower pays 1,000 gold of salvage.</li>
                </ul>

                <h3 style="color: #ffc107; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 1px;">🗺️ The Map</h3>
                <p style="margin-top: 0;">Seven maps: North America, Europe, Africa, South America, Asia, Oceania and the generated supercontinent Pangaea. Land is harder to take on rough ground; hover over a special spot to see what it does.</p>
                <ul style="padding-left: 20px; margin-bottom: 20px;">
                    <li><strong>Highlands &amp; mountains:</strong> Cost more troops to attack, so they make good borders to hold.</li>
                    <li><strong>🌲 Forests:</strong> Three times slower to claim, and costly to attack.</li>
                    <li><strong>🌊 River fords:</strong> Five times slower to claim. Rivers make natural frontiers.</li>
                    <li><strong>💰 Gold deposits:</strong> Each cell you hold pays extra gold every second (30 times a normal cell).</li>
                    <li><strong>🏛️ Ruins:</strong> Ten times slower to claim, but every cell taken pays 8 gold.</li>
                    <li><strong>Bridges:</strong> Islands are joined to the mainland by narrow land bridges, so every empire can be reached on foot.</li>
                </ul>

                <h3 style="color: #ffc107; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 1px;">🌫️ Fog of War &amp; Minimap</h3>
                <ul style="padding-left: 20px; margin-bottom: 20px;">
                    <li><strong>What you see:</strong> Your land and about 48 cells around it are live. Beyond that, the map shows the rough shape of each empire, dimmed, and enemy buildings stay hidden.</li>
                    <li><strong>Silos see far:</strong> A finished Missile Silo reveals everything it can hit, so you can always see where you're aiming.</li>
                    <li><strong>Minimap:</strong> Bottom left: the whole map, every empire, and a frame for what your camera shows. Click or drag on it to jump there.</li>
                    <li><strong>Spectating:</strong> Once you're eliminated, you can stay and watch the rest of the match with the whole map revealed.</li>
                </ul>

                <h3 style="color: #ffc107; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 1px;">🏆 How to Win</h3>
                <ul style="padding-left: 20px; margin-bottom: 20px;">
                    <li><strong>Domination:</strong> Hold 65% of all land and you win immediately.</li>
                    <li><strong>Sudden death:</strong> After 3 minutes the domination target starts falling (5% every 30 seconds, down to 40%), so the biggest empire has to be stopped or it wins.</li>
                    <li><strong>Last standing:</strong> Or simply eliminate every rival.</li>
                </ul>

                <h3 style="color: #ffc107; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 1px;">🎲 Game Modes</h3>
                <ul style="padding-left: 20px; margin-bottom: 20px;">
                    <li><strong>Quick Battle:</strong> 20 commanders, a random map; bots take the empty slots. About 3–4 minutes.</li>
                    <li><strong>Mega Battle:</strong> 64 commanders on a bigger map, with the same rules. About 4–5 minutes.</li>
                    <li><strong>Ranked:</strong> For logged-in players. You're matched with players of a similar rating, and your rating moves with where you finish among them (leaving early ranks you last).</li>
                    <li><strong>Guild Wars:</strong> Two guilds, 2, 3 or 5 players a side, no bots. Teammates can't attack each other and share their view of the map. A team wins by being the last one standing or by holding 75% of the land together (falling to 50% from 4 minutes). Only the guilds' ratings change.</li>
                    <li><strong>Custom rooms:</strong> Create a room from the lobby, pick the map and size, and invite friends.</li>
                </ul>

                <h3 style="color: #ffc107; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 1px;">🛡️ Buildings &amp; Weapons</h3>
                <p style="margin-top: 0;">Every building needs an 8×8 patch of your own land and a few seconds to finish. Prices below are for your first building of each type; each further one of the same type costs 25% more.</p>
                <ul style="padding-left: 20px; margin-bottom: 20px;">
                    <li><strong>Defense Tower (Press '3'):</strong> 2,000 gold, 5 s. Makes the land around it far more costly to attack.</li>
                    <li><strong>Missile Silo (Press '4'):</strong> 10,000 gold, 10 s. Needed to fire missiles; reaches 240 cells. It survives partial conquest and only changes hands when an enemy takes its whole footprint.</li>
                    <li><strong>Fire Missile (Press '2'):</strong> 2,000 gold. Aim at any enemy land within a silo's range. The blast wipes out troops and buildings in a wide radius and turns the land neutral.</li>
                    <li><strong>Gold Mine (Press '5'):</strong> 3,000 gold, 10 s. +10% gold income.</li>
                    <li><strong>Anti-Air Battery (Press '6'):</strong> 5,000 gold, 10 s. Shoots down missiles aimed at you that pass within 400 cells. Holds 3 interceptors.</li>
                    <li><strong>City (Press '7'):</strong> 2,000 gold, 5 s. +5% maximum population.</li>
                </ul>

                <h3 style="color: #ffc107; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 1px;">🔗 Synergies</h3>
                <p style="margin-top: 0;">Two of your finished buildings within 60 cells of each other <strong>link up</strong> (a glowing line on the map). While placing, the preview shows which links you would form.</p>
                <ul style="padding-left: 20px; margin-bottom: 20px;">
                    <li><strong>Walled City</strong> (City + Defense Tower): the city gives +10% population instead of +5%.</li>
                    <li><strong>Workforce</strong> (Gold Mine + City): the mine gives +15% gold instead of +10%.</li>
                    <li><strong>Radar Guidance</strong> (Missile Silo + Anti-Air): the silo fires 25% farther (and sees 25% farther).</li>
                    <li><strong>Arms Industry</strong> (Missile Silo + Gold Mine): missiles from that silo cost 25% less.</li>
                    <li><strong>Flak Battery</strong> (Anti-Air + Defense Tower): the battery regains an interceptor every 20 seconds.</li>
                </ul>

                <h3 style="color: #ffc107; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 1px;">⌨️ Controls</h3>
                <ul style="padding-left: 20px; margin-bottom: 4px;">
                    <li><strong>Click:</strong> attack / expand. <strong>Right-click:</strong> cancel an attack, or the current build mode.</li>
                    <li><strong>1–7:</strong> Blitz, missile and buildings. <strong>Esc</strong> cancels a build or targeting mode (pressed again, it opens the menu).</li>
                    <li><strong>Space:</strong> call off all attacks.</li>
                    <li><strong>Drag</strong> or <strong>WASD</strong> / arrow keys: move the camera. <strong>Mouse wheel:</strong> zoom. <strong>Shift + wheel:</strong> attack size.</li>
                </ul>
            </div>
        </div>
    </div>

    <!-- Feedback Modal -->
    <div id="feedbackModal" class="modal-float" style="z-index: 1200;">
        <div class="modal-card" style="width: 460px;">
            <div class="modal-header">
                <span class="modal-title">📣 Send Feedback</span>
                <button id="btnCloseFeedback" class="modal-close">&times;</button>
            </div>

            <!-- Success state -->
            <div id="feedbackSuccess" style="display: none; text-align: center; padding: 16px 0 8px;">
                <div style="font-size: 52px; margin-bottom: 14px; line-height: 1;">✅</div>
                <div style="font-size: 17px; font-weight: bold; color: #4ade80; margin-bottom: 8px;">Report Sent!</div>
                <div style="font-size: 13px; color: #888; line-height: 1.7;">Thanks for helping improve OrganicWar.io.<br>We'll look into it soon.</div>
                <button id="btnFeedbackDone" class="modal-btn modal-btn-neutral" style="margin-top: 24px; max-width: 160px;">Close</button>
            </div>

            <!-- Form state -->
            <div id="feedbackFormBody">
                <!-- Type selector -->
                <div style="display: flex; gap: 8px; margin-bottom: 18px;">
                    <button class="feedback-type-btn active" data-type="bug">🐛 Bug</button>
                    <button class="feedback-type-btn" data-type="suggestion">💡 Suggestion</button>
                    <button class="feedback-type-btn" data-type="other">💬 Other</button>
                </div>

                <!-- Subject -->
                <div style="margin-bottom: 14px;">
                    <label style="font-size: 11px; color: #777; text-transform: uppercase; letter-spacing: 1px; display: block; margin-bottom: 6px;">Subject</label>
                    <input id="feedbackSubject" type="text" maxlength="80" placeholder="Brief one-line summary..."
                        style="width: 100%; padding: 9px 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #fff; font-size: 13px; outline: none; font-family: inherit; box-sizing: border-box; transition: border-color 0.2s;">
                </div>

                <!-- Description -->
                <div style="margin-bottom: 14px;">
                    <label style="font-size: 11px; color: #777; text-transform: uppercase; letter-spacing: 1px; display: block; margin-bottom: 6px;">Description</label>
                    <textarea id="feedbackDescription" maxlength="2000" rows="4" placeholder="Describe in detail — what happened, what you expected, or what you'd like to see..."
                        style="width: 100%; padding: 9px 12px; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; color: #fff; font-size: 13px; outline: none; font-family: inherit; resize: vertical; min-height: 90px; box-sizing: border-box; transition: border-color 0.2s;"></textarea>
                    <div id="feedbackDescCount" style="font-size: 11px; color: #555; text-align: right; margin-top: 3px;">0 / 2000</div>
                </div>

                <!-- Error -->
                <div id="feedbackError" style="display: none; color: #f87171; font-size: 12px; margin-top: 12px; padding: 8px 12px; background: rgba(239,68,68,0.08); border-radius: 6px; border: 1px solid rgba(239,68,68,0.2);"></div>

                <div class="modal-actions">
                    <button id="btnFeedbackCancel" class="modal-btn modal-btn-neutral">Cancel</button>
                    <button id="btnFeedbackSubmit" class="modal-btn modal-btn-gold">Send Report →</button>
                </div>
            </div>
        </div>
    </div>

    <!-- Rankings Modal -->
    <div id="rankingsModal" class="game-overlay"
        style="display: none; pointer-events: auto; justify-content: center; z-index: 1045;">
        <div class="setup-container profile-container" style="width: 740px; max-width: 94vw; max-height: 80vh; display: flex; flex-direction: column;">
            <div class="modal-header">
                <span class="modal-title">🏆 Global Rankings</span>
                <button id="btnCloseRankings" class="modal-close">&times;</button>
            </div>

            <div class="auth-tabs" style="margin-bottom: 12px; justify-content: center; gap: 20px;">
                <button class="auth-tab active" id="tabRankingsPlayers" style="flex: none; padding: 10px 30px;">Players</button>
                <button class="auth-tab" id="tabRankingsGuilds" style="flex: none; padding: 10px 30px;">Guilds</button>
            </div>

            <div style="margin-bottom: 10px; flex-shrink: 0;">
                <input id="rankingsSearch" type="text" placeholder="Search players..."
                    style="width: 100%; padding: 8px 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; color: #fff; font-size: 13px; outline: none; font-family: inherit; box-sizing: border-box;"
                    autocomplete="off" spellcheck="false">
            </div>

            <div style="flex: 1; min-height: 0; overflow-y: auto; background: rgba(0,0,0,0.3); border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); padding: 10px;">
                <div id="rankingsHeader" style="display: flex; padding: 10px; font-weight: bold; font-size: 12px; color: #888; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 5px;">
                    <div style="width: 50px; text-align: center;">Rank</div>
                    <div style="flex: 1;">Player</div>
                    <div style="width: 80px; text-align: center;">Matches</div>
                    <div style="width: 100px; text-align: center;">Win Rate</div>
                    <div style="width: 80px; text-align: right;">Elo</div>
                </div>
                <div id="rankingsList" style="display: flex; flex-direction: column; gap: 5px;">
                    <div style="text-align:center; padding: 20px; color:#888;">Loading...</div>
                </div>
            </div>

            <div id="rankingsPagination" style="display: flex; justify-content: center; align-items: center; gap: 15px; padding: 10px 0 0; flex-shrink: 0;">
                <button id="rankingsPrevBtn" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 6px 14px; border-radius: 5px; cursor: pointer; font-size: 13px; font-family: inherit;">← Prev</button>
                <span id="rankingsPageInfo" style="color: #888; font-size: 13px; min-width: 90px; text-align: center;">Page 1 of 1</span>
                <button id="rankingsNextBtn" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #fff; padding: 6px 14px; border-radius: 5px; cursor: pointer; font-size: 13px; font-family: inherit;">Next →</button>
            </div>
        </div>
    </div>
  `;
}
