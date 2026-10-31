import type { AuthUser } from "../lib/jwt.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      user?: AuthUser;
    }
  }
}

export {};
