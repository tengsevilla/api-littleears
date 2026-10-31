-- Invite-only accounts + shared catalog for generic songs (CLAUDE.md "Sharing rules").
-- Additive only: new columns, tables, indexes, and a backfill of library_items.

-- Roles: the seed account is the admin; everyone who registers from an invite is a parent.
ALTER TABLE users ADD COLUMN role ENUM('admin','parent') NOT NULL DEFAULT 'parent' AFTER password_hash;

-- A shared song = status 'ready' AND child_id IS NULL AND catalog_removed_at IS NULL.
-- owner_deleted_at: the creator deleted a shared song (soft delete — it stays in the catalog).
-- catalog_removed_at: an admin removed it from the catalog.
-- idx_songs_catalog serves GET /api/catalog: WHERE child_id IS NULL AND status = 'ready'
-- AND catalog_removed_at IS NULL ORDER BY approved_at DESC.
ALTER TABLE songs
  ADD COLUMN owner_deleted_at   DATETIME NULL AFTER approved_at,
  ADD COLUMN catalog_removed_at DATETIME NULL AFTER owner_deleted_at,
  ADD INDEX idx_songs_catalog (child_id, status, catalog_removed_at, approved_at);

-- Admin-created invite links. Only the SHA-256 hash of the raw token is stored.
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
  INDEX idx_invites_email (email),               -- re-invite revokes the email's older pending invite
  INDEX idx_invites_created_by (created_by),
  INDEX idx_invites_created (created_at),        -- GET /api/invites newest first
  CONSTRAINT fk_invites_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- The generic songs in each account's kid player (own approved songs + songs added from the catalog).
CREATE TABLE library_items (
  user_id     CHAR(36) NOT NULL,
  song_id     CHAR(36) NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, song_id),
  INDEX idx_library_items_song (song_id),
  CONSTRAINT fk_library_items_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_library_items_song FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Backfill: every existing ready generic song stays in its owner's player.
INSERT IGNORE INTO library_items (user_id, song_id, created_at)
SELECT user_id, id, COALESCE(approved_at, CURRENT_TIMESTAMP)
FROM songs
WHERE status = 'ready' AND child_id IS NULL;
