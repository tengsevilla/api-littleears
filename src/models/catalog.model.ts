// Shared catalog of generic songs + each account's library_items (CLAUDE.md "Sharing rules").
// Shared = status 'ready' AND child_id IS NULL AND catalog_removed_at IS NULL (songs.model isSharedRow).
import type { RowDataPacket } from "mysql2";
import { db } from "../lib/db.js";
import type { AgeBand } from "./children.model.js";
import { jsonColumn, mediaKeys, mediaUrl, type Mood, type Song } from "./songs.model.js";

export const CATALOG_PAGE_SIZE = 24;

/** Never carries topic, creator, user_id or anything personal. */
export type CatalogSong = Pick<Song, "id" | "title" | "mood" | "ageBand" | "lyrics" | "audioUrl" | "imageUrl" | "durationMs"> & {
  inMyLibrary: boolean;
  mine: boolean;
};

export type CatalogFilter = { mood?: Mood; ageBand?: AgeBand; page: number };

const SHARED = "s.status = 'ready' AND s.child_id IS NULL AND s.catalog_removed_at IS NULL";

function toCatalogSong(r: RowDataPacket): CatalogSong {
  return {
    id: r.id,
    title: r.title ?? null,
    mood: r.mood,
    ageBand: r.age_band,
    lyrics: jsonColumn<string[]>(r.lyrics),
    audioUrl: mediaUrl(r.id, "audio", r.audio_key, "ready"),
    imageUrl: mediaUrl(r.id, "image", r.image_key, "ready"),
    durationMs: r.duration_ms ?? null,
    inMyLibrary: Boolean(Number(r.in_my_library)),
    mine: Boolean(Number(r.mine)),
  };
}

/**
 * Shared songs from all accounts, newest approval first, CATALOG_PAGE_SIZE per page. Uses
 * idx_songs_catalog (child_id, status, catalog_removed_at, approved_at). `mine` is false once the
 * creator has deleted it (it is no longer in their studio).
 */
export async function listShared(userId: string, f: CatalogFilter): Promise<{ songs: CatalogSong[]; total: number }> {
  const conds = [SHARED];
  const params: unknown[] = [];
  if (f.mood) {
    conds.push("s.mood = ?");
    params.push(f.mood);
  }
  if (f.ageBand) {
    conds.push("s.age_band = ?");
    params.push(f.ageBand);
  }
  const where = conds.join(" AND ");
  const [[count]] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM songs s WHERE ${where}`, params);
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT s.id, s.title, s.mood, s.age_band, s.lyrics, s.audio_key, s.image_key, s.duration_ms, (li.song_id IS NOT NULL) AS in_my_library, (s.user_id = ? AND s.owner_deleted_at IS NULL) AS mine FROM songs s LEFT JOIN library_items li ON li.song_id = s.id AND li.user_id = ? WHERE ${where} ORDER BY s.approved_at DESC, s.id DESC LIMIT ? OFFSET ?`,
    [userId, userId, ...params, CATALOG_PAGE_SIZE, (f.page - 1) * CATALOG_PAGE_SIZE],
  );
  return { songs: rows.map(toCatalogSong), total: Number(count?.total ?? 0) };
}

/** Adds a shared song to the user's library (idempotent). False when the song is not shared. */
export async function addLibraryItem(userId: string, songId: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id FROM songs WHERE id = ? AND status = 'ready' AND child_id IS NULL AND catalog_removed_at IS NULL LIMIT 1",
    [songId],
  );
  if (rows.length === 0) return false;
  await db.query("INSERT IGNORE INTO library_items (user_id, song_id) VALUES (?, ?)", [userId, songId]);
  return true;
}

/** Removes a song from the user's library only (idempotent; the song itself is untouched). */
export async function removeLibraryItem(userId: string, songId: string): Promise<void> {
  await db.query("DELETE FROM library_items WHERE user_id = ? AND song_id = ?", [userId, songId]);
}

/**
 * Admin removes a shared song from the catalog for everyone: every library_items row goes.
 * - creator already deleted it → hard delete: media via `deleteMedia` (S3), then the row; an S3
 *   failure rolls everything back.
 * - otherwise the creator keeps it privately: catalog_removed_at set, and a re-inserted
 *   library_items row keeps it in their own player.
 */
export async function removeFromCatalog(
  songId: string,
  deleteMedia: (keys: string[]) => Promise<void>,
): Promise<"not_found" | "removed" | "deleted"> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT user_id, owner_deleted_at, raw_audio_key, audio_key, image_key, video_key FROM songs WHERE id = ? AND status = 'ready' AND child_id IS NULL AND catalog_removed_at IS NULL FOR UPDATE",
      [songId],
    );
    const s = rows[0];
    if (!s) {
      await conn.rollback();
      return "not_found";
    }
    let outcome: "removed" | "deleted";
    if ((s.owner_deleted_at ?? null) !== null) {
      const keys = mediaKeys(s);
      if (keys.length > 0) await deleteMedia(keys);
      await conn.query("DELETE FROM songs WHERE id = ?", [songId]); // library_items + jobs cascade
      outcome = "deleted";
    } else {
      await conn.query("UPDATE songs SET catalog_removed_at = NOW() WHERE id = ?", [songId]);
      await conn.query("DELETE FROM library_items WHERE song_id = ?", [songId]);
      await conn.query("INSERT INTO library_items (user_id, song_id) VALUES (?, ?)", [s.user_id, songId]);
      outcome = "removed";
    }
    await conn.commit();
    return outcome;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
