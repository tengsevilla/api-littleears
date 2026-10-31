import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { ok } from "../lib/response.js";
import { deleteObjects } from "../lib/storage.js";
import { parseOrThrow } from "../lib/validation.js";
import { authUser } from "../middleware/auth.js";
import * as ChildrenModel from "../models/children.model.js";
import * as SongsModel from "../models/songs.model.js";
import { MAX_LENGTH_SEC } from "../providers/lyricsRules.js";

const CreateSongSchema = z.object({
  childId: z.uuid({ error: "must be a child id" }).optional(),
  topic: z.string().trim().min(2, { error: "must be 2-120 characters" }).max(120, { error: "must be 2-120 characters" }),
  mood: z.enum(SongsModel.MOODS, { error: 'must be "playful", "calm" or "lullaby"' }),
  lengthSec: z.literal([60, 90, 120], { error: "must be 60, 90 or 120" }),
  ageBand: z.enum(["1-2", "3-5"], { error: 'must be "1-2" or "3-5"' }).optional(),
});

const ListQuerySchema = z.object({
  status: z.enum(SongsModel.SONG_STATUSES, { error: "unknown status" }).optional(),
});

const RegenerateSchema = z.object({
  part: z.enum(SongsModel.REGEN_PARTS, { error: 'must be "lyrics", "music" or "image"' }),
});

const notFound = () => new AppError(404, "NOT_FOUND", "Song not found");

async function songOrThrow(id: string, userId: string): Promise<SongsModel.Song> {
  const song = await SongsModel.findForUser(id, userId);
  if (!song) throw notFound();
  return song;
}

export async function create(req: Request, res: Response) {
  const userId = authUser(req).id;
  const input = parseOrThrow(CreateSongSchema, req.body);

  // ageBand comes from the child for a personalized song, else from the body.
  let ageBand = input.ageBand;
  if (input.childId) {
    const child = await ChildrenModel.findForUser(input.childId, userId);
    if (!child) throw new AppError(404, "NOT_FOUND", "Child not found");
    ageBand = child.ageBand;
  }
  if (!ageBand) throw new AppError(400, "VALIDATION", "ageBand: required when childId is not set");
  if (input.lengthSec > MAX_LENGTH_SEC[ageBand]) {
    throw new AppError(400, "VALIDATION", `lengthSec: songs for ages ${ageBand} are at most ${MAX_LENGTH_SEC[ageBand]} seconds`);
  }

  const id = randomUUID();
  await SongsModel.createWithJob({
    id,
    jobId: randomUUID(),
    userId,
    childId: input.childId ?? null,
    topic: input.topic,
    mood: input.mood,
    ageBand,
    lengthSec: input.lengthSec,
  });
  res.status(201).json(ok({ id, status: "queued" as const }));
}

export async function list(req: Request, res: Response) {
  const { status } = parseOrThrow(ListQuerySchema, req.query);
  const songs = await SongsModel.listByUser(authUser(req).id, status);
  res.json(ok(songs, { total: songs.length }));
}

export async function get(req: Request<{ id: string }>, res: Response) {
  res.json(ok(await songOrThrow(req.params.id, authUser(req).id)));
}

// approve / reject: only from pending_review. 404 when missing, 409 CONFLICT otherwise.
async function transition(req: Request<{ id: string }>, res: Response, apply: typeof SongsModel.approveForUser, verb: string) {
  const userId = authUser(req).id;
  if (!(await apply(req.params.id, userId))) {
    const song = await songOrThrow(req.params.id, userId);
    throw new AppError(409, "CONFLICT", `Only a song waiting for review can be ${verb} (status is ${song.status})`);
  }
  res.json(ok(await songOrThrow(req.params.id, userId)));
}

export const approve = (req: Request<{ id: string }>, res: Response) => transition(req, res, SongsModel.approveForUser, "approved");
export const reject = (req: Request<{ id: string }>, res: Response) => transition(req, res, SongsModel.rejectForUser, "rejected");

export async function regenerate(req: Request<{ id: string }>, res: Response) {
  const userId = authUser(req).id;
  const { part } = parseOrThrow(RegenerateSchema, req.body);
  const outcome = await SongsModel.requeueForRegenerate(req.params.id, userId, part, randomUUID());
  if (outcome === "not_found") throw notFound();
  if (outcome === "shared") throw new AppError(409, "CONFLICT", "Shared songs can't be changed — make a new song");
  if (outcome === "conflict") throw new AppError(409, "CONFLICT", "Only a song waiting for review or ready can be regenerated");
  res.json(ok(await songOrThrow(req.params.id, userId)));
}

export async function remove(req: Request<{ id: string }>, res: Response) {
  const deleted = await SongsModel.removeForUser(req.params.id, authUser(req).id, deleteMedia);
  if (!deleted) throw notFound();
  res.json(ok(null));
}

// S3 failure aborts the delete; the model rolls back so the DB is unchanged.
async function deleteMedia(keys: string[]): Promise<void> {
  try {
    await deleteObjects(keys);
  } catch {
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Could not delete this song's media, please try again");
  }
}
