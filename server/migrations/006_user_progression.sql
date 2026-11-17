-- Commander progression (XP, level, day streak, daily missions) for logged-in
-- players, scored on the server from its own match results. One JSON profile
-- per user; the shape is defined by normalizeProfile() in src/js/progression.js.
CREATE TABLE IF NOT EXISTS user_progression (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    profile TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
