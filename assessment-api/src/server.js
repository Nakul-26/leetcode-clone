import http from "http";
import app from "./app.js";
import connectDB from "./config/db.js";
import { initRedis } from "./config/redis.js";
import { initRabbit } from "./config/rabbit.js";
import { env } from "./config/env.js";
import { attachSignaling } from "./realtime/signaling.js";
import { startStuckSubmissionReaper } from "./services/stuckSubmissions.service.js";
import { startSubmissionEvents } from "./services/submissionEvents.service.js";

async function startServer() {
  try {
    await connectDB();
    await initRedis();
    await initRabbit();

    // Re-queues or fails submissions whose judge message was lost (JUDGE_FIX_PLAN R8).
    startStuckSubmissionReaper();

    // Wakes wait=true callers when the judge finishes a submission (JUDGE_FIX_PLAN T6).
    await startSubmissionEvents();

    // Plain http.Server wrapping app so Socket.IO (interview room signaling) can attach
    // its own WebSocket upgrade handling to the same port, alongside the existing REST API.
    const httpServer = http.createServer(app);
    attachSignaling(httpServer);

    httpServer.listen(env.PORT, () => {
      console.log(`🚀 Server running on port ${env.PORT}`);
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err);
    process.exit(1);
  }
}

process.on("unhandledRejection", (err) => {
  console.log(`Error: ${err && err.message ? err.message : err}`);
  process.exit(1);
});

startServer();
