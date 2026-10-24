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

// A student's graded submit: scoring is all-or-nothing, so the judge stops at the first
// failed test (JUDGE_FIX_PLAN T1). "Run" uses /problems/:id/run and still runs every sample.
const stopOnFirstFailure = (req, _res, next) => {
  req.stopOnFirstFailure = true;
  next();
};

router.post("/", verifyToken, validate("submission"), stopOnFirstFailure, submitSolution);
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
