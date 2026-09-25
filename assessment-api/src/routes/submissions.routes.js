import express from "express";
import { validate } from "../../middleware/validator.mjs";
import { verifyToken, authorizeRoles } from "../middleware/auth.mjs";
import {
  submitSolution,
  getSubmissionById,
  getMySubmissions,
  getMyAnalytics,
  listUngradedSubjectiveSubmissions,
  gradeSubjectiveSubmission
} from "../controllers/submissions.controller.js";

const router = express.Router();

router.post("/", verifyToken, validate("submission"), submitSolution);
router.get("/my", verifyToken, getMySubmissions);
router.get("/analytics/my", verifyToken, getMyAnalytics);
router.get(
  "/assessment/:assessmentId/ungraded",
  verifyToken,
  authorizeRoles("admin", "faculty", "superadmin"),
  listUngradedSubjectiveSubmissions
);
router.post(
  "/:_id/grade",
  verifyToken,
  authorizeRoles("admin", "faculty", "superadmin"),
  gradeSubjectiveSubmission
);
router.get("/:_id", verifyToken, getSubmissionById);

export default router;
