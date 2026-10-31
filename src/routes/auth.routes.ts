import { Router } from "express";
import * as AuthController from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { loginLimiter, refreshLimiter, registerLimiter } from "../middleware/rateLimit.js";

const router = Router();

router.post("/login", loginLimiter, AuthController.login);
router.post("/refresh", refreshLimiter, AuthController.refresh);
router.post("/logout", AuthController.logout);
router.get("/me", requireAuth, AuthController.me);
router.get("/invites/:token", AuthController.invite);
router.post("/register", registerLimiter, AuthController.register);

export default router;
