import { Router } from "express";
import * as PlaysController from "../controllers/plays.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { playLimiter } from "../middleware/rateLimit.js";

const router = Router();

router.use(requireAuth);
router.post("/", playLimiter, PlaysController.create);

export default router;
