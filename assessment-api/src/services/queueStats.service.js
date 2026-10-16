import ApiClient from "../../models/ApiClient.mjs";
import UsageEvent from "../../models/UsageEvent.mjs";
import { getConnection } from "../config/rabbit.js";
import { env } from "../config/env.js";

// Overload made visible before it becomes a timeout (plan Phase 4). Superadmin only: queue
// depth is a property of the whole platform, and the per-client table spans every tenant.

const QUEUES = [
  { key: "bulk", name: "submission_queue" },
  { key: "interactive", name: "submission_queue_fast" },
  { key: "bulkRetry", name: "submission_queue_retry" },
  { key: "interactiveRetry", name: "submission_queue_fast_retry" },
  // Anything here was rejected by the judge for good: it is the "something is wrong" signal.
  { key: "deadLetters", name: "submission_dead_letters" }
];

// Matches MAX_QUEUE_DEPTH in evaluation.service.js, above which publishing is refused.
const MAX_QUEUE_DEPTH = 5000;

/**
 * Depth of each queue, read with a throwaway channel per queue. checkQueue on a queue that
 * does not exist (the judge has not started yet) closes the channel it was called on, and
 * doing that to the shared publishing channel would stop every submission. A null depth means
 * the queue could not be read, which is not the same as empty.
 */
export async function getQueueDepths() {
  const connection = getConnection();
  const depths = {};
  for (const { key, name } of QUEUES) {
    depths[key] = null;
    if (!connection || typeof connection.createChannel !== "function") continue;
    let ch;
    try {
      ch = await connection.createChannel();
      ch.on("error", () => {});
      const q = await ch.checkQueue(name);
      depths[key] = q.messageCount;
    } catch {
      depths[key] = null;
    } finally {
      try { await ch?.close(); } catch { /* already closed by the failed check */ }
    }
  }
  return depths;
}

/** Test cases and executions per API client since the start of the UTC month. */
export async function getClientUsageTable(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await UsageEvent.aggregate([
    { $match: { apiClientId: { $exists: true, $ne: null }, createdAt: { $gte: start } } },
    {
      $group: {
        _id: "$apiClientId",
        executions: { $sum: 1 },
        // Events written before testCount existed represent one execution each.
        testCases: { $sum: { $ifNull: ["$testCount", 1] } }
      }
    },
    { $sort: { testCases: -1 } },
    { $limit: 100 }
  ]);

  const clients = await ApiClient.find({ _id: { $in: rows.map((r) => r._id) } }).lean();
  const byId = new Map(clients.map((c) => [String(c._id), c]));

  return rows.map((r) => {
    const c = byId.get(String(r._id));
    const limit = (c && c.monthlyQuota) || env.API_CLIENT_DEFAULT_MONTHLY_QUOTA || 0;
    return {
      apiClientId: r._id,
      name: c ? c.name : null,
      keyPrefix: c ? c.keyPrefix : null,
      active: c ? c.active : null,
      executions: r.executions,
      testCases: r.testCases,
      monthlyQuota: limit || null,
      percentOfQuota: limit ? Math.round((r.testCases / limit) * 1000) / 10 : null
    };
  });
}

export async function getQueueStats() {
  const [queues, clients] = await Promise.all([getQueueDepths(), getClientUsageTable()]);
  const pending = (queues.bulk || 0) + (queues.interactive || 0);
  return {
    queues,
    // Fraction of the point at which publishing starts failing with 503.
    saturation: Math.round((Math.max(queues.bulk || 0, queues.interactive || 0) / MAX_QUEUE_DEPTH) * 1000) / 1000,
    pending,
    deadLetters: queues.deadLetters,
    clients
  };
}
