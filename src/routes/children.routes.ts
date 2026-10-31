import { Router } from "express";
import * as ChildrenController from "../controllers/children.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { namePreviewLimiter } from "../middleware/rateLimit.js";

const router = Router();

router.use(requireAuth);
router.get("/", ChildrenController.list);
router.post("/", ChildrenController.create);
router.patch("/:id", ChildrenController.update);
router.delete("/:id", ChildrenController.remove);
router.post("/:id/name-preview", namePreviewLimiter, ChildrenController.namePreview);

export default router;
