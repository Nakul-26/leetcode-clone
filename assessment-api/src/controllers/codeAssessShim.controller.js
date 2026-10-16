import { runRawCodeAssess } from "../services/codeAssessShim.service.js";
import { enqueueAdHoc, waitForCompletion, findOwned, toJudge0Response } from "../services/adhocExecution.service.js";

function b64decode(s) {
  if (!s) return "";
  return Buffer.from(s, "base64").toString("utf8");
}

function b64encode(s) {
  return Buffer.from(s == null ? "" : String(s), "utf8").toString("base64");
}

// POST /codeAssess/submissions?base64_encoded=true&wait=true
// Judge0 CE wire-format-compatible synchronous execution endpoint (same request/response
// shape as the real Judge0 CE API — see codeAssessShim.service.js). Exists purely so
// exam-platform's judge.js (which only knows how to speak to a Judge0-shaped instance,
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
    const wallLimit = Number(body.wall_time_limit) || Number(body.cpu_time_limit) || undefined;
    const queued = await enqueueAdHoc({
      apiClient: req.apiClient,
      languageId: Number(body.language_id),
      sourceCode,
      stdin,
      wallTimeLimitSec: wallLimit,
      memoryLimitKb: Number(body.memory_limit) || undefined
    });
    if (queued.unsupported) {
      return res.status(400).json({ error: `Unsupported language_id: ${body.language_id}` });
    }
    if (req.query.wait === "true") {
      const done = await waitForCompletion(queued.token, req.apiClient._id);
      return res.status(200).json(toJudge0Response(done));
    }
    // Judge0 answers an async create with just the token.
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
    return res.status(200).json(toJudge0Response(doc));
  }
  return res.status(404).json({ error: "Synchronous-only judge: nothing to poll for token " + req.params.token });
}
