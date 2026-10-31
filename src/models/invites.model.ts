// Admin-created invite links (invite-only accounts). Only the SHA-256 hash of a token is stored.
import type { RowDataPacket } from "mysql2";
import { db } from "../lib/db.js";
import type { User } from "./user.model.js";

export type InviteStatus = "pending" | "used" | "expired" | "revoked";
export type Invite = { id: string; email: string; status: InviteStatus; createdAt: string; expiresAt: string };
export type NewInvite = { id: string; email: string; tokenHash: string; createdBy: string; expiresAt: Date };

const COLUMNS = "id, email, expires_at, used_at, revoked_at, created_at";

function statusOf(r: RowDataPacket): InviteStatus {
  if (r.used_at) return "used";
  if (r.revoked_at) return "revoked";
  if (new Date(r.expires_at).getTime() <= Date.now()) return "expired";
  return "pending";
}

function toInvite(r: RowDataPacket): Invite {
  return {
    id: r.id,
    email: r.email,
    status: statusOf(r),
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
  };
}

/** Creates an invite and revokes the email's older pending invites, atomically. */
export async function createRevokingOlder(i: NewInvite): Promise<Invite> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      "UPDATE invites SET revoked_at = NOW() WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?",
      [i.email, new Date()],
    );
    await conn.query("INSERT INTO invites (id, email, token_hash, created_by, expires_at) VALUES (?, ?, ?, ?, ?)", [
      i.id,
      i.email,
      i.tokenHash,
      i.createdBy,
      i.expiresAt,
    ]);
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT ${COLUMNS} FROM invites WHERE id = ? LIMIT 1`, [i.id]);
    await conn.commit();
    return toInvite(rows[0] as RowDataPacket);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** All invites, newest first (admin view). */
export async function listAll(): Promise<Invite[]> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT ${COLUMNS} FROM invites ORDER BY created_at DESC, id DESC`);
  return rows.map(toInvite);
}

/** Revokes a pending invite. "not_pending" when it is used, expired or already revoked. */
export async function revoke(id: string): Promise<"ok" | "not_found" | "not_pending"> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT ${COLUMNS} FROM invites WHERE id = ? LIMIT 1`, [id]);
  const r = rows[0];
  if (!r) return "not_found";
  if (statusOf(r) !== "pending") return "not_pending";
  await db.query("UPDATE invites SET revoked_at = NOW() WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL", [id]);
  return "ok";
}

/** The invite for a token hash, or null. Callers check `status === "pending"`. */
export async function findByTokenHash(tokenHash: string): Promise<Invite | null> {
  const [rows] = await db.query<RowDataPacket[]>(`SELECT ${COLUMNS} FROM invites WHERE token_hash = ? LIMIT 1`, [tokenHash]);
  const r = rows[0];
  return r ? toInvite(r) : null;
}

/**
 * Registers a parent from a pending invite in one transaction: locks the invite, creates the user
 * (email from the invite), marks the invite used. "invalid" = unknown/expired/used/revoked.
 */
export async function registerFromInvite(
  tokenHash: string,
  userId: string,
  passwordHash: string,
): Promise<{ kind: "ok"; user: User } | { kind: "invalid" } | { kind: "conflict" }> {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT ${COLUMNS} FROM invites WHERE token_hash = ? LIMIT 1 FOR UPDATE`, [tokenHash]);
    const r = rows[0];
    if (!r || statusOf(r) !== "pending") {
      await conn.rollback();
      return { kind: "invalid" };
    }
    const [existing] = await conn.query<RowDataPacket[]>("SELECT id FROM users WHERE email = ? LIMIT 1", [r.email]);
    if (existing.length > 0) {
      await conn.rollback();
      return { kind: "conflict" };
    }
    await conn.query("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'parent')", [userId, r.email, passwordHash]);
    await conn.query("UPDATE invites SET used_at = NOW() WHERE id = ?", [r.id]);
    await conn.commit();
    return { kind: "ok", user: { id: userId, email: r.email, role: "parent" } };
  } catch (err) {
    await conn.rollback();
    // users.email UNIQUE: a concurrent registration for the same email won the race.
    if ((err as { code?: unknown }).code === "ER_DUP_ENTRY") return { kind: "conflict" };
    throw err;
  } finally {
    conn.release();
  }
}
