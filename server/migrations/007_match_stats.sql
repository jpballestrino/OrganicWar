-- Competitive statistics per match: which mode it was, where the player
-- finished (among all factions and among the humans) and, for ranked
-- matches, the rating change and the rating afterwards.
ALTER TABLE match_history ADD COLUMN mode TEXT NOT NULL DEFAULT 'casual';
ALTER TABLE match_history ADD COLUMN placement INTEGER;
ALTER TABLE match_history ADD COLUMN players INTEGER;
ALTER TABLE match_history ADD COLUMN human_place INTEGER;
ALTER TABLE match_history ADD COLUMN humans INTEGER;
ALTER TABLE match_history ADD COLUMN elo_delta INTEGER NOT NULL DEFAULT 0;
ALTER TABLE match_history ADD COLUMN elo_after INTEGER;
-- Guild wars recorded before this migration.
UPDATE match_history SET mode = 'guild' WHERE is_guild_match = 1;
CREATE INDEX IF NOT EXISTS idx_match_history_user_mode ON match_history(user_id, mode);
CREATE INDEX IF NOT EXISTS idx_match_history_mode ON match_history(mode);
