import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { db } from "../lib/db.js";
import type { Role } from "../lib/jwt.js";

export type User = { id: string; email: string; role: Role };
export type UserWithHash = User & { passwordHash: string };

export async function findByEmail(email: string): Promise<UserWithHash | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT id, email, role, password_hash FROM users WHERE email = ? LIMIT 1",
    [email],
  );
  const r = rows[0];
  return r ? { id: r.id, email: r.email, role: r.role, passwordHash: r.password_hash } : null;
}

export async function findById(id: string): Promise<User | null> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id, email, role FROM users WHERE id = ? LIMIT 1", [id]);
  const r = rows[0];
  return r ? { id: r.id, email: r.email, role: r.role } : null;
}

export async function emailExists(email: string): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
  return rows.length > 0;
}

/**
 * Seed: inserts the admin account, or makes an existing account with this email an admin.
 * Never touches an existing password. (affectedRows can't tell these apart: mysql2 sets
 * CLIENT_FOUND_ROWS, so the existing row is read first.)
 */
export async function upsertAdmin(id: string, email: string, passwordHash: string): Promise<"created" | "promoted" | "unchanged"> {
  const [rows] = await db.query<RowDataPacket[]>("SELECT role FROM users WHERE email = ? LIMIT 1", [email]);
  const existing = rows[0];
  if (existing?.role === "admin") return "unchanged";
  if (existing) {
    await db.query("UPDATE users SET role = 'admin' WHERE email = ?", [email]);
    return "promoted";
  }
  await db.query<ResultSetHeader>("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'admin')", [id, email, passwordHash]);
  return "created";
}
