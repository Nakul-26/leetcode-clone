import express from "express";
import { register, login, signup, logout, me } from "../controllers/auth.controller.js";
import { verifyToken, authorizeRoles } from "../middleware/auth.mjs";

const router = express.Router();

// Public registration is disabled for college deployment
// Only superadmins can use the direct register endpoint if needed
router.post("/register", verifyToken, authorizeRoles("superadmin"), register);

// Self-serve signup (Phase 2): public, unlike /register above. Creates a brand-new
// College tenant plus its first admin user — role/collegeId are always derived
// server-side in college.service.js, never accepted from the request body. Mounted on
// this router so it inherits authLimiter (app.js) for brute-force/abuse protection.
router.post("/signup", signup);
/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags:
 *       - Auth
 *     summary: User login
 *     description: Authenticates a user and returns a JWT token.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *       401:
 *         description: Invalid credentials
 */
router.post("/login", login);

// Who the auth cookie belongs to right now (profile page, header role badge).
router.get("/me", verifyToken, me);

// H8: clears the httpOnly auth cookie server-side (the frontend can't clear it itself).
router.post("/logout", logout);

export default router;
