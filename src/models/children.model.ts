import type { RowDataPacket } from "mysql2";
import { db } from "../lib/db.js";

export type AgeBand = "1-2" | "3-5";
export type Child = {
  id: string;
  displayName: string;
  phoneticName: string | null;
  ageBand: AgeBand;
  createdAt: string;
};
export type NewChild = { displayName: string; phoneticName: string | null; ageBand: AgeBand };
export type ChildPatch = Partial<NewChild>;

const COLUMNS = "id, display_name, phonetic_name, age_band, created_at";

function toChild(r: RowDataPacket): Child {
  return {
    id: r.id,
    displayName: r.display_name,
    phoneticName: r.phonetic_name ?? null,
    ageBand: r.age_band,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function listByUser(userId: string): Promise<Child[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${COLUMNS} FROM children WHERE user_id = ? ORDER BY created_at ASC, id ASC`,
    [userId],
  );
  return rows.map(toChild);
}

export async function findForUser(id: string, userId: string): Promise<Child | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${COLUMNS} FROM children WHERE id = ? AND user_id = ? LIMIT 1`,
    [id, userId],
  );
  const r = rows[0];
  return r ? toChild(r) : null;
}

export async function create(id: string, userId: string, c: NewChild): Promise<void> {
  await db.query(
    "INSERT INTO children (id, user_id, display_name, phonetic_name, age_band) VALUES (?, ?, ?, ?, ?)",
    [id, userId, c.displayName, c.phoneticName, c.ageBand],
  );
}

// Column names come from this fixed map only, never from user input.
const PATCH_COLUMNS = {
  displayName: "display_name",
  phoneticName: "phonetic_name",
  ageBand: "age_band",
} as const;

/** Caller guarantees at least one field is set. Scoped to the owner; no-op for others' rows. */
export async function updateForUser(id: string, userId: string, patch: ChildPatch): Promise<void> {
  const keys = (Object.keys(PATCH_COLUMNS) as (keyof ChildPatch)[]).filter((k) => patch[k] !== undefined);
  const sets = keys.map((k) => `${PATCH_COLUMNS[k]} = ?`).join(", ");
  await db.query(`UPDATE children SET ${sets} WHERE id = ? AND user_id = ?`, [
    ...keys.map((k) => patch[k]),
    id,
    userId,
  ]);
}

/**
 * Deletes a child together with their personalized songs (R4: a personalized song never becomes
 * generic). Locks the rows, hands every non-null media key of those songs to `deleteMedia`
 * (S3) and only then deletes the song rows (jobs cascade) and the child, all in one transaction.
 * If `deleteMedia` throws, the transaction rolls back and the DB is unchanged.
 * Returns false when the child is missing or belongs to another user.
 */
export async function removeWithSongsForUser(
  id: string,
  userId: string,
  deleteMedia: (keys: string[]) => Promise<void>,
): Promise<boolean> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [children] = await conn.query<RowDataPacket[]>(
      "SELECT id FROM children WHERE id = ? AND user_id = ? FOR UPDATE",
      [id, userId],
    );
    if (children.length === 0) {
      await conn.rollback();
      return false;
    }
    const [songs] = await conn.query<RowDataPacket[]>(
      "SELECT id, raw_audio_key, audio_key, image_key, video_key FROM songs WHERE user_id = ? AND child_id = ? FOR UPDATE",
      [userId, id],
    );
    const keys = songs.flatMap((s) =>
      [s.raw_audio_key, s.audio_key, s.image_key, s.video_key].filter((k): k is string => typeof k === "string" && k !== ""),
    );
    if (keys.length > 0) await deleteMedia(keys);
    await conn.query("DELETE FROM songs WHERE user_id = ? AND child_id = ?", [userId, id]);
    await conn.query("DELETE FROM children WHERE id = ? AND user_id = ?", [id, userId]);
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Worker only (no user scope: the song row already ties the child to its owner). */
export async function findNamesById(id: string): Promise<{ displayName: string; phoneticName: string | null } | null> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT display_name, phonetic_name FROM children WHERE id = ? LIMIT 1", [id]);
  const r = rows[0];
  return r ? { displayName: r.display_name, phoneticName: r.phonetic_name ?? null } : null;
}
