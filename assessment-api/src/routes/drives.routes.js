import express from "express";
import { verifyToken, optionalVerifyToken, authorizeRoles } from "../middleware/auth.mjs";
import {
  listDrives,
  getDriveById,
  createDrive,
  updateDrive,
  deleteDrive,
  enrollStudents,
  enrollEligible,
  listCandidates,
  getMyCandidacy,
  recordRoundResult,
  advanceRound,
  rejectCandidate,
  withdrawCandidate
} from "../controllers/drives.controller.js";

const router = express.Router();

/**
 * @openapi
 * /drives:
 *   get:
 *     tags:
 *       - Drives
 *     summary: List placement drives (students see only Active drives)
 *     responses:
 *       200:
 *         description: List of drives
 */
router.get("/", optionalVerifyToken, listDrives);

/**
 * @openapi
 * /drives:
 *   post:
 *     tags:
 *       - Drives
 *     summary: Create a new placement drive
 *     responses:
 *       201:
 *         description: Drive created
 */
router.post("/", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), createDrive);

/**
 * @openapi
 * /drives/{_id}:
 *   get:
 *     tags:
 *       - Drives
 *     summary: Get drive details
 *     parameters:
 *       - in: path
 *         name: _id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Drive details
 */
router.get("/:_id", verifyToken, getDriveById);

router.put("/:_id", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), updateDrive);
router.delete("/:_id", verifyToken, authorizeRoles("admin", "superadmin"), deleteDrive);

router.post("/:_id/candidates", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), enrollStudents);
router.post("/:_id/candidates/auto-enroll", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), enrollEligible);
router.get("/:_id/candidates", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), listCandidates);
router.get("/:_id/my-candidacy", verifyToken, getMyCandidacy);

router.post("/candidates/:candidateId/result", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), recordRoundResult);
router.post("/candidates/:candidateId/advance", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), advanceRound);
router.post("/candidates/:candidateId/reject", verifyToken, authorizeRoles("admin", "faculty", "superadmin"), rejectCandidate);
router.post("/candidates/:candidateId/withdraw", verifyToken, authorizeRoles("student", "admin", "faculty", "superadmin"), withdrawCandidate);

export default router;
