import type { Request, Response } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { ok } from "../lib/response.js";
import { parseOrThrow } from "../lib/validation.js";
import { authUser } from "../middleware/auth.js";
import * as PlaysModel from "../models/plays.model.js";

const MAX_AGE_MS = 7 * 86_400_000;
// Device clocks drift: a playedAt up to this far ahead of the server is accepted and stored as "now".
const CLOCK_SKEW_MS = 60_000;

const PlaySchema = z
  .object({
    songId: z.uuid({ error: "must be a song id" }).optional(),
    soundSlug: z.string({ error: "must be a sound slug" }).regex(/^[a-z0-9-]{1,40}$/, { error: "must be a sound slug" }).optional(),
    playedAt: z.iso.datetime({ offset: true, error: "must be an ISO date-time" }).optional(),
  })
  .refine((b) => (b.songId === undefined) !== (b.soundSlug === undefined), { error: "send exactly one of songId or soundSlug" })
  .superRefine((b, ctx) => {
    if (b.playedAt === undefined) return;
    const t = Date.parse(b.playedAt);
    const now = Date.now();
    if (t > now + CLOCK_SKEW_MS) ctx.addIssue({ code: "custom", path: ["playedAt"], message: "must not be in the future" });
    else if (t < now - MAX_AGE_MS) ctx.addIssue({ code: "custom", path: ["playedAt"], message: "must be at most 7 days old" });
  });

/** Counts a play (the client sends it after 10 s of playback). Deduped plays still answer 200. */
export async function create(req: Request, res: Response) {
  const userId = authUser(req).id;
  const body = parseOrThrow(PlaySchema, req.body);
  const now = Date.now();
  const playedAt = new Date(body.playedAt === undefined ? now : Math.min(Date.parse(body.playedAt), now));
  let item: PlaysModel.PlayItem;
  if (body.songId !== undefined) {
    if (!(await PlaysModel.isPlayableSong(body.songId, userId))) throw new AppError(404, "NOT_FOUND", "Song not found");
    item = { songId: body.songId };
  } else {
    item = { soundSlug: body.soundSlug as string };
  }
  await PlaysModel.record(userId, item, playedAt);
  res.json(ok(null));
}
