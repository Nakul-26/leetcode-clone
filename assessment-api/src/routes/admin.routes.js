import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import Problem from "../../models/Problem.mjs";
import Submission from "../../models/Submission.mjs";
import Assessment from "../../models/Assessment.mjs";
import User from "../../models/User.mjs";
import { getChannel } from "../config/rabbit.js";
import { getRedis } from "../config/redis.js";
import { verifyToken, authorizeRoles } from "../middleware/auth.mjs";
import * as authService from "../services/auth.service.js";
import * as auditService from "../services/audit.service.js";
import * as systemService from "../services/system.service.js";
import * as apiClientsService from "../services/apiClients.service.js";
import * as queueStatsService from "../services/queueStats.service.js";
import * as languageStatsService from "../services/languageStats.service.js";
import { safeErrorMessage } from "../utils/safeErrorMessage.js";

const router = express.Router();

// ---- External API keys (plan Phase 1) -------------------------------------
// admin/superadmin only: faculty have no reason to mint machine credentials.
// Every handler scopes by the caller's own college inside the service; collegeId
// is never read from the request body except for a superadmin naming a tenant.

router.post("/api-clients", verifyToken, authorizeRoles("admin", "superadmin"), async (req, res) => {
  try {
    const { client, key } = await apiClientsService.createApiClient(req.body, req.user);
    // The plaintext key is returned exactly once and is not recoverable afterwards.
    res.status(201).json({
      client,
      key,
      warning: "Store this key now - it is shown once and cannot be retrieved later."
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.get("/api-clients", verifyToken, authorizeRoles("admin", "superadmin"), async (req, res) => {
  try {
    res.json(await apiClientsService.listApiClients(req.user));
  } catch (error) {
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.patch("/api-clients/:clientId", verifyToken, authorizeRoles("admin", "superadmin"), async (req, res) => {
  try {
    res.json(await apiClientsService.updateApiClient(req.params.clientId, req.body, req.user));
  } catch (error) {
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.get("/api-clients/:clientId/usage", verifyToken, authorizeRoles("admin", "superadmin"), async (req, res) => {
  try {
    res.json(await apiClientsService.getApiClientUsageById(req.params.clientId, req.user));
  } catch (error) {
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

// Platform-wide, so superadmin only: queue depth says nothing about one college, and the
// per-client table spans every tenant.
router.get("/queue-stats", verifyToken, authorizeRoles("superadmin"), async (req, res) => {
  try {
    res.json(await queueStatsService.getQueueStats());
  } catch (error) {
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

// Per-language volume and run time across every judge path (queue, /run, /raw-run), to decide
// where judge optimisation pays off. Platform-wide, so superadmin only. ?days=1..365 (default 30).
router.get("/language-stats", verifyToken, authorizeRoles("superadmin"), async (req, res) => {
  try {
    res.json(await languageStatsService.getLanguageStats({ days: req.query.days }));
  } catch (error) {
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.delete("/api-clients/:clientId", verifyToken, authorizeRoles("admin", "superadmin"), async (req, res) => {
  try {
    res.json(await apiClientsService.revokeApiClient(req.params.clientId, req.user));
  } catch (error) {
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.get("/audit-logs", verifyToken, authorizeRoles("admin", "superadmin", "faculty"), async (req, res) => {
  try {
    const logs = await auditService.listLogs(req.query, req.user);
    res.json(logs);
  } catch (error) {
    console.error("Audit logs error:", error);
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.get("/users", verifyToken, authorizeRoles("admin", "superadmin", "faculty"), async (req, res) => {
  try {
    const results = await authService.listUsers(req.query, req.user);
    res.json(results);
  } catch (error) {
    console.error("List users error:", error);
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.post("/users", verifyToken, authorizeRoles("admin", "superadmin", "faculty"), async (req, res) => {
  try {
    const { name, email, password, role, usn, section } = req.body;
    if (!name || !email) return res.status(400).json({ error: "Name and email are required" });

    const auditInfo = {
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    };

    const result = await authService.adminCreateUser({ name, email, password, role, usn, section }, req.user, auditInfo);
    res.status(201).json(result);
  } catch (error) {
    console.error("Create user error:", error);
    if (error.status && error.body) {
      return res.status(error.status).json(error.body);
    }
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.delete("/users/:userId", verifyToken, authorizeRoles("admin", "superadmin", "faculty"), async (req, res) => {
  try {
    const auditInfo = {
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    };

    const result = await authService.deleteUser(req.params.userId, req.user, auditInfo);
    res.json(result);
  } catch (error) {
    console.error("Delete user error:", error);
    if (error.status && error.body) {
      return res.status(error.status).json(error.body);
    }
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.post("/users/:userId/reset-password", verifyToken, authorizeRoles("admin", "superadmin", "faculty"), async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: "New password is required" });

    const auditInfo = {
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    };

    const result = await authService.resetUserPassword(req.params.userId, newPassword, req.user, auditInfo);
    res.json(result);
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.post("/bulk-import-students", verifyToken, authorizeRoles("admin", "superadmin", "faculty"), async (req, res) => {
  try {
    const { users, defaultPassword } = req.body;
    
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ error: "Invalid or empty users list" });
    }

    if (!defaultPassword) {
      return res.status(400).json({ error: "Default password is required" });
    }

    // A non-superadmin is always scoped to their own college — only a superadmin may
    // target an arbitrary collegeId via the body (e.g. onboarding a specific college on
    // a fresh tenant's behalf).
    const collegeId = req.user.role === 'superadmin'
      ? (req.body.collegeId || req.user.collegeId)
      : req.user.collegeId;

    const results = await authService.bulkRegister(users, defaultPassword, collegeId);
    
    res.json(results);
  } catch (error) {
    console.error("Bulk import error:", error);
    if (error.status && error.body) {
      return res.status(error.status).json(error.body);
    }
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.get("/system-stats", verifyToken, authorizeRoles("admin", "superadmin"), async (req, res) => {
  try {
    // Tenant scoping: a college-scoped admin sees only their own college's metrics/feed.
    // Problem stays global since it's an intentionally unscoped shared catalog (no
    // collegeId field at all), same as everywhere else in this codebase. Queue/judge/
    // infra health below stays global too — that's shared platform infrastructure state,
    // not any one college's data.
    const scope = req.user.role === 'superadmin' ? undefined : (req.user.collegeId || undefined);
    const collegeFilter = scope ? { collegeId: scope } : {};

    // 1. Metrics
    const [totalProblems, totalSubmissions, totalAssessments, totalUsers] = await Promise.all([
      Problem.countDocuments(),
      Submission.countDocuments(collegeFilter),
      Assessment.countDocuments(collegeFilter),
      User.countDocuments(collegeFilter)
    ]);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const submissionsToday = await Submission.countDocuments({
      ...collegeFilter,
      createdAt: { $gte: startOfDay }
    });
    const acceptedToday = await Submission.countDocuments({
      ...collegeFilter,
      status: "Success",
      createdAt: { $gte: startOfDay }
    });

    // 2. Queue Monitoring
    let queueLength = 0;
    let dlqLength = 0;
    const channel = getChannel();
    if (channel) {
      try {
        const queueInfo = await channel.checkQueue(process.env.SUBMISSION_QUEUE || "submission_queue");
        queueLength = queueInfo.messageCount;
        
        // Check DLQ as well
        const dlqInfo = await channel.checkQueue("submission_dead_letters");
        dlqLength = dlqInfo.messageCount;
      } catch (err) {
        console.error("Failed to check queues:", err.message);
      }
    }

    // 3. Judge Stats
    let judgeStats = null;
    let judgeHealth = "offline";
    try {
      // Use internal service name
      const response = await fetch(`${env.JUDGE_SERVICE_URL}/stats`);
      if (response.ok) {
        judgeStats = await response.json();
        judgeHealth = "healthy";
      }
    } catch (err) {
      console.log("Judge stats not available:", err.message);
    }

    // 4. System Health
    const health = {
      api: "healthy",
      mongodb: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      redis: "disconnected",
      rabbitmq: (channel && channel.connection) ? "connected" : "disconnected",
      judge: judgeHealth
    };

    const redis = getRedis();
    if (redis && redis.isOpen) {
      try {
        await redis.ping();
        health.redis = "connected";
      } catch {
        health.redis = "error";
      }
    }

    // 5. Recent Submissions Feed
    const recentSubmissions = await Submission.find(collegeFilter)
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("problemId", "title")
      .populate("userId", "name email");

    res.json({
      metrics: {
        totalProblems,
        totalSubmissions,
        totalAssessments,
        totalUsers,
        submissionsToday,
        acceptedToday
      },
      queueLength,
      dlqLength,
      judgeStats,
      health,
      recentSubmissions
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

import * as submissionsService from "../services/submissions.service.js";

router.post("/rejudge/submission/:submissionId", verifyToken, authorizeRoles("admin", "superadmin", "faculty"), async (req, res) => {
  try {
    const result = await submissionsService.rejudgeSubmission(req.params.submissionId, req.user);
    
    const auditInfo = {
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    };
    await auditService.logEvent({
      event: "REJUDGE_SUBMISSION",
      userId: req.user._id,
      collegeId: req.user.collegeId || undefined,
      details: { submissionId: req.params.submissionId, problemId: result.problemId },
      ...auditInfo
    });

    res.json({ msg: "Rejudge scheduled successfully", submission: result });
  } catch (error) {
    console.error("Rejudge submission error:", error);
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.post("/rejudge/problem/:problemId", verifyToken, authorizeRoles("admin", "superadmin", "faculty"), async (req, res) => {
  try {
    const assessmentId = req.query.assessmentId || null;
    const result = await submissionsService.rejudgeProblemSubmissions(req.params.problemId, assessmentId, req.user);
    
    const auditInfo = {
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    };
    await auditService.logEvent({
      event: "REJUDGE_PROBLEM",
      userId: req.user._id,
      collegeId: req.user.collegeId || undefined,
      details: { problemId: req.params.problemId, assessmentId },
      ...auditInfo
    });

    res.json({ msg: `Rejudge scheduled successfully for ${result.count} submissions`, count: result.count });
  } catch (error) {
    console.error("Rejudge problem error:", error);
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.post("/rejudge/assessment/:assessmentId", verifyToken, authorizeRoles("admin", "superadmin", "faculty"), async (req, res) => {
  try {
    const result = await submissionsService.rejudgeAssessmentSubmissions(req.params.assessmentId, req.user);
    
    const auditInfo = {
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    };
    await auditService.logEvent({
      event: "REJUDGE_ASSESSMENT",
      userId: req.user._id,
      collegeId: req.user.collegeId || undefined,
      details: { assessmentId: req.params.assessmentId },
      ...auditInfo
    });

    res.json({ msg: `Rejudge scheduled successfully for ${result.count} submissions`, count: result.count });
  } catch (error) {
    console.error("Rejudge assessment error:", error);
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.post("/banner", verifyToken, authorizeRoles("admin", "superadmin", "faculty"), async (req, res) => {
  try {
    const { active, message, type } = req.body;
    const banner = await systemService.updateIncidentBanner({ active, message, type });
    
    // Log the event
    await auditService.logEvent({
      event: "UPDATE_INCIDENT_BANNER",
      userId: req.user._id,
      collegeId: req.user.collegeId || undefined,
      details: { active, message, type },
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    });

    res.json({ msg: "Incident banner updated successfully", banner });
  } catch (error) {
    console.error("Banner update error:", error);
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

// superadmin-only: this dumps/overwrites every college's data in one shot (no tenant
// scoping, no field exclusion — it's a full-fidelity disaster-recovery tool, not a
// per-college feature). A per-college "admin" role must never reach this.
router.get("/backup", verifyToken, authorizeRoles("superadmin"), async (req, res) => {
  try {
    const data = await systemService.exportDatabase();
    
    // Log the event
    await auditService.logEvent({
      event: "DATABASE_BACKUP",
      userId: req.user._id,
      details: {},
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    });

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename=leetcode_clone_backup_${Date.now()}.json`);
    res.json(data);
  } catch (error) {
    console.error("Database backup error:", error);
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

// superadmin-only — see the /backup comment above; restore is the destructive twin.
router.post("/restore", verifyToken, authorizeRoles("superadmin"), async (req, res) => {
  try {
    const results = await systemService.importDatabase(req.body);
    
    // Log the event
    await auditService.logEvent({
      event: "DATABASE_RESTORE",
      userId: req.user._id,
      details: { restoredCollections: results },
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    });

    res.json({ msg: "Database restored successfully", results });
  } catch (error) {
    console.error("Database restore error:", error);
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

export default router;
