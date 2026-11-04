-- LittleEars schema — source of truth (PROJECT.md §6). Keep in sync with schema/migrations/.
-- Target: MariaDB 11.4 locally / MySQL 8 on Railway. JSON = LONGTEXT alias on MariaDB.

CREATE TABLE users (
  id            CHAR(36) PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin','parent') NOT NULL DEFAULT 'parent', -- seed account = admin; invitees = parent
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE children (
  id            CHAR(36) PRIMARY KEY,
  user_id       CHAR(36) NOT NULL,
  display_name  VARCHAR(40) NOT NULL,          -- first name / nickname only
  phonetic_name VARCHAR(80) NULL,              -- used in lyrics sent to music provider
  age_band      ENUM('1-2','3-5') NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_children_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE songs (
  id             CHAR(36) PRIMARY KEY,
  user_id        CHAR(36) NOT NULL,
  child_id       CHAR(36) NULL,                -- NULL = generic song; set = personalized
  topic          VARCHAR(120) NOT NULL,
  mood           ENUM('playful','calm','lullaby') NOT NULL,
  age_band       ENUM('1-2','3-5') NOT NULL,
  length_sec     SMALLINT NOT NULL,            -- 60 | 90 | 120
  status         VARCHAR(20) NOT NULL DEFAULT 'queued',
  title          VARCHAR(120) NULL,
  lyrics         JSON NULL,                    -- string[]
  music_prompt   TEXT NULL,
  image_prompt   TEXT NULL,
  safety_result  JSON NULL,                    -- { pass, reasons[] }
  raw_audio_key  VARCHAR(255) NULL,
  audio_key      VARCHAR(255) NULL,            -- normalized MP3
  image_key      VARCHAR(255) NULL,
  video_key      VARCHAR(255) NULL,            -- phase 3, unused in MVP
  duration_ms    INT NULL,
  error          TEXT NULL,
  approved_at    DATETIME NULL,
  owner_deleted_at   DATETIME NULL,            -- creator deleted a shared song (soft delete; stays in the catalog)
  catalog_removed_at DATETIME NULL,            -- admin removed it from the catalog
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)  REFERENCES users(id)    ON DELETE CASCADE,
  CONSTRAINT fk_songs_child FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE RESTRICT, -- app deletes a child's songs first (R4)
  INDEX idx_songs_child (child_id),
  INDEX idx_songs_user_status (user_id, status),
  INDEX idx_songs_user_created (user_id, created_at),
  INDEX idx_songs_catalog (child_id, status, catalog_removed_at, approved_at) -- shared = ready + generic + not removed
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE jobs (
  id           CHAR(36) PRIMARY KEY,
  song_id      CHAR(36) NOT NULL,
  step         VARCHAR(20) NOT NULL,           -- next step to run
  attempts     TINYINT NOT NULL DEFAULT 0,
  safety_regens TINYINT NOT NULL DEFAULT 0,      -- lyric rewrites after failed safety checks (max 2, R1)
  regen_part   VARCHAR(10) NULL,               -- NULL = first generation; lyrics | music | image = regenerate job
  run_after    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at    DATETIME NULL,
  done_at      DATETIME NULL,
  last_error   TEXT NULL,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  INDEX idx_jobs_pick (done_at, run_after)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE refresh_tokens (
  id          CHAR(36) PRIMARY KEY,
  user_id     CHAR(36) NOT NULL,
  family_id   CHAR(36) NOT NULL,                -- one login's chain of rotations
  token_hash  CHAR(64) NOT NULL,                -- SHA-256 hex; raw token never stored
  expires_at  DATETIME NOT NULL,
  revoked_at  DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uq_refresh_tokens_hash (token_hash),
  INDEX idx_refresh_tokens_user (user_id),
  INDEX idx_refresh_tokens_family (family_id),
  CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE invites (
  id          CHAR(36) PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,
  token_hash  CHAR(64) NOT NULL,                -- SHA-256 hex; raw token never stored
  created_by  CHAR(36) NOT NULL,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  revoked_at  DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE INDEX uq_invites_token_hash (token_hash),
  INDEX idx_invites_email (email),
  INDEX idx_invites_created_by (created_by),
  INDEX idx_invites_created (created_at),
  CONSTRAINT fk_invites_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE library_items (                    -- generic songs in each account's kid player
  user_id     CHAR(36) NOT NULL,
  song_id     CHAR(36) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, song_id),
  INDEX idx_library_items_song (song_id),
  CONSTRAINT fk_library_items_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_library_items_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE play_events (                      -- counted plays (admin stats); exactly one of song_id / sound_slug (enforced in the model)
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     CHAR(36) NOT NULL,
  song_id     CHAR(36) NULL,
  sound_slug  VARCHAR(40) NULL,
  played_at   DATETIME NOT NULL,                -- UTC
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_play_events_played (played_at),
  INDEX idx_play_events_song_played (song_id, played_at),
  INDEX idx_play_events_sound_played (sound_slug, played_at),
  INDEX idx_play_events_user_played (user_id, played_at),
  CONSTRAINT fk_play_events_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_play_events_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
