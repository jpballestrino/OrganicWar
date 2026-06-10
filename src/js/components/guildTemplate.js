export function guildTemplate() {
  return `
    <!-- Guild Hall Modal -->
    <div id="guildHallOverlay" class="game-overlay"
        style="display: none; pointer-events: auto; justify-content: center; z-index: 1040; background-color: rgba(10, 10, 10, 0.9); backdrop-filter: blur(10px); transition: opacity 0.3s ease;">
        <div class="setup-container" style="width: 550px; position: relative;">
            <button id="btn-close-guild-hall"
                style="position: absolute; top: 15px; right: 20px; background: transparent; border: none; color: #aaa; font-size: 20px; cursor: pointer;">✕</button>
            <h2
                style="color: #ffc107; font-size: 24px; text-transform: uppercase; font-weight: bold; margin-bottom: 20px; text-align: center;">
                <span style="font-size: 28px;">🛡️</span> Guild Hall
            </h2>

            <div id="guildErrorMsg"
                style="display:none; color: #ff6b6b; background: rgba(220,53,69,0.2); padding: 10px; border-radius: 5px; margin-bottom: 15px; text-align: center; border: 1px solid rgba(220,53,69,0.4);">
            </div>

            <!-- View A: No Guild -->
            <div id="guildViewNoGuild" style="display: none;">
                <div style="display: flex; gap: 10px; margin-bottom: 20px; justify-content: center;">
                    <button id="tabCreateGuild" class="active"
                        style="flex: 1; padding: 10px; background-color: #ffc107; color: #000; font-weight: bold; border-radius: 8px; border: none; cursor: pointer; transition: all 0.2s ease;">Create
                        Guild</button>
                    <button id="tabSearchGuilds"
                        style="flex: 1; padding: 10px; background-color: rgba(255,193,7,0.2); border: 1px solid #ffc107; color: #ffc107; border-radius: 8px; cursor: pointer; transition: all 0.2s ease;">Join
                        Guild</button>
                    <button id="tabPendingInvites"
                        style="flex: 1; padding: 10px; background-color: rgba(255,193,7,0.2); border: 1px solid #ffc107; color: #ffc107; position: relative; border-radius: 8px; cursor: pointer; transition: all 0.2s ease;">
                        Invites
                        <div id="inviteTabBadge"
                            style="display:none; position:absolute; top:-5px; right:-5px; background:red; color:white; font-size:10px; border-radius:50%; padding:2px 6px;">
                            0</div>
                    </button>
                </div>

                <div id="panelCreateGuild">
                    <input type="text" id="cgName" placeholder="Guild Name (3-25 chars)" maxlength="25"
                        style="width:100%; margin-bottom:10px; padding:10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.2); color:#fff; border-radius:5px;">
                    <input type="text" id="cgTag" placeholder="Tag (2-5 chars, e.g. WAR)" maxlength="5"
                        style="width:100%; margin-bottom:10px; padding:10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.2); color:#fff; border-radius:5px; text-transform:uppercase;">
                    <input type="text" id="cgDesc" placeholder="Description (optional, max 100)" maxlength="100"
                        style="width:100%; margin-bottom:10px; padding:10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.2); color:#fff; border-radius:5px;">
                    <div style="margin-bottom: 15px;">
                        <label style="font-size: 12px; color: #ccc;">Guild Color:</label>
                        <div id="cgColorPicker" style="display:flex; gap: 5px; margin-top: 5px;"></div>
                    </div>
                    <button id="btnCreateGuildSubmit"
                        style="width: 100%; padding: 12px; background-color: #28a745; border-radius: 8px; border: none; color: white; font-weight: bold; cursor: pointer; transition: all 0.2s ease;">Create Guild</button>
                </div>

                <div id="panelSearchGuilds" style="display:none;">
                    <input type="text" id="searchInputGuilds" placeholder="Search by name or tag..."
                        style="width:100%; margin-bottom:15px; padding:10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.2); color:#fff; border-radius:5px;">
                    <div id="guildSearchResults"
                        style="max-height: 250px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;">
                    </div>
                </div>

                <div id="panelPendingInvites" style="display:none;">
                    <div id="guildInvitesList"
                        style="max-height: 250px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;">
                    </div>
                </div>
            </div>

            <!-- View B: In Guild -->
            <div id="guildViewInGuild" style="display: none;">
                <div
                    style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid rgba(255,255,255,0.1);">
                    <div>
                        <div style="display:flex; align-items:center; gap:10px;">
                            <h3 id="guildTitleText" style="color: #ffc107; font-size: 22px; margin: 0;">[TAG] Guild Name
                            </h3>
                            <span id="guildRoleBadge"
                                style="background:rgba(255,255,255,0.1); padding:2px 8px; border-radius:12px; font-size:11px; color:#ccc;">Role</span>
                        </div>
                        <div id="guildDescText"
                            style="color: #aaa; font-size: 13px; margin-top: 5px; font-style: italic;">Guild description
                            goes here...</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 20px; font-weight: bold; color: #4ade80;">🏆 <span
                                id="guildEloText">1000</span></div>
                        <div style="font-size: 12px; color: #888;">ELO Rating</div>
                    </div>
                </div>

                <div style="display: flex; gap: 10px; margin-bottom: 20px;">
                    <button id="tabGuildRoster"
                        style="flex: 1; padding: 8px; background-color: #ffc107; color: #000; font-weight: bold; border-radius: 8px; border: none; cursor: pointer; transition: all 0.2s ease;">Roster</button>
                    <button id="tabGuildWar"
                        style="flex: 1; padding: 8px; background-color: rgba(220,53,69,0.2); border: 1px solid #dc3545; color: #ff6b6b; font-weight: bold; border-radius: 8px; cursor: pointer; transition: all 0.2s ease;">⚔️
                        Guild War</button>
                    <button id="tabGuildSettings"
                        style="flex: 1; padding: 8px; background-color: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #ccc; border-radius: 8px; cursor: pointer; transition: all 0.2s ease;">Settings</button>
                </div>

                <!-- Roster View -->
                <div id="guildRosterView">
                    <div
                        style="display:flex; justify-content:space-between; margin-bottom:10px; font-size:12px; color:#888; font-weight:bold; padding:0 5px;">
                        <span>Member</span>
                        <span>Role</span>
                        <span>ELO</span>
                    </div>
                    <div id="guildMemberList"
                        style="display: flex; flex-direction: column; overflow-y: auto; flex: 1; gap: 5px;"></div>
                    <div id="guildRequestsContainer"
                        style="display: none; border-top: 1px solid rgba(255,255,255,0.1); margin-top: 10px; padding-top: 10px;">
                        <div style="font-size: 12px; font-weight: bold; color: #ffc107; margin-bottom: 8px;">Pending
                            Join Requests</div>
                        <div id="guildRequestsList"
                            style="display: flex; flex-direction: column; max-height: 150px; overflow-y: auto;"></div>
                    </div>
                </div>

                <!-- Guild War View -->
                <div id="guildWarView" style="display:none; text-align:center;">
                    <div
                        style="background: rgba(220,53,69,0.1); border: 1px solid rgba(220,53,69,0.3); padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                        <h4 style="color: #ff6b6b; margin-top:0; margin-bottom: 10px; font-size: 16px;">Queue for
                            Matchmaking</h4>
                        <p style="font-size: 13px; color: #ccc; margin-bottom: 15px;">Queue up your guild for a
                            competitive match. Only leaders/officers can queue. All human members in your lobby will
                            join the match when found.</p>

                        <div
                            style="display:flex; gap:10px; justify-content:center; align-items:center; margin-bottom:15px;">
                            <label style="color:#fff; font-size:14px;">Team Size:</label>
                            <select id="guildWarSizeSelect"
                                style="background: rgba(0,0,0,0.5); border: 1px solid #555; color: #fff; padding: 5px 10px; border-radius: 4px;">
                                <option value="2">2v2</option>
                                <option value="3">3v3</option>
                                <option value="5">5v5</option>
                            </select>
                        </div>

                        <div id="guildWarQueueControls">
                            <button id="btnGuildWarQueue"
                                style="padding: 10px 20px; background-color: #dc3545; border: none; cursor: pointer; color: white; font-weight: bold; border-radius: 20px; font-size: 15px; transition: all 0.2s ease;">⚔️
                                Find Match</button>
                        </div>
                        <div id="guildWarQueuedState" style="display:none;">
                            <div style="color:#ffc107; font-weight:bold; margin-bottom:10px; font-size:15px;">Searching
                                for opponent... <span id="guildWarQueueTime">0:00</span></div>
                            <button id="btnGuildWarDequeue"
                                style="padding: 6px 15px; background-color: #6c757d; color: white; border-radius: 8px; border: none; cursor: pointer; transition: all 0.2s ease;">Cancel
                                Queue</button>
                        </div>
                    </div>

                    <div style="border-top:1px solid rgba(255,255,255,0.1); padding-top:15px; margin-top:15px;">
                        <h4 style="color: #ccc; margin-top:0; margin-bottom: 10px; font-size: 14px;">Direct Challenge
                        </h4>
                        <div style="display:flex; gap:10px; justify-content:center;">
                            <input type="text" id="directChallengeTag" placeholder="Guild TAG" maxlength="5"
                                style="width:100px; padding:8px; background:rgba(0,0,0,0.5); border:1px solid #555; color:#fff; border-radius:4px; text-transform:uppercase;">
                            <button id="btnDirectChallenge"
                                style="padding: 8px 15px; background-color: #17a2b8; border-radius: 8px; border: none; color: white; font-weight: bold; cursor: pointer; transition: all 0.2s ease;">Send Challenge</button>
                        </div>
                    </div>
                </div>

                <div id="guildSettingsView" style="display:none; margin-top: 15px;"></div>
            </div>
        </div>
    </div>

    <!-- Guild Invite Modal -->
    <div id="guildInviteModal" class="game-overlay"
        style="display: none; pointer-events: auto; justify-content: center; z-index: 1060; background-color: rgba(10, 10, 10, 0.88); backdrop-filter: blur(10px); transition: opacity 0.3s ease;">
        <div class="setup-container" style="width: 380px; padding: 32px; box-sizing: border-box;">
            <h2
                style="color: #ffc107; text-shadow: 0 0 10px rgba(255, 193, 7, 0.4); font-size: 24px; text-transform: uppercase; letter-spacing: 1px; margin-top: 0; margin-bottom: 20px; text-align: center; font-weight: bold; font-family: 'Orbitron', sans-serif;">
                Invite Player</h2>
            <div id="inviteErrorMsg"
                style="display:none; color: #ff6b6b; font-size: 13px; margin-bottom: 15px; background: rgba(220,53,69,0.1); border: 1px solid rgba(220,53,69,0.3); padding: 8px; border-radius: 4px; text-align: center;">
            </div>
            <div style="margin-bottom: 24px;">
                <label
                    style="display: block; font-size: 12px; font-weight: bold; color: #ccc; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 1px;">Player
                    Username</label>
                <input type="text" id="inviteUsername" placeholder="Enter username..."
                    style="width: 100%; padding: 14px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.15); color: #fff; border-radius: 8px; font-size: 15px; outline: none; transition: border-color 0.2s, box-shadow 0.2s; box-sizing: border-box;"
                    onfocus="this.style.borderColor='#ffc107'; this.style.boxShadow='0 0 8px rgba(255,193,7,0.3)';"
                    onblur="this.style.borderColor='rgba(255,255,255,0.15)'; this.style.boxShadow='none';">
            </div>
            <div style="display: flex; gap: 12px; margin-top: 10px;">
                <button id="btnCancelInvite" class="home-btn"
                    style="flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 12px; font-size: 14px;">Cancel</button>
                <button id="btnSendInvite" class="home-btn home-btn-play"
                    style="flex: 1; padding: 12px; font-size: 14px;">Invite</button>
            </div>
        </div>
    </div>

    <!-- Guild Edit Modal -->
    <div id="guildEditModal" class="game-overlay"
        style="display: none; pointer-events: auto; justify-content: center; z-index: 1065; background-color: rgba(10, 10, 10, 0.88); backdrop-filter: blur(10px); transition: opacity 0.3s ease;">
        <div class="setup-container" style="width: 440px; padding: 32px; box-sizing: border-box;">
            <h2
                style="color: #ffc107; text-shadow: 0 0 10px rgba(255, 193, 7, 0.4); font-size: 24px; text-transform: uppercase; letter-spacing: 1px; margin-top: 0; margin-bottom: 20px; text-align: center; font-weight: bold; font-family: 'Orbitron', sans-serif;">
                Edit Settings</h2>
            <div id="editGuildErrorMsg"
                style="display:none; color: #ff6b6b; font-size: 13px; margin-bottom: 15px; background: rgba(220,53,69,0.1); border: 1px solid rgba(220,53,69,0.3); padding: 8px; border-radius: 4px; text-align: center;">
            </div>

            <div style="margin-bottom: 20px;">
                <label
                    style="display: block; font-size: 12px; font-weight: bold; color: #ccc; text-transform: uppercase; margin-bottom: 8px; letter-spacing: 1px;">Description</label>
                <textarea id="egDesc" placeholder="Enter guild description..." maxlength="100"
                    style="width: 100%; padding: 14px; background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.15); color: #fff; border-radius: 8px; font-size: 14px; outline: none; transition: border-color 0.2s, box-shadow 0.2s; box-sizing: border-box; resize: vertical; min-height: 80px;"
                    onfocus="this.style.borderColor='#ffc107'; this.style.boxShadow='0 0 8px rgba(255,193,7,0.3)';"
                    onblur="this.style.borderColor='rgba(255,255,255,0.15)'; this.style.boxShadow='none';"></textarea>
            </div>

            <div
                style="margin-bottom: 20px; display: flex; align-items: center; gap: 12px; background: rgba(0,0,0,0.2); padding: 12px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
                <input type="checkbox" id="egIsOpen"
                    style="width: 18px; height: 18px; accent-color: #ffc107; cursor: pointer;">
                <label for="egIsOpen" style="font-size: 14px; color: #eee; cursor: pointer; user-select: none;">Open to
                    public joining</label>
            </div>

            <div style="margin-bottom: 28px;">
                <label
                    style="display: block; font-size: 12px; font-weight: bold; color: #ccc; text-transform: uppercase; margin-bottom: 10px; letter-spacing: 1px;">Guild
                    Color</label>
                <div id="egColorPicker" style="display:flex; flex-wrap: wrap; gap: 8px;"></div>
            </div>

            <div style="display: flex; gap: 12px;">
                <button id="btnCancelGuildEdit" class="home-btn"
                    style="flex: 1; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 12px; font-size: 14px;">Cancel</button>
                <button id="btnSaveGuildEdit" class="home-btn home-btn-play"
                    style="flex: 1; padding: 12px; font-size: 14px;">Save Settings</button>
            </div>
        </div>
    </div>

    <!-- Guild Chat Panel (Floating) -->
    <div id="guildChatPanel"
        style="display:none; position:fixed; bottom:20px; right:20px; width:320px; background:rgba(15,15,20,0.9); border:1px solid rgba(255,193,7,0.3); border-radius:10px; z-index:1070; box-shadow:0 10px 30px rgba(0,0,0,0.5); backdrop-filter:blur(10px); flex-direction:column; max-height:400px;">
        <div id="guildChatHeader"
            style="padding:10px; border-bottom:1px solid rgba(255,255,255,0.1); display:flex; justify-content:space-between; align-items:center; cursor:pointer; background:rgba(0,0,0,0.4); border-radius:10px 10px 0 0;">
            <div style="font-family:'Orbitron', sans-serif; font-size:14px; color:#ffc107; font-weight:bold;">
                <span class="home-input-icon" style="position:static; margin-right:5px;">💬</span> Guild Chat
            </div>
            <div id="guildChatToggleIcon" style="color:#aaa; font-size:12px;">▼</div>
        </div>
        <div id="guildChatBody" style="display:flex; flex-direction:column; height:300px; position:relative;">
            <div id="guildChatMessages"
                style="flex:1; padding:10px; overflow-y:auto; display:flex; flex-direction:column; gap:8px;">
                <!-- Messages injected here -->
            </div>
            <div id="emojiPickerContainer" style="display:none; position:absolute; bottom:50px; right:10px; z-index:1000; box-shadow:0 4px 15px rgba(0,0,0,0.5); border-radius:8px;"></div>
            <div
                style="padding:10px; border-top:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.3); border-radius:0 0 10px 10px; display:flex; gap:8px; align-items:center;">
                <button id="btnEmojiToggle" style="background:transparent; border:none; cursor:pointer; font-size:18px; padding:0; filter:grayscale(0.2); transition:filter 0.2s;" onmouseover="this.style.filter='grayscale(0)'" onmouseout="this.style.filter='grayscale(0.2)'">😀</button>
                <input type="text" id="guildChatInput" placeholder="Type message..." maxlength="200"
                    style="flex:1; padding:8px 12px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); color:#fff; border-radius:15px; outline:none; font-family:'Inter'; box-sizing:border-box; font-size:13px;">
            </div>
        </div>
    </div>
  `;
}
