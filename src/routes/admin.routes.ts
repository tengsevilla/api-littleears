import { Router } from "express";
import * as AdminController from "../controllers/admin.controller.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireAdmin);
router.get("/stats", AdminController.stats);

export default router;
