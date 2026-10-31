import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { db } from "../lib/db.js";

export type NewRefreshToken = { userId: string; familyId: string; tokenHash: string; expiresAt: Date };

export type RotateResult =
  | "rotated"
  | "invalid" // unknown, expired, or claims don't match the stored row
  | "reused"; // presented token was already revoked: its whole family is now revoked

const INSERT_SQL =
  "INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)";

function insertParams(t: NewRefreshToken) {
  return [randomUUID(), t.userId, t.familyId, t.tokenHash, t.expiresAt];
}

export async function create(t: NewRefreshToken): Promise<void> {
  await db.query(INSERT_SQL, insertParams(t));
}

/**
 * Atomically revokes the presented token and stores its successor in the same family.
 * The row lock serialises concurrent refreshes of one token; the loser sees it revoked (reuse).
 */
export async function rotate(presentedHash: string, next: NewRefreshToken): Promise<RotateResult> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<RowDataPacket[]>(
      `SELECT id, user_id, family_id, revoked_at, expires_at
         FROM refresh_tokens WHERE token_hash = ? FOR UPDATE`,
      [presentedHash],
    );
    const row = rows[0];
    let result: RotateResult;
    if (!row || row.user_id !== next.userId || row.family_id !== next.familyId) {
      result = "invalid";
    } else if (row.revoked_at !== null) {
      await conn.query(
        "UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = ? AND revoked_at IS NULL",
        [row.family_id],
      );
      result = "reused";
    } else if (new Date(row.expires_at).getTime() <= Date.now()) {
      result = "invalid";
    } else {
      await conn.query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?", [row.id]);
      await conn.query(INSERT_SQL, insertParams(next));
      result = "rotated";
    }
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function revokeByHash(tokenHash: string): Promise<void> {
  await db.query("UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL", [
    tokenHash,
  ]);
}
