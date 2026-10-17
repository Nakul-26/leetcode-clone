import express from "express";
import { verifyToken, authorizeRoles } from "../middleware/auth.mjs";
import {
  scheduleSlot,
  rescheduleSlot,
  cancelSlot,
  completeSlot,
  regenerateExternalLink,
  listSlotsForDrive,
  listSlotsForCandidate,
  getMySlots,
  getSlotById,
  getSlotByToken,
  submitScorecard,
  submitScorecardByToken
} from "../controllers/interviewSlots.controller.js";

const router = express.Router();

// Public: external (no-account) interviewer accessing via a signed single-use link.
// Rate-limited separately in app.js (interviewLinkLimiter) since it's unauthenticated.
router.get("/external/:token", getSlotByToken);
router.post("/external/:token/scorecard", submitScorecardByToken);

router.get("/my", verifyToken, getMySlots);

router.get("/drive/:driveId", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), listSlotsForDrive);
router.get("/candidate/:candidateId", verifyToken, listSlotsForCandidate);
router.post("/candidate/:candidateId", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), scheduleSlot);

router.get("/:_id", verifyToken, getSlotById);
router.put("/:_id", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), rescheduleSlot);
router.post("/:_id/cancel", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), cancelSlot);
router.post("/:_id/complete", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), completeSlot);
router.post("/:_id/regenerate-link", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), regenerateExternalLink);
router.post("/:_id/scorecard", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), submitScorecard);

export default router;
