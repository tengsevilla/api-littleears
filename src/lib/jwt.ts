import { createHash, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "./env.js";

export const ROLES = ["admin", "parent"] as const;
export type Role = (typeof ROLES)[number];
export type AuthUser = { id: string; email: string; role: Role };
export type RefreshClaims = { userId: string; familyId: string };

export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const REFRESH_TOKEN_TTL_SEC = 7 * 24 * 60 * 60;

const ALG = "HS256" as const;

export function signAccessToken(user: AuthUser): string {
  return jwt.sign({ email: user.email, role: user.role }, env.JWT_SECRET, {
    algorithm: ALG,
    subject: user.id,
    expiresIn: ACCESS_TOKEN_TTL_SEC,
  });
}

/** Returns null for any invalid or expired token. */
export function verifyAccessToken(token: string): AuthUser | null {
  try {
    const p = jwt.verify(token, env.JWT_SECRET, { algorithms: [ALG] });
    if (typeof p === "string" || !p.sub || typeof p.email !== "string") return null;
    // A token without a recognised role gets the least privilege (admin routes re-check the role).
    const role: Role = p.role === "admin" ? "admin" : "parent";
    return { id: p.sub, email: p.email, role };
  } catch {
    return null;
  }
}

/** jti makes every token unique, so its hash is a unique lookup key. */
export function signRefreshToken({ userId, familyId }: RefreshClaims): string {
  return jwt.sign({ fam: familyId }, env.JWT_REFRESH_SECRET, {
    algorithm: ALG,
    subject: userId,
    jwtid: randomUUID(),
    expiresIn: REFRESH_TOKEN_TTL_SEC,
  });
}

export function verifyRefreshToken(token: string): RefreshClaims | null {
  try {
    const p = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: [ALG] });
    if (typeof p === "string" || !p.sub || typeof p.fam !== "string") return null;
    return { userId: p.sub, familyId: p.fam };
  } catch {
    return null;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
