import { createHash } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { db } from "../lib/db.js";
import type { AgeBand } from "./children.model.js";

export const SONG_STATUSES = [
  "queued",
  "writing",
  "checking",
  "composing",
  "illustrating",
  "mixing",
  "pending_review",
  "ready",
  "rejected",
  "failed",
] as const;
export type SongStatus = (typeof SONG_STATUSES)[number];
export const MOODS = ["playful", "calm", "lullaby"] as const;
export type Mood = (typeof MOODS)[number];
export type LengthSec = 60 | 90 | 120;
export const REGEN_PARTS = ["lyrics", "music", "image"] as const;
export type RegenPart = (typeof REGEN_PARTS)[number];
export type SafetyResult = { pass: boolean; reasons: string[] };
export type MediaKind = "audio" | "image";

export type Song = {
  id: string;
  childId: string | null;
  topic: string;
  mood: Mood;
  ageBand: AgeBand;
  lengthSec: LengthSec;
  status: SongStatus;
  title: string | null;
  lyrics: string[] | null;
  safety: SafetyResult | null;
  audioUrl: string | null;
  imageUrl: string | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  approvedAt: string | null;
  shared: boolean; // generic + ready + not removed from the catalog
};
export type SongSummary = Pick<Song, "id" | "childId" | "topic" | "mood" | "status" | "title" | "imageUrl" | "createdAt">;
export type LibrarySong = Pick<Song, "id" | "childId" | "title" | "mood" | "audioUrl" | "imageUrl" | "durationMs">;

export type NewSong = {
  id: string;
  jobId: string;
  userId: string;
  childId: string | null;
  topic: string;
  mood: Mood;
  ageBand: AgeBand;
  lengthSec: LengthSec;
};

/** Media is served to the owner only in these statuses (studio preview + kid player); to others only while shared. */
export const MEDIA_STATUSES: readonly SongStatus[] = ["pending_review", "ready"];

/** MariaDB returns JSON columns as strings, MySQL 8 as parsed values — accept both. */
export function jsonColumn<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/**
 * Stable API URL for a song's media (never an S3 URL). `v` is a short hash of the current S3 key,
 * so a regenerated part gets a new URL and the immutable cache never serves stale media.
 * null unless the media is actually servable (key set and status pending_review | ready).
 */
export function mediaUrl(id: string, kind: MediaKind, key: unknown, status: SongStatus): string | null {
  if (typeof key !== "string" || key === "" || !MEDIA_STATUSES.includes(status)) return null;
  const v = createHash("sha256").update(key).digest("hex").slice(0, 8);
  return `/api/media/${id}/${kind}?v=${v}`;
}

const iso = (v: unknown) => new Date(v as string).toISOString();

/**
 * Sharing rule: a generic song is shared with every signed-in account from the moment its creator
 * approves it, until an admin removes it from the catalog.
 */
export function isSharedRow(r: RowDataPacket): boolean {
  return r.status === "ready" && (r.child_id ?? null) === null && (r.catalog_removed_at ?? null) === null;
}

const COLUMNS =
  "id, child_id, topic, mood, age_band, length_sec, status, title, lyrics, safety_result, audio_key, image_key, duration_ms, error, created_at, approved_at, catalog_removed_at";
const S_COLUMNS = COLUMNS.split(", ")
  .map((c) => `s.${c}`)
  .join(", ");

function toSong(r: RowDataPacket): Song {
  const status = r.status as SongStatus;
  return {
    id: r.id,
    childId: r.child_id ?? null,
    topic: r.topic,
    mood: r.mood,
    ageBand: r.age_band,
    lengthSec: Number(r.length_sec) as LengthSec,
    status,
    title: r.title ?? null,
    lyrics: jsonColumn<string[]>(r.lyrics),
    safety: jsonColumn<SafetyResult>(r.safety_result),
    audioUrl: mediaUrl(r.id, "audio", r.audio_key, status),
    imageUrl: mediaUrl(r.id, "image", r.image_key, status),
    durationMs: r.duration_ms ?? null,
    error: status === "failed" ? (r.error ?? null) : null,
    createdAt: iso(r.created_at),
    approvedAt: r.approved_at ? iso(r.approved_at) : null,
    shared: isSharedRow(r),
  };
}

function toSummary(r: RowDataPacket): SongSummary {
  const { id, childId, topic, mood, status, title, imageUrl, createdAt } = toSong(r);
  return { id, childId, topic, mood, status, title, imageUrl, createdAt };
}

function toLibrarySong(r: RowDataPacket): LibrarySong {
  const { id, childId, title, mood, audioUrl, imageUrl, durationMs } = toSong(r);
  return { id, childId, title, mood, audioUrl, imageUrl, durationMs };
}

/** Song (status queued) + its first job (step writing), atomically. */
export async function createWithJob(s: NewSong): Promise<void> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      "INSERT INTO songs (id, user_id, child_id, topic, mood, age_band, length_sec, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')",
      [s.id, s.userId, s.childId, s.topic, s.mood, s.ageBand, s.lengthSec],
    );
    await conn.query("INSERT INTO jobs (id, song_id, step, regen_part) VALUES (?, ?, ?, ?)", [s.jobId, s.id, "writing", null]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function findForUser(id: string, userId: string): Promise<Song | null> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT ${COLUMNS} FROM songs WHERE id = ? AND user_id = ? AND owner_deleted_at IS NULL LIMIT 1`, [id, userId]);
  const r = rows[0];
  return r ? toSong(r) : null;
}

/** Newest first; songs the creator deleted (still shared) are hidden. Uses idx_songs_user_created / idx_songs_user_status. */
export async function listByUser(userId: string, status?: SongStatus): Promise<SongSummary[]> {
  const [rows] = status
    ? await db.query<RowDataPacket[]>(
        `SELECT ${COLUMNS} FROM songs WHERE user_id = ? AND status = ? AND owner_deleted_at IS NULL ORDER BY created_at DESC, id DESC`,
        [userId, status],
      )
    : await db.query<RowDataPacket[]>(`SELECT ${COLUMNS} FROM songs WHERE user_id = ? AND owner_deleted_at IS NULL ORDER BY created_at DESC, id DESC`, [userId]);
  return rows.map(toSummary);
}

// The generic songs in the user's library_items that are ready and either still shared, or the
// user's own song an admin removed from the catalog (kept privately). Never a personalized song.
const LIBRARY_ITEMS_SQL = `SELECT ${S_COLUMNS} FROM library_items li JOIN songs s ON s.id = li.song_id WHERE li.user_id = ? AND s.status = 'ready' AND s.child_id IS NULL AND (s.catalog_removed_at IS NULL OR s.user_id = ?)`;

/**
 * Kid player (R1 hard gate): status 'ready' only. The user's library_items songs (see above), plus
 * that child's own personalized songs when `childId` is given (caller has checked the child is the user's).
 */
export async function listLibrary(userId: string, childId: string | null): Promise<LibrarySong[]> {
  const [rows] = childId
    ? await db.query<RowDataPacket[]>(
        `SELECT ${S_COLUMNS} FROM songs s WHERE s.user_id = ? AND s.child_id = ? AND s.status = 'ready' UNION ALL ${LIBRARY_ITEMS_SQL} ORDER BY approved_at DESC, id DESC`,
        [userId, childId, userId, userId],
      )
    : await db.query<RowDataPacket[]>(`${LIBRARY_ITEMS_SQL} ORDER BY s.approved_at DESC, s.id DESC`, [userId, userId]);
  return rows.map(toLibrarySong);
}

/**
 * pending_review → ready (the only path to ready). A generic song is shared from this moment and
 * goes into the creator's library_items, atomically. False when not found or not pending_review.
 */
export async function approveForUser(id: string, userId: string): Promise<boolean> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [res] = await conn.query<ResultSetHeader>(
      "UPDATE songs SET status = 'ready', approved_at = NOW() WHERE id = ? AND user_id = ? AND status = 'pending_review'",
      [id, userId],
    );
    if (res.affectedRows > 0) {
      await conn.query("INSERT IGNORE INTO library_items (user_id, song_id) SELECT user_id, id FROM songs WHERE id = ? AND child_id IS NULL", [id]);
    }
    await conn.commit();
    return res.affectedRows > 0;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** pending_review → rejected. False when not found or not pending_review. */
export async function rejectForUser(id: string, userId: string): Promise<boolean> {
  const [res] = await db.query<ResultSetHeader>(
    "UPDATE songs SET status = 'rejected' WHERE id = ? AND user_id = ? AND status = 'pending_review'",
    [id, userId],
  );
  return res.affectedRows > 0;
}

/** First pipeline step a regenerate job starts at. */
const REGEN_FIRST_STEP: Record<RegenPart, string> = { lyrics: "writing", music: "composing", image: "illustrating" };

/**
 * Regenerate (pending_review | ready only; never a shared song — other families play it): song back to queued with approved_at cleared, plus a new
 * job for that part, atomically. Existing media keys stay until the worker stores their replacement.
 */
export async function requeueForRegenerate(
  id: string,
  userId: string,
  part: RegenPart,
  jobId: string,
): Promise<"ok" | "not_found" | "conflict" | "shared"> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT status, child_id, catalog_removed_at FROM songs WHERE id = ? AND user_id = ? AND owner_deleted_at IS NULL FOR UPDATE",
      [id, userId],
    );
    const row = rows[0];
    if (!row || isSharedRow(row) || (row.status !== "pending_review" && row.status !== "ready")) {
      await conn.rollback();
      return !row ? "not_found" : isSharedRow(row) ? "shared" : "conflict";
    }
    await conn.query("UPDATE songs SET status = 'queued', approved_at = NULL, error = NULL WHERE id = ?", [id]);
    await conn.query("INSERT INTO jobs (id, song_id, step, regen_part) VALUES (?, ?, ?, ?)", [jobId, id, REGEN_FIRST_STEP[part], part]);
    await conn.commit();
    return "ok";
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Creator deletes a song. A shared song is soft-deleted: owner_deleted_at is set and it leaves the
 * creator's library_items, but it stays in the catalog and in other families' libraries (files kept).
 * Any other song is hard-deleted: locks the row, hands its media keys to `deleteMedia` (S3), then
 * deletes the row (jobs + library_items cascade). If `deleteMedia` throws, the transaction rolls back.
 * False when not found (or already deleted by its creator).
 */
export async function removeForUser(id: string, userId: string, deleteMedia: (keys: string[]) => Promise<void>): Promise<boolean> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<RowDataPacket[]>(
      "SELECT status, child_id, catalog_removed_at, raw_audio_key, audio_key, image_key, video_key FROM songs WHERE id = ? AND user_id = ? AND owner_deleted_at IS NULL FOR UPDATE",
      [id, userId],
    );
    const s = rows[0];
    if (!s) {
      await conn.rollback();
      return false;
    }
    if (isSharedRow(s)) {
      await conn.query("UPDATE songs SET owner_deleted_at = NOW() WHERE id = ?", [id]);
      await conn.query("DELETE FROM library_items WHERE user_id = ? AND song_id = ?", [userId, id]);
    } else {
      const keys = mediaKeys(s);
      if (keys.length > 0) await deleteMedia(keys);
      await conn.query("DELETE FROM songs WHERE id = ? AND user_id = ?", [id, userId]);
    }
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Every stored S3 key of a song row (raw_audio_key, audio_key, image_key, video_key). */
export function mediaKeys(s: RowDataPacket): string[] {
  return [s.raw_audio_key, s.audio_key, s.image_key, s.video_key].filter((k): k is string => typeof k === "string" && k !== "");
}

/**
 * S3 key of servable media: for the owner in pending_review | ready (unless they deleted it), and for
 * any signed-in user while the song is shared. Audio only ever from audio_key (normalized) —
 * raw_audio_key is never served (R3).
 */
export async function findMediaKey(id: string, userId: string, kind: MediaKind): Promise<string | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT user_id, child_id, status, audio_key, image_key, owner_deleted_at, catalog_removed_at FROM songs WHERE id = ? LIMIT 1",
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  const owner = r.user_id === userId && (r.owner_deleted_at ?? null) === null && MEDIA_STATUSES.includes(r.status as SongStatus);
  if (!owner && !isSharedRow(r)) return null;
  const key: unknown = kind === "audio" ? r.audio_key : r.image_key;
  return typeof key === "string" && key !== "" ? key : null;
}
