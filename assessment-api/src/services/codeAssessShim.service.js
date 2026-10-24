// Uses Node's built-in global fetch (Node 18+) — same convention as
// problems.service.js / preview.service.js / admin.routes.js. The "node-fetch"
// package is not a listed dependency; don't import it.
import { env } from "../config/env.js";

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
    const resp = await fetch(`${env.JUDGE_SERVICE_URL}/raw-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  return {
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
  };
}
