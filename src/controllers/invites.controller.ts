import { randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { renderInviteEmail } from "../lib/emails/invite.js";
import { env } from "../lib/env.js";
import { AppError } from "../lib/errors.js";
import { hashToken } from "../lib/jwt.js";
import { ok } from "../lib/response.js";
import { parseOrThrow } from "../lib/validation.js";
import { authUser } from "../middleware/auth.js";
import * as InvitesModel from "../models/invites.model.js";
import * as UserModel from "../models/user.model.js";
import { ProviderError } from "../providers/errors.js";
import { getEmailProvider } from "../providers/index.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CreateInviteSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email({ error: "must be an email address" })),
});

/**
 * Emails the invite link. Never throws: a failed send leaves the invite in place and the admin copies
 * inviteUrl instead. Logs only the invite id, the provider message id and the outcome — never the
 * token, the URL, the recipient or inviter address, or the body.
 */
async function emailInvite(invite: InvitesModel.Invite, inviteUrl: string, inviterId: string): Promise<"sent" | "failed"> {
  try {
    // The inviting admin (invites.created_by): named in the email and used as Reply-To.
    const inviter = await UserModel.findById(inviterId);
    if (!inviter) throw new Error("inviting admin not found");
    const message = renderInviteEmail({ email: invite.email, inviterEmail: inviter.email, inviteUrl, expiresAt: new Date(invite.expiresAt) });
    const { id } = await getEmailProvider().send({ to: invite.email, replyTo: inviter.email, ...message });
    console.info(`[invites] invite ${invite.id} email sent (message ${id})`);
    return "sent";
  } catch (err) {
    console.warn(`[invites] invite ${invite.id} email failed (${err instanceof ProviderError ? err.code : "error"})`);
    return "failed";
  }
}

/** Admin: creates an invite link, then emails it. The raw token is returned here only; the DB keeps its hash. */
export async function create(req: Request, res: Response) {
  const { email } = parseOrThrow(CreateInviteSchema, req.body);
  if (await UserModel.emailExists(email)) throw new AppError(409, "CONFLICT", "An account with this email already exists");

  const adminId = authUser(req).id;
  const token = randomBytes(32).toString("base64url");
  const invite = await InvitesModel.createRevokingOlder({
    id: randomUUID(),
    email,
    tokenHash: hashToken(token),
    createdBy: adminId,
    expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  });
  const inviteUrl = `${env.APP_URL}/signup?token=${token}`;
  const emailStatus = await emailInvite(invite, inviteUrl, adminId);
  res.status(201).json(ok({ ...invite, inviteUrl, emailStatus }));
}

export async function list(_req: Request, res: Response) {
  const invites = await InvitesModel.listAll();
  res.json(ok(invites, { total: invites.length }));
}

export async function revoke(req: Request<{ id: string }>, res: Response) {
  const outcome = await InvitesModel.revoke(req.params.id);
  if (outcome === "not_found") throw new AppError(404, "NOT_FOUND", "Invite not found");
  if (outcome === "not_pending") throw new AppError(409, "CONFLICT", "Only a pending invite can be revoked");
  res.json(ok(null));
}
