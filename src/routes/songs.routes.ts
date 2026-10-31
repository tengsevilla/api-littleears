import { Router } from "express";
import * as SongsController from "../controllers/songs.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { songGenerationLimiter } from "../middleware/rateLimit.js";

const router = Router();

router.use(requireAuth);
router.get("/", SongsController.list);
router.post("/", songGenerationLimiter, SongsController.create);
router.get("/:id", SongsController.get);
router.post("/:id/approve", SongsController.approve);
router.post("/:id/reject", SongsController.reject);
router.post("/:id/regenerate", songGenerationLimiter, SongsController.regenerate);
router.delete("/:id", SongsController.remove);

export default router;
