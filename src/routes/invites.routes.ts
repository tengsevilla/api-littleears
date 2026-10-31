import { Router } from "express";
import * as InvitesController from "../controllers/invites.controller.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireAdmin);
router.post("/", InvitesController.create);
router.get("/", InvitesController.list);
router.delete("/:id", InvitesController.revoke);

export default router;
