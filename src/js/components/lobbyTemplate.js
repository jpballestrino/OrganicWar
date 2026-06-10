export function lobbyTemplate() {
  return `
    <!-- Lobby Browser Modal -->
    <div id="lobbyBrowserOverlay" class="game-overlay"
        style="display: none; pointer-events: auto; justify-content: center; z-index: 1000; background-color: rgba(10, 10, 10, 0.88); backdrop-filter: blur(10px); transition: opacity 0.3s ease;">
        <div class="setup-container">
            <h2
                style="color: #ffc107; text-shadow: 0 0 10px rgba(255, 193, 7, 0.4); font-size: 26px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 20px; text-align: center; font-weight: bold;">
                Lobby Browser</h2>

            <div style="margin-bottom: 16px; display: flex; flex-direction: column; gap: 6px;">
                <label style="font-size: 13px; font-weight: bold; color: #ccc;">Open Games:</label>
                <div id="roomsList"
                    style="display: flex; flex-direction: column; gap: 8px; max-height: 200px; overflow-y: auto; padding-right: 5px;">
                    <div style="color: #888; text-align: center; padding: 10px; font-style: italic;">Fetching lobbies...
                    </div>
                </div>
            </div>

            <div style="display: flex; gap: 10px; margin-top: 20px;">
                <button id="btn-back-lobby" class="home-btn"
                    style="flex: 1; padding: 12px; background-color: #6c757d;">Back</button>
                <button id="btn-show-create" class="home-btn"
                    style="flex: 2; padding: 12px; background-color: #28a745;">Create Custom Game</button>
            </div>
        </div>
    </div>

    <!-- Create Game Modal -->
    <div id="createGameOverlay" class="game-overlay"
        style="display: none; pointer-events: auto; justify-content: center; z-index: 1000; background-color: rgba(10, 10, 10, 0.88); backdrop-filter: blur(10px); transition: opacity 0.3s ease;">
        <div class="setup-container">
            <h2
                style="color: #ffc107; text-shadow: 0 0 10px rgba(255, 193, 7, 0.4); font-size: 26px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 20px; text-align: center; font-weight: bold;">
                Create Game</h2>

            <div style="margin-bottom: 16px; display: flex; flex-direction: column; gap: 6px;">
                <label style="font-size: 13px; font-weight: bold; color: #ccc;">Game Name:</label>
                <input type="text" id="gameNameInput" value="My Epic Battle" maxlength="20"
                    style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 10px; border-radius: 4px; font-size: 14px; outline: none;">
            </div>

            <div style="margin-bottom: 16px; display: flex; flex-direction: column; gap: 6px;">
                <label style="font-size: 13px; font-weight: bold; color: #ccc;">Max Players (2-20):</label>
                <input type="number" id="maxPlayersInput" min="2" max="20" value="5"
                    style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 10px; border-radius: 4px; font-size: 14px; outline: none;">
            </div>

            <div style="margin-bottom: 16px; display: flex; flex-direction: column; gap: 6px;">
                <label style="font-size: 13px; font-weight: bold; color: #ccc;">Map Preset:</label>
                <select id="mapPresetSelect"
                    style="background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 10px; border-radius: 4px; font-size: 14px; outline: none;">
                    <option value="north_america" style="background: #222; color: #fff;">North America</option>
                    <option value="europe" style="background: #222; color: #fff;">Europe</option>
                    <option value="asia" style="background: #222; color: #fff;">Asia</option>
                    <option value="oceania" style="background: #222; color: #fff;">Oceania</option>
                </select>
            </div>

            <div style="display: flex; gap: 10px; margin-top: 20px;">
                <button id="btn-back-create" class="home-btn"
                    style="flex: 1; padding: 12px; background-color: #6c757d;">Back</button>
                <button id="btn-create-room" class="home-btn"
                    style="flex: 2; padding: 12px; background-color: #007bff;">Create & Join</button>
            </div>
        </div>
    </div>

    <!-- Waiting Overlay (For Quick Game and Lobby Waiting) -->
    <div id="waitingOverlay" class="game-overlay"
        style="display: none; pointer-events: auto; justify-content: center; z-index: 1000; background-color: rgba(10, 10, 10, 0.88); backdrop-filter: blur(10px); transition: opacity 0.3s ease;">
        <div class="setup-container" style="text-align: center;">
            <h2 id="waitingTitle"
                style="color: #ffc107; text-shadow: 0 0 10px rgba(255, 193, 7, 0.4); font-size: 26px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 20px; text-align: center; font-weight: bold;">
                Lobby Waiting Room</h2>
            <div id="waitingCountdownText"
                style="font-size: 48px; font-weight: bold; color: #fff; margin-bottom: 20px; display: none;">15s</div>

            <div style="margin-bottom: 16px; display: flex; flex-direction: column; gap: 6px;">
                <label style="font-size: 13px; font-weight: bold; color: #ccc;">Select Your Faction Slot:</label>
                <div style="display: flex; flex-direction: column; gap: 6px;" id="slotsGrid">
                    <!-- Populated dynamically via socket updates -->
                </div>
            </div>

            <div style="display: flex; gap: 10px; margin-top: 20px;">
                <button id="btn-leave-room" class="home-btn"
                    style="flex: 1; padding: 12px; background-color: #dc3545;">Leave Room</button>
                <button id="btn-force-start" class="home-btn"
                    style="flex: 2; padding: 12px; background-color: #28a745;">Start Now (Fill with Bots)</button>
            </div>
        </div>
    </div>
  `;
}
