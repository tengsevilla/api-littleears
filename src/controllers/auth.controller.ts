import { randomUUID } from "node:crypto";
import type { CookieOptions, Request, Response } from "express";
import { z } from "zod";
import { env } from "../lib/env.js";
import { AppError } from "../lib/errors.js";
import {
  REFRESH_TOKEN_TTL_SEC,
  hashToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  type RefreshClaims,
} from "../lib/jwt.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { ok } from "../lib/response.js";
import { parseOrThrow } from "../lib/validation.js";
import { authUser } from "../middleware/auth.js";
import * as InvitesModel from "../models/invites.model.js";
import * as RefreshTokenModel from "../models/refreshToken.model.js";
import * as UserModel from "../models/user.model.js";

const REFRESH_COOKIE = "refresh_token";
const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/api/auth",
};

const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(256),
});

// A malformed token (missing, not a string, absurd length) answers exactly like an unknown one: 404.
const MAX_INVITE_TOKEN_LENGTH = 200;
const RegisterSchema = z.object({
  token: z.string().catch(""),
  password: z.string().min(10, { error: "must be 10-128 characters" }).max(128, { error: "must be 10-128 characters" }),
});

// One message for unknown, expired, used and revoked invites.
const inviteNotFound = () => new AppError(404, "NOT_FOUND", "This invite link is invalid or has expired");

const unauthorized = () => new AppError(401, "UNAUTHORIZED", "Session expired, please log in again");

function issueRefreshToken(claims: RefreshClaims) {
  const token = signRefreshToken(claims);
  return {
    token,
    record: {
      ...claims,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SEC * 1000),
    },
  };
}

function sendSession(res: Response, user: UserModel.User, refreshToken: string) {
  res.cookie(REFRESH_COOKIE, refreshToken, { ...cookieOptions, maxAge: REFRESH_TOKEN_TTL_SEC * 1000 });
  res.json(ok({ accessToken: signAccessToken(user), user }));
}

function readRefreshCookie(req: Request): string | null {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function login(req: Request, res: Response) {
  const { email, password } = parseOrThrow(LoginSchema, req.body);
  const found = await UserModel.findByEmail(email);
  // Always run one bcrypt compare; same error for unknown email and wrong password.
  const valid = await verifyPassword(password, found?.passwordHash ?? null);
  if (!found || !valid) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");

  await startSession(res, { id: found.id, email: found.email, role: found.role });
}

/** New login family: stores the refresh token's hash, sets the cookie, returns { accessToken, user }. */
async function startSession(res: Response, user: UserModel.User) {
  const { token, record } = issueRefreshToken({ userId: user.id, familyId: randomUUID() });
  await RefreshTokenModel.create(record);
  sendSession(res, user, token);
}

/** Invite link lookup for the sign-up page. */
export async function invite(req: Request<{ token: string }>, res: Response) {
  const { token } = req.params;
  if (token.length > MAX_INVITE_TOKEN_LENGTH) throw inviteNotFound();
  const found = await InvitesModel.findByTokenHash(hashToken(token));
  if (!found || found.status !== "pending") throw inviteNotFound();
  res.json(ok({ email: found.email }));
}

/** Invite-only sign-up: the email comes from the invite; the new account is a parent. */
export async function register(req: Request, res: Response) {
  const { token, password } = parseOrThrow(RegisterSchema, req.body);
  if (token === "" || token.length > MAX_INVITE_TOKEN_LENGTH) throw inviteNotFound();
  const result = await InvitesModel.registerFromInvite(hashToken(token), randomUUID(), await hashPassword(password));
  if (result.kind === "invalid") throw inviteNotFound();
  if (result.kind === "conflict") throw new AppError(409, "CONFLICT", "An account with this email already exists");
  await startSession(res, result.user);
}

export async function refresh(req: Request, res: Response) {
  const presented = readRefreshCookie(req);
  const claims = presented ? verifyRefreshToken(presented) : null;
  if (!presented || !claims) {
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    throw unauthorized();
  }
  const { token, record } = issueRefreshToken(claims);
  const result = await RefreshTokenModel.rotate(hashToken(presented), record);
  const user = result === "rotated" ? await UserModel.findById(claims.userId) : null;
  if (!user) {
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    throw unauthorized();
  }
  sendSession(res, user, token);
}

export async function logout(req: Request, res: Response) {
  const presented = readRefreshCookie(req);
  if (presented) await RefreshTokenModel.revokeByHash(hashToken(presented));
  res.clearCookie(REFRESH_COOKIE, cookieOptions);
  res.json(ok(null));
}

export async function me(req: Request, res: Response) {
  const user = await UserModel.findById(authUser(req).id);
  if (!user) throw new AppError(401, "UNAUTHORIZED", "Missing or invalid access token");
  res.json(ok(user));
}
