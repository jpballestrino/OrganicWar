export function homeTemplate() {
    return `
    <!-- Home Title Screen -->
    <div id="homeScreen" class="game-overlay home-overlay">
        <div class="home-container">
            <!-- Stylized Logo -->
            <div class="home-logo">
                <h1 class="home-title">
                    <span class="home-title-main">ORGANICWAR</span><span class="home-title-io">.io</span>
                </h1>
                <div class="home-tagline">Conquer the map</div>
            </div>

            <!-- STATE A: Auth / Guest -->
            <div id="homeStateAuth" style="display: none;">
                <div class="auth-tabs">
                    <button class="auth-tab active" id="tabLogin">Login</button>
                    <button class="auth-tab" id="tabRegister">Register</button>
                </div>

                <!-- Login Form -->
                <div id="formLogin" class="auth-form active">
                    <div class="home-input-group">
                        <label class="home-label">USERNAME</label>
                        <div class="home-input-wrap">
                            <span class="home-input-icon">👤</span>
                            <input type="text" id="loginUsername" placeholder="Enter your username" autocomplete="off">
                        </div>
                    </div>
                    <div class="home-input-group">
                        <label class="home-label">PASSWORD</label>
                        <div class="home-input-wrap">
                            <span class="home-input-icon">🔑</span>
                            <input type="password" id="loginPassword" placeholder="Enter your password" autocomplete="off">
                        </div>
                    </div>
                    <div id="loginError" class="auth-error"></div>
                    <div style="text-align: right; margin-top: 5px;">
                        <a href="#" id="linkForgotPassword"
                            style="color: #ffc107; font-size: 12px; text-decoration: none;">Forgot Password?</a>
                    </div>
                    <button id="btnLoginSubmit" class="home-btn home-btn-play" style="margin-top: 15px; width: 100%;">
                        <span class="home-btn-icon">🔓</span>
                        <span class="home-btn-text">Login</span>
                    </button>

                    <!-- OAuth Divider -->
                    <div class="auth-oauth-divider"
                        style="display: flex; align-items: center; gap: 10px; margin: 20px 0;">
                        <div style="flex: 1; height: 1px; background: rgba(255,255,255,0.15);"></div>
                        <span
                            style="color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">or</span>
                        <div style="flex: 1; height: 1px; background: rgba(255,255,255,0.15);"></div>
                    </div>
                    <!-- OAuth Buttons -->
                    <div class="auth-oauth-buttons" style="display: flex; flex-direction: column; gap: 10px;">
                        <button id="btnGoogleLogin" class="home-btn"
                            style="background: #4285f4; border: 1px solid #5a95f5; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 12px; cursor: pointer; border-radius: 6px; color: #fff; font-weight: 600; font-size: 14px; transition: all 0.2s;">
                            <svg width="20" height="20" viewBox="0 0 48 48">
                                <path fill="#EA4335"
                                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                                <path fill="#4285F4"
                                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                                <path fill="#FBBC05"
                                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                                <path fill="#34A853"
                                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                            </svg>
                            <span>Sign in with Google</span>
                        </button>
                        <button id="btnDiscordLogin" class="home-btn"
                            style="background: #5865F2; border: 1px solid #7289da; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 12px; cursor: pointer; border-radius: 6px; color: #fff; font-weight: 600; font-size: 14px; transition: all 0.2s;">
                            <svg width="20" height="20" viewBox="0 0 71 55" fill="white">
                                <path
                                    d="M60.1 4.9A58.5 58.5 0 0045.4.2a.2.2 0 00-.2.1 40.8 40.8 0 00-1.8 3.7 54 54 0 00-16.2 0A37.3 37.3 0 0025.4.3a.2.2 0 00-.2-.1 58.4 58.4 0 00-14.7 4.6.2.2 0 00-.1.1C1.5 18.7-.9 32 .3 45.1v.1a58.7 58.7 0 0017.9 9.1.2.2 0 00.3-.1 42 42 0 003.6-5.9.2.2 0 00-.1-.3 38.7 38.7 0 01-5.5-2.7.2.2 0 01 0-.4c.4-.3.7-.6 1.1-.9a.2.2 0 01.2 0c11.5 5.3 24 5.3 35.4 0a.2.2 0 01.2 0l1.1.9a.2.2 0 010 .4c-1.8 1-3.6 1.9-5.5 2.7a.2.2 0 00-.1.3 47.1 47.1 0 003.6 5.9.2.2 0 00.3.1A58.5 58.5 0 0070.7 45.2v-.1c1.4-14.8-2.3-27.6-9.8-39a.2.2 0 00-.1-.1zM23.7 37c-3.4 0-6.2-3.1-6.2-7s2.7-7 6.2-7 6.3 3.2 6.2 7-2.8 7-6.2 7zm22.9 0c-3.4 0-6.2-3.1-6.2-7s2.7-7 6.2-7 6.3 3.2 6.2 7-2.7 7-6.2 7z" />
                            </svg>
                            <span>Sign in with Discord</span>
                        </button>
                    </div>
                </div>

                <!-- Forgot Password Form (hidden by default, replaces login form) -->
                <div id="forgotPasswordForm" style="display: none;">
                    <div class="home-input-group">
                        <label class="home-label">ENTER YOUR EMAIL</label>
                        <div class="home-input-wrap">
                            <span class="home-input-icon">📧</span>
                            <input type="email" id="forgotEmail" placeholder="commander@domain.com">
                        </div>
                    </div>
                    <div id="forgotError" class="auth-error"></div>
                    <div id="forgotSuccess"
                        style="display:none; color: #4ade80; background: rgba(40,167,69,0.2); padding: 10px; border-radius: 5px; margin-bottom: 10px; text-align: center; border: 1px solid rgba(40,167,69,0.4); font-size: 13px;">
                    </div>
                    <button id="btnForgotSubmit" class="home-btn home-btn-play" style="margin-top: 10px;">
                        <span class="home-btn-icon">📧</span>
                        <span class="home-btn-text">Send Reset Link</span>
                    </button>
                    <div style="text-align: center; margin-top: 10px;">
                        <a href="#" id="linkBackToLogin" style="color: #ccc; font-size: 12px; text-decoration: none;">←
                            Back to Login</a>
                    </div>
                </div>

                <!-- Register Form -->
                <div id="formRegister" class="auth-form">
                    <div class="home-input-group">
                        <label class="home-label">USERNAME</label>
                        <div class="home-input-wrap">
                            <span class="home-input-icon">👤</span>
                            <input type="text" id="regUsername" maxlength="20" placeholder="username"
                                autocomplete="off">
                        </div>
                    </div>
                    <div class="home-input-group">
                        <label class="home-label">EMAIL</label>
                        <div class="home-input-wrap">
                            <span class="home-input-icon">📧</span>
                            <input type="email" id="regEmail" placeholder="commander@domain.com">
                        </div>
                    </div>
                    <div class="home-input-group">
                        <label class="home-label">PASSWORD</label>
                        <div class="home-input-wrap">
                            <span class="home-input-icon">🔑</span>
                            <input type="password" id="regPassword" placeholder="••••••••">
                        </div>
                    </div>
                    <div id="regError" class="auth-error"></div>
                    <button id="btnRegSubmit" class="home-btn home-btn-play" style="margin-top: 15px; width: 100%;">
                        <span class="home-btn-icon">📝</span>
                        <span class="home-btn-text">Create Account</span>
                    </button>
                </div>

                <div class="auth-guest-link">
                    <a href="#" id="linkGuest">⚔️ Play as Guest</a>
                </div>
            </div>

            <!-- STATE A-2: Guest Nickname Entry -->
            <div id="homeStateGuest" style="display: none;">
                <div class="home-input-group">
                    <label for="nicknameInput" class="home-label">GUEST CALLSIGN</label>
                    <div class="home-input-wrap">
                        <span class="home-input-icon">⚔️</span>
                        <input type="text" id="nicknameInput" maxlength="15" placeholder="Enter guest callsign..."
                            autocomplete="off">
                    </div>
                </div>
                <div class="home-buttons">
                    <button id="btn-quick-play-guest" class="home-btn home-btn-play">
                        <span class="home-btn-icon">⚔️</span>
                        <span class="home-btn-text">Quick Battle</span>
                    </button>
                    <button id="btn-multiplayer-guest" class="home-btn home-btn-lobby">
                        <span class="home-btn-icon">🏛️</span>
                        <span class="home-btn-text">Lobby Browser</span>
                    </button>
                </div>
                <div class="auth-guest-link" style="margin-top: 15px;">
                    <a href="#" id="linkBackToAuth">← Back to Login</a>
                </div>
            </div>

            <!-- STATE B: Logged In -->
            <div id="homeStateLoggedIn" style="display: none;">
                <div class="auth-welcome">
                    <h2 id="lblWelcomeName">Welcome, Commander</h2>
                    <div class="auth-stats">
                        <span class="stat-badge" id="lblElo">ELO: 1000</span>
                        <span class="stat-badge guild-badge" id="lblGuild" style="display:none;">[TAG] GuildName</span>
                    </div>
                </div>

                <div class="home-buttons">
                    <button id="btn-quick-play" class="home-btn home-btn-play">
                        <span class="home-btn-icon">⚔️</span>
                        <span class="home-btn-text">Quick Battle</span>
                    </button>
                    <button id="btn-ranked-play" class="home-btn home-btn-ranked">
                        <span class="home-btn-icon">🌟</span>
                        <span class="home-btn-text">Ranked Match</span>
                    </button>
                    <button id="btn-multiplayer" class="home-btn home-btn-lobby">
                        <span class="home-btn-icon">🏛️</span>
                        <span class="home-btn-text">Lobby Browser</span>
                    </button>
                    <button id="btn-guild-hall" class="home-btn home-btn-lobby" style="position: relative;">
                        <span class="home-btn-icon">🛡️</span>
                        <span class="home-btn-text">Guild Hall</span>
                        <div id="guildInviteBadge"
                            style="display:none; position:absolute; top:-5px; right:-5px; background:red; color:white; font-size:10px; border-radius:50%; padding:2px 6px;">
                            0</div>
                    </button>
                    <button id="btn-show-rankings" class="home-btn home-btn-lobby">
                        <span class="home-btn-icon">🏆</span>
                        <span class="home-btn-text">Rankings</span>
                    </button>
                </div>
            </div>

            <!-- STATE C: Ranked Queue -->
            <div id="homeStateRankedQueue" style="display: none; flex-direction: column; align-items: center;">
                <div class="auth-welcome" style="text-align: center; width: 100%;">
                    <h2 style="color: #ffc107;">Queueing for Ranked...</h2>
                    <div style="font-size: 32px; font-weight: bold; margin: 15px 0; font-family: monospace;" id="lblRankedTimer">00:00</div>
                    <div style="color: #aaa; margin-bottom: 20px; font-size: 16px;" id="lblRankedPlayers">Players: 1/20</div>
                </div>
                <div class="home-buttons" style="width: 100%;">
                    <button id="btn-leave-ranked" class="home-btn" style="background: rgba(220, 53, 69, 0.2); border: 1px solid #dc3545;">
                        <span class="home-btn-icon">✖</span>
                        <span class="home-btn-text">Leave Queue</span>
                    </button>
                    <!-- Hidden dev force start -->
                    <button id="btn-force-start-ranked" style="position: absolute; top:0; right:0; opacity:0; width:20px; height:20px; z-index:9999; cursor:pointer;"></button>
                </div>
            </div>

            <div class="home-footer">
                <span>v1.0.0</span>
                <span class="home-footer-dot">•</span>
                <span id="homePlayersOnline">Players Online: —</span>
                <span class="home-footer-dot">•</span>
                <a href="#" id="linkTutorial" style="color: #4ade80; text-decoration: none; font-weight: bold;">📖 How to Play</a>
                <span class="home-footer-dot auth-footer-links" style="display:none;">•</span>
                <a href="#" id="linkProfile" class="auth-footer-links"
                    style="display:none; color: #ccc; text-decoration: none;">Profile</a>
                <span class="home-footer-dot auth-footer-links" style="display:none;">•</span>
                <a href="#" id="linkLogout" class="auth-footer-links"
                    style="display:none; color: #ff6b6b; text-decoration: none;">Logout</a>
            </div>
        </div>
    </div>
  `;
}
