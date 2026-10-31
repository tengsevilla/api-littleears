// Generation jobs + the song fields the worker reads/writes. Used only by src/worker/.
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";
import { db } from "../lib/db.js";
import type { AgeBand } from "./children.model.js";
import { jsonColumn, type LengthSec, type Mood, type RegenPart, type SafetyResult, type SongStatus } from "./songs.model.js";

export const STEPS = ["writing", "checking", "composing", "illustrating", "mixing"] as const;
export type Step = (typeof STEPS)[number];

export type Job = {
  id: string;
  songId: string;
  step: Step;
  attempts: number;
  safetyRegens: number;
  regenPart: RegenPart | null;
};

export type WorkSong = {
  id: string;
  userId: string;
  childId: string | null;
  topic: string;
  mood: Mood;
  ageBand: AgeBand;
  lengthSec: LengthSec;
  title: string | null;
  lyrics: string[] | null;
  musicPrompt: string | null;
  imagePrompt: string | null;
  safety: SafetyResult | null;
  rawAudioKey: string | null;
  audioKey: string | null;
  imageKey: string | null;
};

export type SongPatch = Partial<{
  status: SongStatus;
  title: string;
  lyrics: string[];
  musicPrompt: string;
  imagePrompt: string;
  safety: SafetyResult | null;
  rawAudioKey: string;
  audioKey: string;
  imageKey: string;
  durationMs: number;
  error: string | null;
}>;

// Column names come from this fixed map only, never from input.
const PATCH_COLUMNS: Record<keyof SongPatch, string> = {
  status: "status",
  title: "title",
  lyrics: "lyrics",
  musicPrompt: "music_prompt",
  imagePrompt: "image_prompt",
  safety: "safety_result",
  rawAudioKey: "raw_audio_key",
  audioKey: "audio_key",
  imageKey: "image_key",
  durationMs: "duration_ms",
  error: "error",
};
const JSON_FIELDS = new Set<keyof SongPatch>(["lyrics", "safety"]);

/** Exported so the SKIP LOCKED verification script runs the exact pick query. */
export const PICK_JOB_SQL =
  "SELECT id, song_id, step, attempts, safety_regens, regen_part FROM jobs WHERE done_at IS NULL AND locked_at IS NULL AND run_after <= NOW() ORDER BY run_after LIMIT 1 FOR UPDATE SKIP LOCKED";

const STALE_LOCK_MINUTES = 10;
const RUNNING: readonly SongStatus[] = ["writing", "checking", "composing", "illustrating", "mixing"];

function toJob(r: RowDataPacket): Job {
  return {
    id: r.id,
    songId: r.song_id,
    step: r.step,
    attempts: Number(r.attempts),
    safetyRegens: Number(r.safety_regens),
    regenPart: r.regen_part ?? null,
  };
}

async function inTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Claims the next runnable job: lock it (SKIP LOCKED so concurrent workers never block or double-pick), set locked_at, commit. */
export function claimNextJob(): Promise<Job | null> {
  return inTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(PICK_JOB_SQL);
    const r = rows[0];
    if (!r) return null;
    await conn.query("UPDATE jobs SET locked_at = NOW() WHERE id = ?", [r.id]);
    return toJob(r);
  });
}

/**
 * Unlocks jobs whose worker died (locked > 10 min, not done) so they are picked again, and puts
 * their song back to queued if it was mid-step. Returns how many jobs were reset.
 */
export function resetStaleLocks(): Promise<number> {
  return inTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id, song_id FROM jobs WHERE done_at IS NULL AND locked_at IS NOT NULL AND locked_at < NOW() - INTERVAL ${STALE_LOCK_MINUTES} MINUTE FOR UPDATE`,
    );
    if (rows.length === 0) return 0;
    await conn.query("UPDATE jobs SET locked_at = NULL WHERE id IN (?)", [rows.map((r) => r.id)]);
    await conn.query("UPDATE songs SET status = 'queued' WHERE id IN (?) AND status IN (?)", [rows.map((r) => r.song_id), RUNNING]);
    return rows.length;
  });
}

export async function findWorkSong(id: string): Promise<WorkSong | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, user_id, child_id, topic, mood, age_band, length_sec, title, lyrics, music_prompt, image_prompt, safety_result, raw_audio_key, audio_key, image_key FROM songs WHERE id = ? LIMIT 1",
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    childId: r.child_id ?? null,
    topic: r.topic,
    mood: r.mood,
    ageBand: r.age_band,
    lengthSec: Number(r.length_sec) as LengthSec,
    title: r.title ?? null,
    lyrics: jsonColumn<string[]>(r.lyrics),
    musicPrompt: r.music_prompt ?? null,
    imagePrompt: r.image_prompt ?? null,
    safety: jsonColumn<SafetyResult>(r.safety_result),
    rawAudioKey: r.raw_audio_key ?? null,
    audioKey: r.audio_key ?? null,
    imageKey: r.image_key ?? null,
  };
}

/** Song status = the step now running; refreshes the job's lock as a heartbeat. */
export async function startStep(jobId: string, songId: string, step: Step): Promise<void> {
  await db.query("UPDATE songs SET status = ? WHERE id = ?", [step, songId]);
  await db.query("UPDATE jobs SET locked_at = NOW() WHERE id = ?", [jobId]);
}

async function patchSong(conn: PoolConnection, songId: string, patch: SongPatch): Promise<boolean> {
  const keys = (Object.keys(patch) as (keyof SongPatch)[]).filter((k) => patch[k] !== undefined);
  const sets = keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(", ");
  const values = keys.map((k) => {
    const v = patch[k];
    return JSON_FIELDS.has(k) && v !== null ? JSON.stringify(v) : v;
  });
  const [res] = await conn.query<ResultSetHeader>(`UPDATE songs SET ${sets} WHERE id = ?`, [...values, songId]);
  return res.affectedRows > 0;
}

/**
 * Stores a step's output and moves the job to `nextStep` (attempts reset) in one transaction, so
 * a step is never recorded as done without its output. False when the song no longer exists.
 */
export function completeStep(jobId: string, songId: string, patch: SongPatch, nextStep: Step, safetyRegens: number): Promise<boolean> {
  return inTransaction(async (conn) => {
    if (!(await patchSong(conn, songId, patch))) return false;
    await conn.query("UPDATE jobs SET step = ?, attempts = 0, safety_regens = ? WHERE id = ?", [nextStep, safetyRegens, jobId]);
    return true;
  });
}

/** Terminal for this job: song patch (pending_review | rejected | failed) + job done, in one transaction. */
export function finishJob(jobId: string, songId: string, patch: SongPatch, attempts: number, lastError: string | null): Promise<void> {
  return inTransaction(async (conn) => {
    await patchSong(conn, songId, patch);
    await conn.query("UPDATE jobs SET done_at = NOW(), locked_at = NULL, attempts = ?, last_error = ? WHERE id = ?", [
      attempts,
      lastError,
      jobId,
    ]);
  });
}

/** Transient failure: unlock and retry after `delaySec`. */
export async function scheduleRetry(jobId: string, attempts: number, delaySec: number, lastError: string): Promise<void> {
  await db.query(
    "UPDATE jobs SET attempts = ?, last_error = ?, locked_at = NULL, run_after = NOW() + INTERVAL ? SECOND WHERE id = ?",
    [attempts, lastError, delaySec, jobId],
  );
}
