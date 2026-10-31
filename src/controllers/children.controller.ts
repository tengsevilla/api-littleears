import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { ok } from "../lib/response.js";
import { deleteObjects } from "../lib/storage.js";
import { parseOrThrow } from "../lib/validation.js";
import { authUser } from "../middleware/auth.js";
import * as ChildrenModel from "../models/children.model.js";
import { getProviders } from "../providers/index.js";

// First name / nickname only (R4): Unicode letters (+ combining marks), spaces, hyphens.
const displayName = z
  .string()
  .trim()
  .min(1, { error: "must be 1-40 characters" })
  .max(40, { error: "must be 1-40 characters" })
  .regex(/^[\p{L}\p{M} -]+$/u, { error: "may contain only letters, spaces and hyphens" });
const phoneticName = z
  .string()
  .trim()
  .min(1, { error: "must be 1-80 characters" })
  .max(80, { error: "must be 1-80 characters" })
  .nullable();
const ageBand = z.enum(["1-2", "3-5"], { error: 'must be "1-2" or "3-5"' });

const CreateChildSchema = z.object({
  displayName,
  phoneticName: phoneticName.optional(),
  ageBand,
});

const UpdateChildSchema = z
  .object({
    displayName: displayName.optional(),
    phoneticName: phoneticName.optional(),
    ageBand: ageBand.optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    error: "provide at least one of displayName, phoneticName, ageBand",
  });

const notFound = () => new AppError(404, "NOT_FOUND", "Child not found");

export async function list(req: Request, res: Response) {
  const children = await ChildrenModel.listByUser(authUser(req).id);
  res.json(ok(children, { total: children.length }));
}

export async function create(req: Request, res: Response) {
  const userId = authUser(req).id;
  const input = parseOrThrow(CreateChildSchema, req.body);
  const id = randomUUID();
  await ChildrenModel.create(id, userId, { ...input, phoneticName: input.phoneticName ?? null });
  const child = await ChildrenModel.findForUser(id, userId);
  if (!child) throw new AppError(500, "INTERNAL", "Child was not saved");
  res.status(201).json(ok(child));
}

export async function update(req: Request<{ id: string }>, res: Response) {
  const userId = authUser(req).id;
  const patch = parseOrThrow(UpdateChildSchema, req.body);
  await ChildrenModel.updateForUser(req.params.id, userId, patch);
  const child = await ChildrenModel.findForUser(req.params.id, userId);
  if (!child) throw notFound();
  res.json(ok(child));
}

export async function remove(req: Request<{ id: string }>, res: Response) {
  const deleted = await ChildrenModel.removeWithSongsForUser(req.params.id, authUser(req).id, deleteMedia);
  if (!deleted) throw notFound();
  res.json(ok(null));
}

// S3 failure aborts the delete; the model rolls back so the DB is unchanged.
async function deleteMedia(keys: string[]): Promise<void> {
  try {
    await deleteObjects(keys);
  } catch {
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Could not delete this child's media, please try again");
  }
}

/** Speaks phoneticName ?? displayName (R2). Audio is returned inline and never stored or logged. */
export async function namePreview(req: Request<{ id: string }>, res: Response) {
  const child = await ChildrenModel.findForUser(req.params.id, authUser(req).id);
  if (!child) throw notFound();
  const audio = await getProviders().tts.speak({ text: child.phoneticName ?? child.displayName });
  res.set("Cache-Control", "no-store");
  res.json(ok({ audioUrl: `data:audio/mpeg;base64,${audio.toString("base64")}` }));
}
