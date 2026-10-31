-- LittleEars schema — source of truth (PROJECT.md §6). Keep in sync with schema/migrations/.
-- Target: MariaDB 11.4 locally / MySQL 8 on Railway. JSON = LONGTEXT alias on MariaDB.

CREATE TABLE users (
  id            CHAR(36) PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE children (
  id            CHAR(36) PRIMARY KEY,
  user_id       CHAR(36) NOT NULL,
  display_name  VARCHAR(40) NOT NULL,          -- first name / nickname only
  phonetic_name VARCHAR(80) NULL,              -- used in lyrics sent to music provider
  age_band      ENUM('1-2','3-5') NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id)  REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE SET NULL,
  INDEX idx_songs_user_status (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE jobs (
  id           CHAR(36) PRIMARY KEY,
  song_id      CHAR(36) NOT NULL,
  step         VARCHAR(20) NOT NULL,           -- next step to run
  attempts     TINYINT NOT NULL DEFAULT 0,
  run_after    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_at    DATETIME NULL,
  done_at      DATETIME NULL,
  last_error   TEXT NULL,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  INDEX idx_jobs_pick (done_at, run_after)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
