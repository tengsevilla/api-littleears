import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { AppError } from "../lib/errors.js";
import { getObjectStream, storageErrorStatus, type ObjectStream } from "../lib/storage.js";
import { authUser } from "../middleware/auth.js";
import * as SongsModel from "../models/songs.model.js";

const FALLBACK_TYPE: Record<SongsModel.MediaKind, string> = { audio: "audio/mpeg", image: "image/png" };
// Single byte range only ("bytes=0-1023", "bytes=500-", "bytes=-500"); anything else gets the full body.
const SINGLE_RANGE = /^bytes=(\d+-\d*|-\d+)$/;

/**
 * Streams the owner's media from private S3 (R4). `v` is ignored for lookup: it only busts the
 * client cache when a part is regenerated, so the URL can be cached as immutable.
 */
async function stream(req: Request<{ songId: string }>, res: Response, kind: SongsModel.MediaKind) {
  const key = await SongsModel.findMediaKey(req.params.songId, authUser(req).id, kind);
  if (!key) throw new AppError(404, "NOT_FOUND", "Media not found");

  const range = req.headers.range?.trim();
  let obj: ObjectStream;
  try {
    obj = await getObjectStream(key, range && SINGLE_RANGE.test(range) ? range : undefined);
  } catch (err) {
    const status = storageErrorStatus(err);
    if (status === 416) throw new AppError(416, "BAD_REQUEST", "Requested range not satisfiable");
    if (status === 404) throw new AppError(404, "NOT_FOUND", "Media not found");
    throw err;
  }

  res.status(obj.contentRange ? 206 : 200);
  res.set({
    "Content-Type": obj.contentType ?? FALLBACK_TYPE[kind],
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
  });
  if (obj.contentLength !== undefined) res.set("Content-Length", String(obj.contentLength));
  if (obj.contentRange) res.set("Content-Range", obj.contentRange);

  try {
    await pipeline(obj.body, res);
  } catch (err) {
    // A client that stops listening mid-stream (seek, pause, navigate away) is normal.
    if (!res.headersSent) throw err;
    res.destroy();
  }
}

export const audio = (req: Request<{ songId: string }>, res: Response) => stream(req, res, "audio");
export const image = (req: Request<{ songId: string }>, res: Response) => stream(req, res, "image");
