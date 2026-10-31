import type { Request, Response } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { ok } from "../lib/response.js";
import { deleteObjects } from "../lib/storage.js";
import { parseOrThrow } from "../lib/validation.js";
import { authUser } from "../middleware/auth.js";
import * as CatalogModel from "../models/catalog.model.js";
import { MOODS } from "../models/songs.model.js";

// `?mood=` (empty) means "no filter".
const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);

const CatalogQuerySchema = z.object({
  mood: z.preprocess(blankToUndefined, z.enum(MOODS, { error: 'must be "playful", "calm" or "lullaby"' }).optional()),
  ageBand: z.preprocess(blankToUndefined, z.enum(["1-2", "3-5"], { error: 'must be "1-2" or "3-5"' }).optional()),
  page: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(100_000).default(1)),
});

/** Shared songs from all accounts (never topic or creator). */
export async function list(req: Request, res: Response) {
  const filter = parseOrThrow(CatalogQuerySchema, req.query);
  const { songs, total } = await CatalogModel.listShared(authUser(req).id, filter);
  res.json(ok(songs, { page: filter.page, total }));
}

/** Admin: removes a shared song from the catalog for everyone (sharing rules in CLAUDE.md). */
export async function remove(req: Request<{ songId: string }>, res: Response) {
  const outcome = await CatalogModel.removeFromCatalog(req.params.songId, deleteMedia);
  if (outcome === "not_found") throw new AppError(404, "NOT_FOUND", "Song not found in the catalog");
  res.json(ok(null));
}

// S3 failure aborts the hard delete; the model rolls back so the DB is unchanged.
async function deleteMedia(keys: string[]): Promise<void> {
  try {
    await deleteObjects(keys);
  } catch {
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Could not delete this song's media, please try again");
  }
}
