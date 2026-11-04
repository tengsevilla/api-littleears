import { Router } from "express";
import healthRoutes from "./health.routes.js";
import authRoutes from "./auth.routes.js";
import childrenRoutes from "./children.routes.js";
import songsRoutes from "./songs.routes.js";
import libraryRoutes from "./library.routes.js";
import mediaRoutes from "./media.routes.js";
import catalogRoutes from "./catalog.routes.js";
import invitesRoutes from "./invites.routes.js";
import playsRoutes from "./plays.routes.js";
import adminRoutes from "./admin.routes.js";

const router = Router();

router.use("/health", healthRoutes);
router.use("/auth", authRoutes);
router.use("/children", childrenRoutes);
router.use("/songs", songsRoutes);
router.use("/library", libraryRoutes);
router.use("/media", mediaRoutes);
router.use("/catalog", catalogRoutes);
router.use("/invites", invitesRoutes);
router.use("/plays", playsRoutes);
router.use("/admin", adminRoutes);

export default router;
