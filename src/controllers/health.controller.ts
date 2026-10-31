import type { Request, Response } from "express";
import * as HealthModel from "../models/health.model.js";
import { AppError } from "../lib/errors.js";
import { ok } from "../lib/response.js";

export async function getHealth(_req: Request, res: Response) {
  try {
    await HealthModel.pingDb();
  } catch {
    throw new AppError(503, "SERVICE_UNAVAILABLE", "Database unreachable");
  }
  res.json(ok({ status: "ok", db: "ok" }));
}
