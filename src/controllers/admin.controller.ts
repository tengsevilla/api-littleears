import type { Request, Response } from "express";
import { z } from "zod";
import { ok } from "../lib/response.js";
import { parseOrThrow } from "../lib/validation.js";
import { authUser } from "../middleware/auth.js";
import * as PlaysModel from "../models/plays.model.js";

const RANGE_DAYS = { "7d": 7, "30d": 30, "90d": 90, all: null } as const;

const StatsQuerySchema = z.object({
  range: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(["7d", "30d", "90d", "all"], { error: 'must be "7d", "30d", "90d" or "all"' }).default("30d"),
  ),
});

/** Admin stats. A range of N days = today (UTC) and the N-1 UTC days before it. */
export async function stats(req: Request, res: Response) {
  const { range } = parseOrThrow(StatsQuerySchema, req.query);
  const now = new Date();
  const days = RANGE_DAYS[range];
  const since = days === null ? null : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  res.json(ok(await PlaysModel.stats(authUser(req).id, since, now)));
}
