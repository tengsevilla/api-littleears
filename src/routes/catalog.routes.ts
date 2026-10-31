import { Router } from "express";
import * as CatalogController from "../controllers/catalog.controller.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);
router.get("/", CatalogController.list);
router.delete("/:songId", requireAdmin, CatalogController.remove);

export default router;
