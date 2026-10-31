-- Phase 4: generation worker + songs list. Additive only.
-- jobs.safety_regens: how many times this job re-wrote lyrics after a failed safety check
--   (R1: max 2, then the song is rejected). Per job, so a parent's "regenerate lyrics" starts at 0.
-- jobs.regen_part: NULL for the first generation; 'lyrics' | 'music' | 'image' for a regenerate
--   job, which forces that part's steps to re-run even though their outputs already exist.
-- idx_songs_user_created: GET /api/songs lists a user's songs newest first.
ALTER TABLE jobs ADD COLUMN safety_regens TINYINT NOT NULL DEFAULT 0 AFTER attempts;
ALTER TABLE jobs ADD COLUMN regen_part VARCHAR(10) NULL AFTER safety_regens;
ALTER TABLE songs ADD INDEX idx_songs_user_created (user_id, created_at);
