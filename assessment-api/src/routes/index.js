import express from "express";
import problemsRoutes from "./problems.routes.js";
import assessmentsRoutes from "./assessments.routes.js";
import submissionsRoutes from "./submissions.routes.js";
import previewRoutes from "./preview.routes.js";
import authRoutes from "./auth.routes.js";
import healthRoutes from "./health.routes.js";
import adminRoutes from "./admin.routes.js";
import integrationRoutes from "./integration.routes.js";
import questionsRoutes from "./questions.routes.js";
import arventiqRoutes from "./arventiq.routes.js";
import codeAssessShimRoutes from "./codeAssessShim.routes.js";
import billingRoutes from "./billing.routes.js";
import drivesRoutes from "./drives.routes.js";
import interviewSlotsRoutes from "./interviewSlots.routes.js";

const router = express.Router();

router.use("/problems", problemsRoutes);
router.use("/assessments", assessmentsRoutes);
router.use("/drives", drivesRoutes);
router.use("/interview-slots", interviewSlotsRoutes);
router.use("/submissions", submissionsRoutes);
router.use("/preview", previewRoutes);
router.use("/auth", authRoutes);
router.use("/health", healthRoutes);
router.use("/admin", adminRoutes);
router.use("/integration", integrationRoutes);
router.use("/questions", questionsRoutes);
router.use("/arventiq", arventiqRoutes);
router.use("/codeAssess", codeAssessShimRoutes);
router.use("/billing", billingRoutes);

export default router;
