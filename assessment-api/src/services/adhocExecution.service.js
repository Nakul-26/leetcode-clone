import mongoose from "mongoose";
import Submission from "../../models/Submission.mjs";
import { publishSubmissionMessage, INTERACTIVE_QUEUE_NAME } from "./evaluation.service.js";
import { mapLanguageId } from "./codeAssessShim.service.js";

// Queue-backed execution for the GO Judge public API surface (plan Phases 2-3). A keyed
// caller's request becomes an ordinary stdin submission with no expected output, so it gets
// the queue, retries, dead-lettering, pooling, persistence and metering that every other
// submission already has.
//
// A single request is a submission with one test case. A batch is coalesced: items that
// share a language, source and limits become ONE submission with one test case each, so the
// source compiles once and runs N times instead of compiling N times.

// How long a wait=true call blocks before returning the token with a Processing status,
// which is the standard behaviour for a run that outlasts the caller's patience.
const DEFAULT_WAIT_MS = 25_000;
const POLL_MS = 100;
// Ad-hoc rows are transient; the judge's usageevents record is the durable one.
const ADHOC_TTL_MS = 24 * 60 * 60 * 1000;

export const MAX_BATCH_SIZE = 20;
// The judge gives one submission a fixed 120s budget that includes compiling, so a group
// has to be capped by its worst case: this many seconds of per-case limit summed across the
// group. Ten cases that each time out at 10s would otherwise run into the budget and fail the
// cases at the back of the group through no fault of their own.
const MAX_GROUP_WORST_CASE_SEC = 60;
const DEFAULT_CASE_LIMIT_SEC = 10;

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

// Per-test outcome as the judge records it (TestResult.errorType).
const ERROR_TYPE_TO_API = {
  timeout: API_STATUS.TLE,
  memory_limit: API_STATUS.RUNTIME_ERROR,
  runtime: API_STATUS.RUNTIME_ERROR
};

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
// A token is the submission id. When items were coalesced into one submission, each item's
// token is `<id>.<index>` so it can be resolved to its own test case. A group of one keeps
// the plain id, which makes a single request and a one-item batch indistinguishable.
export function parseToken(token) {
  const [id, idx] = String(token).split(".");
  const index = idx === undefined ? null : Number(idx);
  if (idx !== undefined && !(Number.isInteger(index) && index >= 0)) return { id: null, index: null };
  return { id, index };
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------
async function enqueueGroup({ apiClient, language, sourceCode, stdins, wallTimeLimitSec, memoryLimitKb }) {
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
    // expected is null on purpose: callers compare results themselves, so the judge runs
    // and reports instead of judging.
    tests: stdins.map((stdin) => ({ inputs: [stdin || ""], expected: null, isHidden: true })),
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
  return submission._id.toString();
}

export async function enqueueAdHoc({ apiClient, languageId, sourceCode, stdin, wallTimeLimitSec, memoryLimitKb }) {
  const language = mapLanguageId(languageId);
  if (!language) return { unsupported: true };
  const id = await enqueueGroup({ apiClient, language, sourceCode, stdins: [stdin], wallTimeLimitSec, memoryLimitKb });
  return { token: id };
}

/**
 * Enqueues a batch, coalescing items with the same language, source and limits into one
 * submission. Returns one entry per input item, in input order: `{ token }` or `{ error }`.
 * Order matters: callers match results to inputs by position.
 */
export async function enqueueBatch({ apiClient, items }) {
  const results = new Array(items.length);
  const groups = new Map();

  items.forEach((item, position) => {
    const language = mapLanguageId(item.languageId);
    if (!language) {
      results[position] = { error: `Unsupported language_id: ${item.languageId}` };
      return;
    }
    const key = [language, item.wallTimeLimitSec || "", item.memoryLimitKb || "", item.sourceCode].join("\u0000");
    if (!groups.has(key)) groups.set(key, { language, item, members: [] });
    groups.get(key).members.push({ position, stdin: item.stdin });
  });

  const chunks = [];
  for (const group of groups.values()) {
    const limitSec = group.item.wallTimeLimitSec || DEFAULT_CASE_LIMIT_SEC;
    const perChunk = Math.max(1, Math.floor(MAX_GROUP_WORST_CASE_SEC / limitSec));
    for (let i = 0; i < group.members.length; i += perChunk) {
      chunks.push({ ...group, members: group.members.slice(i, i + perChunk) });
    }
  }

  let firstFailure = null;
  let succeeded = 0;
  for (const chunk of chunks) {
    try {
      const id = await enqueueGroup({
        apiClient,
        language: chunk.language,
        sourceCode: chunk.item.sourceCode,
        stdins: chunk.members.map((m) => m.stdin),
        wallTimeLimitSec: chunk.item.wallTimeLimitSec,
        memoryLimitKb: chunk.item.memoryLimitKb
      });
      succeeded++;
      chunk.members.forEach((m, i) => {
        results[m.position] = { token: chunk.members.length === 1 ? id : `${id}.${i}` };
      });
    } catch (err) {
      firstFailure = firstFailure || err;
      chunk.members.forEach((m) => {
        results[m.position] = { error: "Queue unavailable, please retry" };
      });
    }
  }

  // If nothing at all was accepted the caller should see the real failure (a 503 with a
  // retry hint), not a 201 full of errors.
  if (chunks.length > 0 && succeeded === 0 && firstFailure) throw firstFailure;
  return results;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------
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
  const { id } = parseToken(token);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return null;
  return Submission.findOne({ _id: id, kind: "adhoc", apiClientId }).lean();
}

// Resolves many tokens with one query. Result is in input order; an unknown, foreign or
// malformed token is null.
export async function findOwnedMany(tokens, apiClientId) {
  const parsed = tokens.map(parseToken);
  const ids = [...new Set(parsed.map((p) => p.id).filter((id) => id && mongoose.Types.ObjectId.isValid(id)))];
  const docs = ids.length ? await Submission.find({ _id: { $in: ids }, kind: "adhoc", apiClientId }).lean() : [];
  const byId = new Map(docs.map((d) => [String(d._id), d]));
  return parsed.map((p) => (p.id && byId.has(p.id) ? byId.get(p.id) : null));
}

const b64 = (s) => Buffer.from(s == null ? "" : String(s), "utf8").toString("base64");

/**
 * Shapes a stored submission as the public API's response. `token` is the token the caller
 * holds: for a coalesced item it carries the `.index` that selects its own test case.
 */
export function toApiResponse(doc, token = String(doc._id)) {
  const { index } = parseToken(token);
  const base = { token: String(token), stdout: null, stderr: null, compile_output: null, time: null, memory: null, exit_code: null, exit_signal: null };

  if (doc.status === "Pending") return { ...base, status: API_STATUS.IN_QUEUE };
  if (doc.status === "Running") return { ...base, status: API_STATUS.PROCESSING };

  const result = doc.testResult;
  if (!result) {
    // Terminal but no judge result: retries exhausted or the judge failed.
    return { ...base, stderr: b64(doc.output || "Judge failed to produce a result"), status: API_STATUS.INTERNAL_ERROR };
  }

  const details = result.details || [];
  const t = details[index ?? 0] || {};
  const compileFailed = result.status === "Compilation Error";

  let status;
  if (compileFailed) {
    status = API_STATUS.COMPILE_ERROR;
  } else if (index === null) {
    // A plain single submission: the overall verdict is the verdict.
    status = JUDGE_STATUS_TO_API[result.status] || API_STATUS.INTERNAL_ERROR;
  } else if (!details[index]) {
    status = API_STATUS.INTERNAL_ERROR;
  } else {
    // A coalesced item: the overall verdict covers every case, so use this case's own.
    status = t.passed ? API_STATUS.ACCEPTED : (ERROR_TYPE_TO_API[t.errorType] || API_STATUS.INTERNAL_ERROR);
  }

  return {
    ...base,
    stdout: b64(t.stdout ?? t.output ?? ""),
    stderr: b64(compileFailed ? "" : t.stderr || t.traceback || ""),
    compile_output: b64(compileFailed ? result.stderr || "" : ""),
    status,
    time: (Number(t.timeMs ?? result.elapsedMs) || 0) / 1000,
    memory: status.id === API_STATUS.RUNTIME_ERROR.id && (t.errorType === "memory_limit" || result.status === "Memory Limit Exceeded") ? 262144 : 0,
    // -1 where the program never ran to an exit, matching what the synchronous path reports.
    exit_code: compileFailed ? -1 : (t.exitCode ?? 0)
  };
}
