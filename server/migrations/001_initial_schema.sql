-- User accounts
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    total_wins INTEGER DEFAULT 0,
    total_losses INTEGER DEFAULT 0,
    total_games INTEGER DEFAULT 0,
    total_cells_conquered INTEGER DEFAULT 0,
    total_kills INTEGER DEFAULT 0,
    elo_rating INTEGER DEFAULT 1000,
    guild_id INTEGER REFERENCES guilds(id) ON DELETE SET NULL,
    is_banned INTEGER DEFAULT 0
);
-- Guilds (clans/teams)
CREATE TABLE IF NOT EXISTS guilds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL COLLATE NOCASE,
    tag TEXT UNIQUE NOT NULL COLLATE NOCASE,
    description TEXT DEFAULT '',
    leader_id INTEGER NOT NULL REFERENCES users(id),
    color TEXT DEFAULT '#ffc107',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    member_count INTEGER DEFAULT 1,
    total_guild_wins INTEGER DEFAULT 0,
    elo_rating INTEGER DEFAULT 1000,
    max_members INTEGER DEFAULT 20,
    is_open INTEGER DEFAULT 1
);
-- Guild membership with roles
CREATE TABLE IF NOT EXISTS guild_members (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, guild_id)
);
-- Guild invitations
CREATE TABLE IF NOT EXISTS guild_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    inviter_id INTEGER NOT NULL REFERENCES users(id),
    invitee_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Guild chat messages
CREATE TABLE IF NOT EXISTS guild_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Match history for stat tracking
CREATE TABLE IF NOT EXISTS match_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id),
    faction_id INTEGER NOT NULL,
    result TEXT NOT NULL,
    cells_conquered INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0,
    gold_earned INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    is_guild_match INTEGER DEFAULT 0,
    guild_id INTEGER REFERENCES guilds(id),
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_guild_members_guild ON guild_members(guild_id);
CREATE INDEX IF NOT EXISTS idx_match_history_user ON match_history(user_id);
CREATE INDEX IF NOT EXISTS idx_guild_invites_invitee ON guild_invites(invitee_id);
CREATE INDEX IF NOT EXISTS idx_guild_chat_guild ON guild_chat_messages(guild_id);
