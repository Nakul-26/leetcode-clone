import express from "express";
import mongoose from "mongoose";
import { getRedis } from "../config/redis.js";
import { getChannel } from "../config/rabbit.js";
import { getIncidentBanner } from "../services/system.service.js";
import { safeErrorMessage } from "../utils/safeErrorMessage.js";
import { env } from "../config/env.js";

const router = express.Router();

router.get("/banner", async (req, res) => {
  try {
    const banner = await getIncidentBanner();
    res.json(banner);
  } catch (error) {
    console.error("Get banner error:", error);
    res.status(error.status || 500).json({ error: safeErrorMessage(error) });
  }
});

router.get("/", async (req, res) => {
  const health = {
    status: "healthy",
    version: "1.0.0",
    env: process.env.NODE_ENV || "development",
    timestamp: new Date(),
    services: {
      mongodb: "unknown",
      redis: "unknown",
      rabbitmq: "unknown",
      judge: "unknown"
    }
  };

  try {
    // Check MongoDB
    if (mongoose.connection.readyState === 1) {
      health.services.mongodb = "connected";
    } else {
      health.services.mongodb = "disconnected";
      health.status = "unhealthy";
    }

    // Check Redis
    const redis = getRedis();
    if (redis && redis.isOpen) {
      try {
        await redis.ping();
        health.services.redis = "connected";
      } catch {
        health.services.redis = "error";
        health.status = "unhealthy";
      }
    } else {
      health.services.redis = "disconnected";
      health.status = "unhealthy";
    }

    // Check RabbitMQ
    const channel = getChannel();
    if (channel && channel.connection) {
       health.services.rabbitmq = "connected";
    } else {
      health.services.rabbitmq = "disconnected";
      health.status = "unhealthy";
    }

    // Check Judge Service
    try {
      const judgeRes = await fetch(`${env.JUDGE_SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) });
      if (judgeRes.ok) {
        health.services.judge = "connected";
      } else {
        health.services.judge = "error";
        health.status = "unhealthy";
      }
    } catch {
      health.services.judge = "disconnected";
      health.status = "unhealthy";
    }

    const statusCode = health.status === "healthy" ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    console.error("Health check error:", error);
    res.status(error.status || 500).json({ status: "error", message: safeErrorMessage(error) });
  }
});

router.get("/ready", (req, res) => {
  // A simple readiness check that doesn't deep-ping all dependencies, 
  // useful for load balancers.
  res.status(200).json({ status: "ready" });
});

export default router;
