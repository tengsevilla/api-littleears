-- Phase 2: rotating refresh tokens (hash only — the raw token never touches the DB).
-- family_id groups one login's chain of rotations; reuse of a revoked token revokes the family.
CREATE TABLE refresh_tokens (
  id          CHAR(36) PRIMARY KEY,
  user_id     CHAR(36) NOT NULL,
  family_id   CHAR(36) NOT NULL,
  token_hash  CHAR(64) NOT NULL,                -- SHA-256 hex of the raw token
  expires_at  DATETIME NOT NULL,
  revoked_at  DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX uq_refresh_tokens_hash (token_hash),
  INDEX idx_refresh_tokens_user (user_id),
  INDEX idx_refresh_tokens_family (family_id),
  CONSTRAINT fk_refresh_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- GET /api/children: WHERE user_id = ? ORDER BY created_at
ALTER TABLE children ADD INDEX idx_children_user_created (user_id, created_at);
