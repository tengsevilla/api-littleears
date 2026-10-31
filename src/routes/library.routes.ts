import { Router } from "express";
import * as LibraryController from "../controllers/library.controller.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth);
router.get("/", LibraryController.list);
router.post("/items", LibraryController.addItem);
router.delete("/items/:songId", LibraryController.removeItem);

export default router;
