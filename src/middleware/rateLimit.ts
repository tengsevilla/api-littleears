import { rateLimit, ipKeyGenerator, type Options } from "express-rate-limit";
import { fail } from "../lib/response.js";

function limiter(limit: number, extra: Partial<Options> = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json(fail("RATE_LIMITED", "Too many requests, try again later"));
    },
    ...extra,
  });
}

// Per IP (trust proxy is set in app.ts), per 15 minutes.
// Login counts only failed attempts, so a parent who logs in fine is never locked out.
export const loginLimiter = limiter(10, { skipSuccessfulRequests: true });
export const refreshLimiter = limiter(60);
// Register: like login — 10 failed attempts (bad token, weak password, 409) per IP per 15 minutes.
export const registerLimiter = limiter(10, { skipSuccessfulRequests: true });

// Per authenticated user (mount after requireAuth): each call costs a paid TTS request.
export const namePreviewLimiter = limiter(20, {
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip ?? "")),
});

// Per authenticated user (mount after requireAuth), per hour: each song costs paid LLM + music + image calls.
// One instance mounted on both POST /songs and POST /songs/:id/regenerate, so they share one budget.
// skipFailedRequests: a 4xx/5xx (validation, 404, 409, provider error) is refunded, so only queued work counts.
export const songGenerationLimiter = limiter(10, {
  windowMs: 60 * 60 * 1000,
  skipFailedRequests: true,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip ?? "")),
});

// Per authenticated user (mount after requireAuth), per hour: play events for admin stats.
export const playLimiter = limiter(300, {
  windowMs: 60 * 60 * 1000,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip ?? "")),
});
