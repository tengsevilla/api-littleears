-- Play tracking for admin stats (CLAUDE.md "Play tracking + admin stats"). Additive only: one new table.
-- One row per counted play: a song (song_id) or a looping sound (sound_slug), never both.
-- No child id and no device info is stored.
--
-- "Exactly one of song_id / sound_slug" is enforced in the model (plays.model.ts), not with a CHECK:
-- MySQL 8 rejects a CHECK constraint on a column that is used by a foreign key with ON DELETE CASCADE
-- (error 3823), and song_id must cascade so deleting a song deletes its plays.
--
-- song_id / user_id match songs.id / users.id: CHAR(36), utf8mb4, utf8mb4_general_ci (table default).
-- Indexes: played_at serves the range totals and the daily chart; (song_id, played_at) the top songs;
-- (sound_slug, played_at) the top sounds; (user_id, played_at) the 30 s per-user dedupe.
CREATE TABLE play_events (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     CHAR(36) NOT NULL,
  song_id     CHAR(36) NULL,
  sound_slug  VARCHAR(40) NULL,
  played_at   DATETIME NOT NULL,                -- UTC; when the play happened on the device
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_play_events_played (played_at),
  INDEX idx_play_events_song_played (song_id, played_at),
  INDEX idx_play_events_sound_played (sound_slug, played_at),
  INDEX idx_play_events_user_played (user_id, played_at),
  CONSTRAINT fk_play_events_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_play_events_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
