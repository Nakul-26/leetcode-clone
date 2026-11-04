// Uses Node's built-in global fetch (Node 18+) — same convention as
// problems.service.js / preview.service.js / admin.routes.js. The "node-fetch"
// package is not a listed dependency; don't import it.
import { judgeFetch } from "./judgeClient.service.js";
import { analyze, describeSignal, isPythonSyntaxError, stripWorkspacePaths } from "./diagnostics.service.js";

// Public-API numeric language IDs -> judge-service-go's internal language keys
// (pkg/languages/languages.go). 51 matches the conventional id for C# (Mono) so callers
// that assume standard ids don't need special-casing us.
const LANGUAGE_ID_MAP = {
  71: "python",
  63: "javascript",
  74: "typescript",
  62: "java",
  50: "c",
  54: "cpp",
  60: "go",
  73: "rust",
  72: "ruby",
  68: "php",
  78: "kotlin",
  51: "csharp",
};

// GO Judge status ids judge.js understands (see exam-platform/workers/student-workerjs/src/judge.js).
const CODEASSESS_STATUS = {
  ACCEPTED: 3,
  RUNTIME_ERROR: 11,
  TIME_LIMIT_EXCEEDED: 5,
  COMPILATION_ERROR: 6,
  INTERNAL_ERROR: 13,
};

export function mapLanguageId(languageId) {
  return LANGUAGE_ID_MAP[languageId] || null;
}

const STATUS_DESCRIPTIONS = {
  3: "Accepted",
  5: "Time Limit Exceeded",
  6: "Compilation Error",
  11: "Runtime Error (NZEC)",
  13: "Internal Error"
};

/**
 * Makes a finished GO Judge result readable for a student (docs/EDITOR_UX_PLAN.md B3), on
 * plain (not base64) fields. Used by both the synchronous and the queue-backed paths.
 *
 * - Removes the judge's workspace paths from stderr and compile_output.
 * - A Python SyntaxError/IndentationError never ran, so it is a Compilation Error (6) with the
 *   message in compile_output, like any other compiler.
 * - A program killed by a signal (a C/C++ segfault) prints nothing; stderr then says what
 *   happened instead of being empty.
 * - status always has a description.
 * - diagnostics: up to three { line, column, kind, message, hint } (diagnostics.service.js).
 *
 * Everything is additive or a cleaner version of the same text, so existing callers that only
 * read status.id, stdout, stderr and compile_output keep working.
 */
export function explainRawResult(result, { language, code, memoryLimitHit = false }) {
  let stderr = stripWorkspacePaths(result.stderr || "");
  let compileOutput = stripWorkspacePaths(result.compile_output || "");
  let id = result.status?.id;

  if (language === "python" && id === CODEASSESS_STATUS.RUNTIME_ERROR && isPythonSyntaxError(stderr)) {
    id = CODEASSESS_STATUS.COMPILATION_ERROR;
    compileOutput = stderr;
    stderr = "";
  }
  if (id === CODEASSESS_STATUS.RUNTIME_ERROR && !stderr.trim() && !memoryLimitHit && Number(result.exit_code) > 128) {
    stderr = describeSignal(result.exit_code);
  }

  const kind = {
    [CODEASSESS_STATUS.COMPILATION_ERROR]: "compile",
    [CODEASSESS_STATUS.TIME_LIMIT_EXCEEDED]: "timeout",
    [CODEASSESS_STATUS.RUNTIME_ERROR]: memoryLimitHit ? "memory" : "runtime"
  }[id];
  const diagnostics = kind
    ? analyze({ language, code, compileOutput, stderr, kind, exitCode: result.exit_code, trustLines: true })
    : [];

  return {
    ...result,
    stderr,
    compile_output: compileOutput,
    status: { id, description: STATUS_DESCRIPTIONS[id] || result.status?.description },
    diagnostics
  };
}

/**
 * Calls judge-service-go's internal /raw-run endpoint (compile + run one source file
 * against one stdin payload, no test cases/wrapper/comparison) and returns a result
 * already shaped like a GO Judge public API `/submissions` response — the exact shape
 * exam-platform's judge.js already knows how to parse.
 *
 * cpuTimeLimitSec / wallTimeLimitSec / memoryLimitKb come straight from the GO Judge
 * request body exam-platform sends; there is no per-problem or per-student state here.
 */
export async function runRawCodeAssess({ languageId, sourceCode, stdin, wallTimeLimitSec, memoryLimitKb }) {
  const language = mapLanguageId(languageId);
  if (!language) {
    return {
      stdout: "",
      stderr: `Unsupported language_id: ${languageId}`,
      compile_output: "",
      status: { id: CODEASSESS_STATUS.INTERNAL_ERROR },
      time: 0,
      memory: 0,
      exit_code: null,
      exit_signal: null,
    };
  }

  const timeoutMs = Math.round((Number(wallTimeLimitSec) || 10) * 1000);
  const memoryLimitMb = Math.max(1, Math.round((Number(memoryLimitKb) || 262144) / 1024));

  let raw;
  try {
    const resp = await judgeFetch("/raw-run", {
      body: JSON.stringify({
        language,
        code: sourceCode,
        stdin: stdin || "",
        timeoutMs,
        memoryLimitMb,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        stdout: "",
        stderr: `Judge backend ${resp.status}: ${text.slice(0, 300)}`,
        compile_output: "",
        status: { id: CODEASSESS_STATUS.INTERNAL_ERROR },
        time: 0,
        memory: 0,
        exit_code: null,
        exit_signal: null,
      };
    }
    raw = await resp.json();
  } catch (e) {
    return {
      stdout: "",
      stderr: `Judge backend unreachable: ${String(e.message || e).slice(0, 300)}`,
      compile_output: "",
      status: { id: CODEASSESS_STATUS.INTERNAL_ERROR },
      time: 0,
      memory: 0,
      exit_code: null,
      exit_signal: null,
    };
  }

  let statusId = CODEASSESS_STATUS.ACCEPTED;
  let memoryKb = 0;
  if (raw.compileError) {
    statusId = CODEASSESS_STATUS.COMPILATION_ERROR;
  } else if (raw.timedOut) {
    statusId = CODEASSESS_STATUS.TIME_LIMIT_EXCEEDED;
  } else if (raw.oomKilled) {
    statusId = CODEASSESS_STATUS.RUNTIME_ERROR;
    // judge-service-go doesn't meter peak memory yet; echo back the requested
    // ceiling so exam-platform's own "memory >= limit => MLE" reclassification
    // (runOnJudge in judge.js) fires correctly on an OOM kill.
    memoryKb = memoryLimitMb * 1024;
  } else if (raw.error) {
    statusId = CODEASSESS_STATUS.INTERNAL_ERROR;
  } else if (raw.exitCode && raw.exitCode !== 0) {
    statusId = CODEASSESS_STATUS.RUNTIME_ERROR;
  }

  return explainRawResult({
    stdout: raw.stdout || "",
    // raw.error (judge-service-go's internal/plumbing failure message, distinct from
    // compile/timeout/OOM) was previously dropped entirely, making INTERNAL_ERROR
    // responses indistinguishable from a truly silent failure — surface it here so
    // callers (and anyone debugging via this endpoint directly) can see what broke.
    stderr: raw.stderr || (raw.error ? `Judge internal error: ${String(raw.error).slice(0, 300)}` : ""),
    compile_output: raw.compileOutput || "",
    status: { id: statusId },
    time: (Number(raw.timeMs) || 0) / 1000,
    memory: memoryKb,
    exit_code: raw.exitCode ?? null,
    exit_signal: null,
  }, { language, code: sourceCode, memoryLimitHit: !!raw.oomKilled });
}
