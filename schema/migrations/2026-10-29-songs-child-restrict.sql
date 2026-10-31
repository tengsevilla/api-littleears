-- Phase 3: deleting a child must delete that child's personalized songs + S3 objects (R4);
-- a personalized song must never silently become generic. The app deletes the songs first
-- (after their S3 objects), so the FK changes from ON DELETE SET NULL to ON DELETE RESTRICT
-- as a backstop. The DROPs are required: MySQL/MariaDB cannot alter an FK's ON DELETE rule
-- in place. `songs_ibfk_2` and index `child_id` are the auto-generated names from
-- 2026-10-29-initial-schema.sql; the index is recreated under an explicit name first so the
-- new FK always uses it (engines otherwise differ in how they name the FK's index).
ALTER TABLE songs DROP FOREIGN KEY songs_ibfk_2;
ALTER TABLE songs DROP INDEX child_id;
ALTER TABLE songs ADD INDEX idx_songs_child (child_id);
ALTER TABLE songs ADD CONSTRAINT fk_songs_child FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE RESTRICT;
