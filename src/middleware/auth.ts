import type { Request, RequestHandler } from "express";
import { AppError } from "../lib/errors.js";
import { verifyAccessToken, type AuthUser } from "../lib/jwt.js";

export const requireAuth: RequestHandler = (req, _res, next) => {
  const [scheme, token] = req.headers.authorization?.split(" ") ?? [];
  const user = scheme === "Bearer" && token ? verifyAccessToken(token) : null;
  if (!user) throw new AppError(401, "UNAUTHORIZED", "Missing or invalid access token");
  req.user = user;
  next();
};

/** Mount after requireAuth: admin-only routes. The role comes from the access JWT. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (req.user?.role !== "admin") throw new AppError(403, "FORBIDDEN", "Admins only");
  next();
};

/** For handlers mounted behind requireAuth. */
export function authUser(req: Request): AuthUser {
  if (!req.user) throw new AppError(401, "UNAUTHORIZED", "Missing or invalid access token");
  return req.user;
}
