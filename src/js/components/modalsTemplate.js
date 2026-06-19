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
        <div class="setup-container profile-container" style="width: 450px;">
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
                <div style="display: flex; justify-content: space-between; font-size: 12px; color: #ccc; margin-bottom: 4px;">
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
        <div class="modal-card" style="width: 620px; max-height: 82vh;">
            <div class="modal-header">
                <span class="modal-title">📖 How to Play OrganicWar.io</span>
                <button id="btnCloseTutorial" class="modal-close">&times;</button>
            </div>

            <div style="font-size: 14px; line-height: 1.7; color: #ccc;">
                <h3 style="color: #ffc107; margin-top: 0; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 1px;">🎮 The Basics</h3>
                <p>Welcome to <strong>OrganicWar.io</strong>, a real-time multiplayer territory-conquest game! Your goal is to expand your empire, build defenses, and eliminate rival factions to dominate the map.</p>

                <h3 style="color: #ffc107; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 1px;">⚔️ Conquest &amp; Expansion</h3>
                <ul style="padding-left: 20px; margin-bottom: 20px;">
                    <li><strong>Attack / Expand:</strong> Click on neutral land or enemy territory to start an attack front. Your troops push forward automatically.</li>
                    <li><strong>Cancel Specific Attack:</strong> Right-click on a faction's territory to cancel your attack against that specific enemy.</li>
                    <li><strong>Cancel All Attacks:</strong> Press <strong>Space</strong> to instantly refund and cancel all active attacks.</li>
                    <li><strong>Troops &amp; Gold:</strong> Troop cap, growth rate, and gold income all scale with territory owned.</li>
                </ul>

                <h3 style="color: #ffc107; font-family: 'Orbitron', sans-serif; font-size: 13px; letter-spacing: 1px;">🛡️ Buildings &amp; Weapons</h3>
                <ul style="padding-left: 20px; margin-bottom: 20px;">
                    <li><strong>Defense Tower (Press '3'):</strong> Costs 2,000 gold. Grants a massive defense bonus to surrounding cells. Takes 5s to build.</li>
                    <li><strong>Missile Silo (Press '4'):</strong> Costs 10,000 gold. Required to fire missiles. Takes 10s to build. Survives partial conquest.</li>
                    <li><strong>Fire Missile (Press '2'):</strong> Costs 2,000 gold. Target any enemy cell within silo range. Obliterates troops and buildings in a large radius.</li>
                    <li><strong>Gold Mine (Press '5'):</strong> Costs 3,000 gold. Boosts your global gold production by 10%.</li>
                    <li><strong>Anti-Air Battery (Press '6'):</strong> Costs 4,000 gold. Intercepts incoming missiles. Holds 3 charges.</li>
                    <li><em>Right-click cancels any active building or targeting mode.</em></li>
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
        <div class="setup-container profile-container" style="width: 600px; max-height: 80vh; display: flex; flex-direction: column;">
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
