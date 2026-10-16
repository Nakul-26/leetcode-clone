import mongoose from "mongoose";
import Submission from "../../models/Submission.mjs";
import { publishSubmissionMessage, INTERACTIVE_QUEUE_NAME } from "./evaluation.service.js";
import { mapLanguageId } from "./codeAssessShim.service.js";

// Queue-backed execution for the GO Judge public API surface (plan Phase 2). A keyed
// caller's request becomes an ordinary stdin submission with one test case and no
// expected output, so it gets the queue, retries, dead-lettering, pooling,
// persistence and metering that every other submission already has.

// How long a GO Judge wait=true call blocks before returning the token with a
// Processing status, which is GO Judge's own documented behaviour for a slow run.
const DEFAULT_WAIT_MS = 25_000;
const POLL_MS = 100;
// Ad-hoc rows are transient; the judge's usageevents record is the durable one.
const ADHOC_TTL_MS = 24 * 60 * 60 * 1000;

// Status ids of the GO Judge public API.
export const API_STATUS = {
  IN_QUEUE: { id: 1, description: "In Queue" },
  PROCESSING: { id: 2, description: "Processing" },
  ACCEPTED: { id: 3, description: "Accepted" },
  TLE: { id: 5, description: "Time Limit Exceeded" },
  COMPILE_ERROR: { id: 6, description: "Compilation Error" },
  RUNTIME_ERROR: { id: 11, description: "Runtime Error (NZEC)" },
  INTERNAL_ERROR: { id: 13, description: "Internal Error" }
};

const JUDGE_STATUS_TO_API = {
  Accepted: API_STATUS.ACCEPTED,
  "Time Limit Exceeded": API_STATUS.TLE,
  "Compilation Error": API_STATUS.COMPILE_ERROR,
  "Runtime Error": API_STATUS.RUNTIME_ERROR,
  // The legacy shim reports an OOM kill as a runtime error and lets the caller
  // reclassify on memory >= limit; keep that so callers see the same thing.
  "Memory Limit Exceeded": API_STATUS.RUNTIME_ERROR
};

export async function enqueueAdHoc({ apiClient, languageId, sourceCode, stdin, wallTimeLimitSec, memoryLimitKb }) {
  const language = mapLanguageId(languageId);
  if (!language) return { unsupported: true };

  const submission = await Submission.create({
    kind: "adhoc",
    code: sourceCode,
    language,
    userId: apiClient.serviceUserId,
    collegeId: apiClient.collegeId,
    apiClientId: apiClient._id,
    status: "Pending",
    expiresAt: new Date(Date.now() + ADHOC_TTL_MS)
  });

  const message = {
    schemaVersion: "v2",
    submissionId: submission._id.toString(),
    kind: "adhoc",
    problemType: "stdin",
    language,
    code: sourceCode,
    // expected is null on purpose: GO Judge callers compare results themselves, so
    // the judge runs and reports instead of judging.
    tests: [{ inputs: [stdin || ""], expected: null, isHidden: true }],
    collegeId: String(apiClient.collegeId),
    apiClientId: String(apiClient._id)
  };
  if (wallTimeLimitSec) message.timeLimitMs = Math.round(wallTimeLimitSec * 1000);
  if (memoryLimitKb) message.memoryLimitMb = Math.max(1, Math.round(memoryLimitKb / 1024));

  try {
    await publishSubmissionMessage(message, { queue: INTERACTIVE_QUEUE_NAME });
  } catch (err) {
    // Nothing will ever process this row, so don't leave it Pending.
    await Submission.updateOne({ _id: submission._id }, { $set: { status: "Error", output: "Queue unavailable" } });
    throw err;
  }
  return { token: submission._id.toString() };
}

export async function waitForCompletion(token, apiClientId, waitMs = DEFAULT_WAIT_MS) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const doc = await findOwned(token, apiClientId);
    if (!doc || !["Pending", "Running"].includes(doc.status) || Date.now() >= deadline) return doc;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// Scoped to the owning client: another client's token is indistinguishable from a
// missing one, so a token can't be used to read someone else's submission.
export async function findOwned(token, apiClientId) {
  if (!mongoose.Types.ObjectId.isValid(String(token))) return null;
  return Submission.findOne({ _id: token, kind: "adhoc", apiClientId }).lean();
}

export function toApiResponse(doc) {
  const b64 = (s) => Buffer.from(s == null ? "" : String(s), "utf8").toString("base64");
  const base = { token: String(doc._id), stdout: null, stderr: null, compile_output: null, time: null, memory: null, exit_code: null, exit_signal: null };

  if (doc.status === "Pending") return { ...base, status: API_STATUS.IN_QUEUE };
  if (doc.status === "Running") return { ...base, status: API_STATUS.PROCESSING };

  const result = doc.testResult;
  if (!result) {
    // Terminal but no judge result: retries exhausted or the judge failed.
    return { ...base, stderr: b64(doc.output || "Judge failed to produce a result"), status: API_STATUS.INTERNAL_ERROR };
  }

  const status = JUDGE_STATUS_TO_API[result.status] || API_STATUS.INTERNAL_ERROR;
  const t = (result.details || [])[0] || {};
  const compileFailed = status.id === API_STATUS.COMPILE_ERROR.id;
  return {
    ...base,
    stdout: b64(t.stdout ?? t.output ?? ""),
    stderr: b64(compileFailed ? "" : t.stderr || t.traceback || ""),
    compile_output: b64(compileFailed ? result.stderr || "" : ""),
    status,
    time: (Number(t.timeMs ?? result.elapsedMs) || 0) / 1000,
    memory: status.id === API_STATUS.RUNTIME_ERROR.id && result.status === "Memory Limit Exceeded" ? 262144 : 0,
    // -1 where the program never ran to an exit, matching what the synchronous path reports.
    exit_code: compileFailed ? -1 : (t.exitCode ?? 0)
  };
}
