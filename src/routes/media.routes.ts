import { Router } from "express";
import * as MediaController from "../controllers/media.controller.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);
router.get("/:songId/audio", MediaController.audio);
router.get("/:songId/image", MediaController.image);

export default router;
