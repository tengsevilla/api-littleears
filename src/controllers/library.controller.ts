import type { Request, Response } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { ok } from "../lib/response.js";
import { parseOrThrow } from "../lib/validation.js";
import { authUser } from "../middleware/auth.js";
import * as CatalogModel from "../models/catalog.model.js";
import * as ChildrenModel from "../models/children.model.js";
import * as SongsModel from "../models/songs.model.js";

const LibraryQuerySchema = z.object({
  childId: z.uuid({ error: "must be a child id" }).optional(),
});

const AddItemSchema = z.object({
  songId: z.uuid({ error: "must be a song id" }),
});

/**
 * Kid player: ready songs only — the shared songs in my library (library_items), plus that child's
 * own songs when childId is given. Never another account's personalized song.
 */
export async function list(req: Request, res: Response) {
  const userId = authUser(req).id;
  const { childId } = parseOrThrow(LibraryQuerySchema, req.query);
  if (childId && !(await ChildrenModel.findForUser(childId, userId))) {
    throw new AppError(404, "NOT_FOUND", "Child not found");
  }
  const songs = await SongsModel.listLibrary(userId, childId ?? null);
  res.json(ok(songs, { total: songs.length }));
}

/** Adds a shared song to my player. Idempotent; 404 when the song is not shared. */
export async function addItem(req: Request, res: Response) {
  const { songId } = parseOrThrow(AddItemSchema, req.body);
  if (!(await CatalogModel.addLibraryItem(authUser(req).id, songId))) throw new AppError(404, "NOT_FOUND", "Song not found");
  res.json(ok(null));
}

/** Removes a song from my player only (the song itself is untouched). Idempotent. */
export async function removeItem(req: Request<{ songId: string }>, res: Response) {
  await CatalogModel.removeLibraryItem(authUser(req).id, req.params.songId);
  res.json(ok(null));
}
