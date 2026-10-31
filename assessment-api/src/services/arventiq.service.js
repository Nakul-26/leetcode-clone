import * as problemsRepo from "../repositories/problems.repo.js";
import * as submissionsService from "./submissions.service.js";
import { HttpError } from "../utils/httpError.js";
import { resolveArventiqLanguage } from "../config/arventiqLanguages.js";
import { judgeFetch } from "./judgeClient.service.js";

// Translates Arventiq's native `questions` + `test_cases` schema (see
// docs/arventiq-integration/history/04-arventiq-real-schema-and-payload.md)
// into this platform's Problem shape. Arventiq problems are stdin/stdout
// programs, not named functions — see PLAN.md §2.
function validateArventiqProblemPayload(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") {
    return ["request body must be an object"];
  }
  if (payload.id === undefined || payload.id === null || payload.id === "") {
    errors.push("id is required");
  }
  if (!payload.code_language || typeof payload.code_language !== "string") {
    errors.push("code_language is required");
  } else if (!resolveArventiqLanguage(payload.code_language)) {
    errors.push(`code_language '${payload.code_language}' is not a supported language`);
  }
  if (!payload.question_text || typeof payload.question_text !== "string") {
    errors.push("question_text is required");
  }
  if (!Array.isArray(payload.test_cases) || payload.test_cases.length === 0) {
    errors.push("test_cases must be a non-empty array");
  } else {
    payload.test_cases.forEach((tc, i) => {
      if (tc.input === undefined || tc.input === null) {
        errors.push(`test_cases[${i}].input is required`);
      }
      if (tc.expected_output === undefined || tc.expected_output === null) {
        errors.push(`test_cases[${i}].expected_output is required`);
      }
    });
    if (!payload.test_cases.some((tc) => !tc.is_hidden && tc.visibility !== "hidden")) {
      errors.push("at least one test case must be visible (is_hidden: 0 or visibility !== 'hidden')");
    }
  }
  return errors;
}

function isArventiqTestHidden(tc) {
  return !!tc.is_hidden || tc.visibility === "hidden";
}

export async function syncProblem(payload) {
  const errors = validateArventiqProblemPayload(payload);
  if (errors.length > 0) {
    throw new HttpError(400, "Invalid Arventiq problem payload", { errors });
  }

  const testCases = payload.test_cases.map((tc) => {
    const hidden = isArventiqTestHidden(tc);
    return {
      // Stdin-mode test cases carry raw text, not typed values: `inputs` is a
      // single-element array holding the full stdin blob, `expected` is the
      // expected stdout text — see judge-service-go/pkg/models/problem.go's
      // stdin validation block for the shape the Go judge requires.
      inputs: [String(tc.input ?? "")],
      expected: String(tc.expected_output ?? ""),
      isHidden: hidden,
      isSample: !hidden
    };
  });

  const doc = {
    externalId: String(payload.id),
    title: payload.title || `Arventiq Question ${payload.id}`,
    description: payload.question_text,
    // Arventiq doesn't send a difficulty rating; not a field Arventiq scores by.
    difficulty: "Medium",
    problemType: "stdin",
    inputFormat: payload.input_format || "",
    outputFormat: payload.output_format || "",
    timeLimitMs: Number(payload.time_limit_ms) || 2000,
    memoryLimitMb: payload.memory_limit_kb ? Math.max(1, Math.round(Number(payload.memory_limit_kb) / 1024)) : 256,
    testCases,
    compareConfig: {
      mode: "EXACT",
      floatTolerance: Number(payload.float_tolerance) || 0
    }
  };

  const existing = await problemsRepo.findByExternalId(doc.externalId);
  if (existing) {
    Object.assign(existing, doc);
    await existing.save();
    return existing;
  }
  return problemsRepo.create(doc);
}

export async function submitArventiqSolution({ userId, questionId, code, codeLanguage, externalStudentId, externalAssessmentId, requestId, apiClientId = null }) {
  if (questionId === undefined || questionId === null || questionId === "") {
    throw new HttpError(400, "questionId is required");
  }
  if (typeof code !== "string" || !code) {
    throw new HttpError(400, "code is required");
  }

  const language = resolveArventiqLanguage(codeLanguage);
  if (!language) {
    throw new HttpError(400, `Unsupported or missing codeLanguage: ${codeLanguage}`);
  }

  const problem = await problemsRepo.findByExternalId(String(questionId));
  if (!problem) {
    throw new HttpError(404, `Problem ${questionId} not found — sync it via POST /api/arventiq/problems first`);
  }

  const result = await submissionsService.submitSolution({
    problemId: problem._id.toString(),
    code,
    language,
    userId,
    externalStudentId: externalStudentId != null ? String(externalStudentId) : null,
    externalAssessmentId: externalAssessmentId != null ? String(externalAssessmentId) : null,
    requestId,
    apiClientId
  });

  if (result.notFound) {
    throw new HttpError(404, "Problem not found");
  }

  return result.submission;
}

const VERDICT_MAP = {
  "Accepted": "accepted",
  "Wrong Answer": "wrong_answer",
  "Time Limit Exceeded": "time_limit_exceeded",
  "Memory Limit Exceeded": "memory_limit_exceeded",
  "Runtime Error": "runtime_error",
  "Compilation Error": "compilation_error"
};

function mapCaseVerdict(detail, submissionVerdict) {
  if (detail.error === "Time Limit Exceeded" || detail.errorType === "timeout") return "time_limit_exceeded";
  if (detail.errorType === "memory_limit") return "memory_limit_exceeded";
  if (detail.passed ?? detail.ok) return "accepted";
  if (detail.errorType === "wrong_answer") return "wrong_answer";
  if (detail.error) return "runtime_error";
  return submissionVerdict;
}

// Maps our internal Submission (+ the judge's SubmissionResult stored in
// testResult — see judge-service-go/pkg/models/result.go) into the verdict
// shape Arventiq's own judge.js produces, per history/04's sample response.
// Returns null if the submission hasn't finished judging yet.
export function mapSubmissionToArventiqVerdict(submission) {
  if (!submission) return null;
  const tr = submission.testResult;
  if (!tr || submission.status === "Pending" || submission.status === "Running") {
    return null;
  }

  const verdict = VERDICT_MAP[tr.status] || "runtime_error";
  const total = tr.total ?? tr.totalCount ?? 0;
  const passed = tr.passed ?? tr.passedCount ?? 0;
  const details = Array.isArray(tr.details) ? tr.details : [];

  const cases = details.map((d, idx) => ({
    index: d.test ?? idx + 1,
    verdict: mapCaseVerdict(d, verdict),
    time_ms: d.timeMs ?? 0,
    memory_kb: d.memoryKb || null,
    weight: 1.0,
    group: null,
    passed: !!(d.passed ?? d.ok),
    // Positional correlation to the test_cases order Arventiq sent at sync
    // time (no per-test external id is tracked yet — Phase 3/subtasks scope).
    input: d.input,
    expected: d.expected,
    actual: d.output ?? d.stdout,
    stderr: d.stderr || ""
  }));

  return {
    verdict,
    score: total > 0 ? Number((passed / total).toFixed(4)) : 0,
    max_time_ms: tr.maxTimeMs ?? 0,
    max_memory_kb: null,
    compile_output: verdict === "compilation_error" ? (submission.output || null) : null,
    passed_count: passed,
    total_count: total,
    cases
  };
}

export async function getArventiqSubmissionResult(submissionId, auth) {
  const result = await submissionsService.getSubmissionById(submissionId, auth);
  if (result.notFound || result.forbidden) {
    return result;
  }
  // The Arventiq service account carries role:"admin" with no collegeId, and
  // canAccessSubmission() lets any admin/faculty through whenever a submission has no
  // collegeId — true for every Arventiq submission (and, until the collegeId backfill
  // runs, most pre-existing ones too). Without this check, the shared ARVENTIQ_SECRET
  // could read ANY submission in the system by ID, not just ones Arventiq created.
  // externalStudentId/externalAssessmentId are only ever stamped by submitArventiqSolution,
  // so requiring one here scopes reads to genuinely Arventiq-originated submissions.
  const sub = result.submission;
  if (!sub || (!sub.externalStudentId && !sub.externalAssessmentId)) {
    return { forbidden: true };
  }
  const verdict = mapSubmissionToArventiqVerdict(sub);
  return { pending: verdict === null, verdict };
}

// "Run" (try code against arbitrary input) vs. "Submit" (judge against the
// synced official test cases) — Run must not create a Submission doc, must
// not go through RabbitMQ, and must not affect scores/history. It calls the
// Go judge's synchronous /run HTTP endpoint directly, the same ephemeral path
// problems.service.js::runProblem already uses for practice-mode "Run".
// Only these errorType values represent a real execution failure. Run always
// sends an empty `expected` (no notion of correctness), so the Go comparator
// dutifully reports "wrong_answer" against essentially any non-empty stdout —
// that's an artifact of the dummy comparison, not a real signal, and must not
// leak into the Run response.
const REAL_RUN_ERROR_TYPES = new Set(["timeout", "runtime", "memory_limit"]);

function mapRunResult(judgeResult) {
  const detail = Array.isArray(judgeResult?.details) && judgeResult.details.length > 0
    ? judgeResult.details[0]
    : null;
  const isCompilationError = judgeResult?.status === "Compilation Error";
  const isRealError = !isCompilationError && REAL_RUN_ERROR_TYPES.has(detail?.errorType);

  return {
    stdout: detail?.stdout ?? judgeResult?.stdout ?? "",
    // compileOutput is the single place to look for a compile failure — avoid
    // also duplicating that same text into stderr.
    stderr: isCompilationError ? "" : (detail?.stderr ?? judgeResult?.stderr ?? ""),
    compileOutput: isCompilationError ? (judgeResult?.stderr || null) : null,
    error: isRealError ? (detail?.error || null) : null,
    errorType: isCompilationError ? "compilation_error" : (isRealError ? detail.errorType : null),
    timeMs: detail?.timeMs ?? judgeResult?.maxTimeMs ?? 0,
    // Go's TestResult.ExitCode/MemoryKB are declared but not yet populated by any
    // execution path — always null/0 today; passed through as-is so a future
    // judge change starts showing real values with no Node-side change needed.
    memoryKb: detail?.memoryKb ?? null,
    exitCode: detail?.exitCode ?? null
  };
}

export async function runArventiqCode({ questionId, code, codeLanguage, customInput }) {
  if (questionId === undefined || questionId === null || questionId === "") {
    throw new HttpError(400, "questionId is required");
  }
  if (typeof code !== "string" || !code) {
    throw new HttpError(400, "code is required");
  }

  const language = resolveArventiqLanguage(codeLanguage);
  if (!language) {
    throw new HttpError(400, `Unsupported or missing codeLanguage: ${codeLanguage}`);
  }

  const problem = await problemsRepo.findByExternalId(String(questionId));
  if (!problem) {
    throw new HttpError(404, `Problem ${questionId} not found — sync it via POST /api/arventiq/problems first`);
  }

  const problemType = problem.problemType || "function";
  const judgeMsg = {
    schemaVersion: "1",
    submissionId: "arventiq-run-" + Date.now(),
    problemId: problem._id.toString(),
    language,
    code,
    problemType,
    // A single ephemeral test carrying the student's custom input. `expected`
    // is intentionally empty — Run has no notion of correctness, it just
    // returns raw stdout/stderr for the student to read themselves.
    tests: [{
      inputs: [typeof customInput === "string" ? customInput : ""],
      expected: ""
    }]
  };
  if (problemType !== "stdin") {
    judgeMsg.functionName = problem.functionName || "solution";
  }

  let response;
  try {
    response = await judgeFetch("/run", { body: JSON.stringify(judgeMsg) });
  } catch (err) {
    throw new HttpError(503, "Failed to connect to judge service: " + err.message);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new HttpError(response.status, "Judge service error: " + errorText);
  }

  const judgeResult = await response.json();
  return mapRunResult(judgeResult);
}
