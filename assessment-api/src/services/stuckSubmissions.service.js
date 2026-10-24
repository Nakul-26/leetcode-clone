import Submission from "../../models/Submission.mjs";
import * as problemsRepo from "../repositories/problems.repo.js";
import { publishSubmissionMessage } from "./evaluation.service.js";
import { buildJudgeMessageBody } from "./submissions.service.js";
import { getQueueDepths } from "./queueStats.service.js";
import { env } from "../config/env.js";

// Recovers submissions that will never be judged (JUDGE_FIX_PLAN R8): the message was lost
// (broker failure, a crash between the insert and the publish, a rejudge loop that stopped
// part way), so the row would show Pending forever.
//
// A row is stuck when it is still Pending STUCK_SUBMISSION_AFTER_MINUTES after its last
// change (updatedAt, so a rejudge restarts the clock). It is re-queued once; if it is still
// Pending the next time it is found, it is marked Error so the student can resubmit.
//
// A busy queue is the one case where a long-Pending row is normal, and re-queueing it then
// would only add duplicates when the judge is busiest. So nothing is re-queued while the bulk
// queues hold more than MAX_BACKLOG messages, or while their depth cannot be read. The judge
// ignores a duplicate that arrives after the row is judged (R6), so a rare one is harmless.
//
// Every change is a conditional update on {status: "Pending", updatedAt}, so several API
// instances can run this at once and each row is handled by exactly one of them.

const MAX_BACKLOG = 100;
const BATCH_SIZE = 50;
// Only rows this recent are re-queued. An older one (say, Pending since before this reaper
// existed) belongs to an assessment that has probably ended, and judging it now would change
// a score after the fact, so it is only marked Error.
const MAX_REQUEUE_AGE_MS = 24 * 60 * 60_000;

const STUCK_MESSAGE = "The judge did not finish this submission. Please submit it again.";

async function bulkBacklog() {
  const depths = await getQueueDepths();
  if (depths.bulk == null || depths.bulkRetry == null) return null;
  return depths.bulk + depths.bulkRetry;
}

function claim(row, update) {
  return Submission.updateOne({ _id: row._id, status: "Pending", updatedAt: row.updatedAt }, update);
}

function markStuck(row, output = STUCK_MESSAGE) {
  return claim(row, { $set: { status: "Error", output } });
}

async function requeue(row) {
  const problem = row.problemId ? await problemsRepo.findById(row.problemId) : null;
  if (!problem) {
    await markStuck(row, "The problem for this submission no longer exists.");
    return "failed";
  }
  const claimed = await claim(row, { $inc: { stuckRequeues: 1 } });
  if (claimed.modifiedCount !== 1) return "skipped";

  const message = buildJudgeMessageBody({
    submissionId: row._id.toString(),
    problem,
    language: row.language,
    code: row.code
  });
  if (row.collegeId) message.collegeId = String(row.collegeId);
  if (row.apiClientId) message.apiClientId = String(row.apiClientId);
  try {
    await publishSubmissionMessage(message);
  } catch (err) {
    // Undo the count so a later pass tries again instead of treating this as the one re-queue.
    await Submission.updateOne({ _id: row._id, status: "Pending" }, { $inc: { stuckRequeues: -1 } });
    throw err;
  }
  return "requeued";
}

/**
 * One pass. Returns counts, or { skipped } when the queues are busy or unreadable.
 * `now` is injectable for tests.
 */
export async function reapStuckSubmissions({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - env.STUCK_SUBMISSION_AFTER_MINUTES * 60_000);
  const rows = await Submission.find({ status: "Pending", updatedAt: { $lt: cutoff } })
    .select("_id kind problemId language code collegeId apiClientId stuckRequeues updatedAt")
    .sort({ updatedAt: 1 })
    .limit(BATCH_SIZE)
    .lean();
  const counts = { requeued: 0, failed: 0 };
  if (rows.length === 0) return counts;

  const backlog = await bulkBacklog();
  for (const row of rows) {
    // Ad-hoc rows do not store their stdin or limits, so they cannot be rebuilt; their callers
    // poll by token, and Error tells them to send it again. The same goes for anything already
    // re-queued once, and for anything older than MAX_REQUEUE_AGE_MS.
    const tooOld = now.getTime() - new Date(row.updatedAt).getTime() > MAX_REQUEUE_AGE_MS;
    if (row.kind === "adhoc" || (row.stuckRequeues || 0) >= 1 || tooOld) {
      const res = await markStuck(row);
      if (res.modifiedCount === 1) counts.failed++;
      continue;
    }
    if (backlog == null || backlog > MAX_BACKLOG) {
      counts.skipped = backlog == null ? "queue depth unknown" : `backlog of ${backlog}`;
      continue;
    }
    const outcome = await requeue(row);
    if (outcome === "requeued") counts.requeued++;
    if (outcome === "failed") counts.failed++;
  }
  if (counts.requeued || counts.failed) {
    console.warn(`Stuck submissions: re-queued ${counts.requeued}, marked Error ${counts.failed}`);
  }
  return counts;
}

let timer = null;
let running = false;

export function startStuckSubmissionReaper() {
  if (!env.STUCK_SUBMISSION_REAPER_ENABLED || timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await reapStuckSubmissions();
    } catch (err) {
      console.error("Stuck-submission reaper failed:", err.message);
    } finally {
      running = false;
    }
  }, env.STUCK_SUBMISSION_CHECK_SECONDS * 1000);
  timer.unref();
}

export function stopStuckSubmissionReaper() {
  clearInterval(timer);
  timer = null;
}
