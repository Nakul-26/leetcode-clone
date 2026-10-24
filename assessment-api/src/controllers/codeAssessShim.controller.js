import { runRawCodeAssess } from "../services/codeAssessShim.service.js";
import {
  enqueueAdHoc, enqueueBatch, waitForCompletion, findOwned, findOwnedMany, toApiResponse, MAX_BATCH_SIZE, MAX_SOURCE_BYTES
} from "../services/adhocExecution.service.js";
import { admitApiClient } from "../services/apiClientQuota.service.js";
import { checkTestCases } from "../services/testCaseCheck.service.js";

function b64decode(s) {
  if (!s) return "";
  return Buffer.from(s, "base64").toString("utf8");
}

// Answers a refused admission in this surface's own error shape, with Retry-After where
// waiting can help. An over-large request is a 422 rather than a 429: retrying it never works.
function sendQuotaDenied(res, admission) {
  const status = admission.code === "exceeds_rate_limit" ? 422 : 429;
  if (admission.retryAfter) res.set("Retry-After", String(admission.retryAfter));
  return res.status(status).json({ error: admission.message, code: admission.code });
}

function b64encode(s) {
  return Buffer.from(s == null ? "" : String(s), "utf8").toString("base64");
}

// POST /codeAssess/submissions?base64_encoded=true&wait=true
// GO Judge public API synchronous execution endpoint (same request/response
// shape as the GO Judge public API — see codeAssessShim.service.js). Exists purely so
// exam-platform's judge.js (which only knows how to speak to a GO Judge-style instance,
// see runOnJudge()) can point JUDGE_URL at this service without any code changes
// on that side. Always responds synchronously — there is no queue behind this route,
// it calls straight into judge-service-go's internal /raw-run.
export async function submitRawExecution(req, res) {
  const body = req.body || {};
  const base64 = req.query.base64_encoded !== "false"; // judge.js always sends true

  const sourceCode = base64 ? b64decode(body.source_code) : (body.source_code || "");
  const stdin = base64 ? b64decode(body.stdin) : (body.stdin || "");

  if (body.language_id == null || !sourceCode) {
    return res.status(400).json({ error: "language_id and source_code are required" });
  }

  // A caller with a real ApiClient key goes through the queue; a legacy shared-secret
  // caller keeps the synchronous path until it has been issued a key, so the existing
  // exam portal behaves exactly as before (plan Phase 2).
  if (req.apiClient) {
    if (Buffer.byteLength(sourceCode, "utf8") > MAX_SOURCE_BYTES) {
      return res.status(413).json({ error: `source_code exceeds the ${MAX_SOURCE_BYTES}-byte limit`, code: "source_too_large" });
    }
    const wallLimit = Number(body.wall_time_limit) || Number(body.cpu_time_limit) || undefined;
    const admission = await admitApiClient(req.apiClient, 1);
    if (!admission.allowed) return sendQuotaDenied(res, admission);

    let queued;
    try {
      queued = await enqueueAdHoc({
        apiClient: req.apiClient,
        languageId: Number(body.language_id),
        sourceCode,
        stdin,
        wallTimeLimitSec: wallLimit,
        memoryLimitKb: Number(body.memory_limit) || undefined
      });
    } catch (err) {
      await admission.refund();
      throw err;
    }
    if (queued.unsupported) {
      await admission.refund();
      return res.status(400).json({ error: `Unsupported language_id: ${body.language_id}` });
    }
    if (req.query.wait === "true") {
      const done = await waitForCompletion(queued.token, req.apiClient._id);
      return res.status(200).json(toApiResponse(done, queued.token));
    }
    // GO Judge answers an async create with just the token.
    return res.status(201).json({ token: queued.token });
  }

  const result = await runRawCodeAssess({
    languageId: Number(body.language_id),
    sourceCode,
    stdin,
    cpuTimeLimitSec: Number(body.cpu_time_limit) || undefined,
    wallTimeLimitSec: Number(body.wall_time_limit) || Number(body.cpu_time_limit) || undefined,
    memoryLimitKb: Number(body.memory_limit) || undefined,
  });

  return res.status(200).json({
    token: `sync-${Date.now()}`,
    stdout: b64encode(result.stdout),
    stderr: b64encode(result.stderr),
    compile_output: b64encode(result.compile_output),
    status: result.status,
    time: result.time,
    memory: result.memory,
    exit_code: result.exit_code,
    exit_signal: result.exit_signal,
  });
}

// GET /codeAssess/submissions/:token
// Not needed in practice: /submissions above always resolves synchronously
// (wait=true), so judge.js's defensive poll loop never has anything to poll for.
// Implemented only so a stray poll doesn't 404 into confusing error handling.
export async function getRawExecution(req, res) {
  if (req.apiClient) {
    const doc = await findOwned(req.params.token, req.apiClient._id);
    if (!doc) return res.status(404).json({ error: "Submission not found" });
    return res.status(200).json(toApiResponse(doc, req.params.token));
  }
  return res.status(404).json({ error: "Synchronous-only judge: nothing to poll for token " + req.params.token });
}

// POST /codeAssess/submissions/batch?base64_encoded=true
// Body: { submissions: [{ language_id, source_code, stdin, cpu_time_limit, ... }, ...] }
// Answers 201 with one { token } or { error } per item, in request order.
//
// Items that share a language, source and limits are coalesced into a single execution that
// compiles once, so sending a student's test cases as one batch is much cheaper than one
// request per case. The caller cannot tell the difference: every item still gets its own
// token and its own result. Requires an API key, because a coalesced result can only be read
// back through the queue-backed path; a shared-secret caller has no such path.
export async function submitBatch(req, res) {
  if (!req.apiClient) {
    return res.status(403).json({ error: "Batch submissions require an API key" });
  }

  const submissions = req.body && req.body.submissions;
  if (!Array.isArray(submissions) || submissions.length === 0) {
    return res.status(422).json({ error: "submissions must be a non-empty array" });
  }
  if (submissions.length > MAX_BATCH_SIZE) {
    return res.status(422).json({
      error: `number of submissions in a batch should be less than or equal to ${MAX_BATCH_SIZE}`
    });
  }

  const base64 = req.query.base64_encoded !== "false";
  const prepared = submissions.map((raw) => {
    const item = raw || {};
    const sourceCode = base64 ? b64decode(item.source_code) : (item.source_code || "");
    if (item.language_id == null || !sourceCode) return { invalid: "language_id and source_code are required" };
    if (Buffer.byteLength(sourceCode, "utf8") > MAX_SOURCE_BYTES) {
      return { invalid: `source_code exceeds the ${MAX_SOURCE_BYTES}-byte limit` };
    }
    return {
      languageId: Number(item.language_id),
      sourceCode,
      stdin: base64 ? b64decode(item.stdin) : (item.stdin || ""),
      wallTimeLimitSec: Number(item.wall_time_limit) || Number(item.cpu_time_limit) || undefined,
      memoryLimitKb: Number(item.memory_limit) || undefined
    };
  });

  // Invalid items are answered in place and excluded from execution, so one bad item
  // doesn't reject the rest of the batch.
  const valid = prepared.filter((p) => !p.invalid);

  // The whole batch is admitted or refused together, in test cases. Admitting part of it would
  // leave the caller to work out which items ran.
  const admission = await admitApiClient(req.apiClient, valid.length);
  if (!admission.allowed) return sendQuotaDenied(res, admission);

  let queued = [];
  try {
    queued = valid.length ? await enqueueBatch({ apiClient: req.apiClient, items: valid }) : [];
  } catch (err) {
    await admission.refund();
    throw err;
  }
  // Items that were refused individually (unsupported language, queue error) did no work.
  const rejected = queued.filter((q) => q.error).length;
  if (rejected > 0) await admission.refund(rejected);
  let next = 0;
  const out = prepared.map((p) => (p.invalid ? { error: p.invalid } : queued[next++]));
  return res.status(201).json(out);
}

// GET /codeAssess/submissions/batch?tokens=a,b,c
// Answers { submissions: [...] } in the order the tokens were given; a token that is unknown,
// malformed or belongs to another client is null.
export async function getBatch(req, res) {
  if (!req.apiClient) {
    return res.status(403).json({ error: "Batch submissions require an API key" });
  }
  const tokens = String(req.query.tokens || "").split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return res.status(422).json({ error: "tokens is required" });
  if (tokens.length > MAX_BATCH_SIZE) {
    return res.status(422).json({
      error: `number of tokens should be less than or equal to ${MAX_BATCH_SIZE}`
    });
  }
  const docs = await findOwnedMany(tokens, req.apiClient._id);
  return res.status(200).json({
    submissions: docs.map((doc, i) => (doc ? toApiResponse(doc, tokens[i]) : null))
  });
}

// POST /codeAssess/test-cases/generate?base64_encoded=true
// POST /codeAssess/test-cases/check?base64_encoded=true
// Body: { language_id, source_code, test_cases: [{ stdin, expected_output? }], cpu_time_limit?, memory_limit? }
//
// For a platform that keeps its own questions and reference solutions: runs the reference
// solution on each input and returns its output (generate), and with check also says whether
// each expected_output is correct. Nothing is stored. Metered like a run: one unit per test case.
// See testCaseCheck.service.js and docs/GO_JUDGE_API.md "Check or generate test cases".
export function testCasesHandler(mode) {
  return async function handleTestCases(req, res) {
    const body = req.body || {};
    const base64 = req.query.base64_encoded !== "false";
    const decode = (v) => (v === undefined || v === null ? v : base64 ? b64decode(v) : String(v));
    const encode = (v) => (v === undefined || v === null ? v : base64 ? b64encode(v) : v);

    const sourceCode = decode(body.source_code) || "";
    if (Buffer.byteLength(sourceCode, "utf8") > MAX_SOURCE_BYTES) {
      return res.status(413).json({ error: `source_code exceeds the ${MAX_SOURCE_BYTES}-byte limit`, code: "source_too_large" });
    }
    const cases = Array.isArray(body.test_cases)
      ? body.test_cases.map((c) => ({ stdin: decode(c?.stdin) ?? "", expected_output: decode(c?.expected_output) }))
      : body.test_cases;

    let admission = null;
    if (req.apiClient && Array.isArray(cases) && cases.length > 0) {
      admission = await admitApiClient(req.apiClient, cases.length);
      if (!admission.allowed) return sendQuotaDenied(res, admission);
    }

    let result;
    try {
      result = await checkTestCases({
        languageId: body.language_id,
        sourceCode,
        cases,
        timeLimitSec: Number(body.wall_time_limit) || Number(body.cpu_time_limit) || undefined,
        memoryLimitKb: Number(body.memory_limit) || undefined,
        mode
      });
    } catch (err) {
      await admission?.refund();
      if (err.status && err.body) return res.status(err.status).json(err.body);
      throw err;
    }

    return res.status(200).json({
      ...result,
      compile_output: encode(result.compile_output),
      results: result.results.map((r) => ({
        ...r,
        actual_output: encode(r.actual_output),
        expected_output: encode(r.expected_output),
        stderr: encode(r.stderr)
      }))
    });
  };
}
