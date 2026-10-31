import crypto from "crypto";
import { judgeFetch } from "./judgeClient.service.js";
import { HttpError } from "../utils/httpError.js";
import { getCacheJSON, setCacheJSON } from "./cache.service.js";

// The reference solution is the source of truth for expected output (JUDGE_FIX_PLAN Phase 6).
// This runs it on a set of test inputs through the judge's synchronous /run and reports, per
// test, what it produced and whether that agrees with the expected value the author typed.
//
// Used to fill in expected outputs while authoring (P6), to block saving a problem whose
// expected outputs disagree with its reference solution (P7), and to give a student's own
// Run test an expected output (P3).

const REFERENCE_RUN_TIMEOUT_MS = 120_000;

function hasValue(v) {
  return v !== undefined && v !== null && !(typeof v === "string" && v === "");
}

function isStdin(problem) {
  return (problem.problemType || "function") === "stdin";
}

function errorText(detail) {
  const kind = detail.errorType;
  if (kind === "timeout") return "Time Limit Exceeded";
  if (kind === "memory_limit") return "Memory Limit Exceeded";
  if (kind === "runtime") {
    const trace = String(detail.traceback || detail.stderr || "").trim().split("\n").slice(-3).join("\n");
    return trace ? `Runtime Error: ${trace}` : "Runtime Error";
  }
  if (detail.error && detail.error !== "Wrong Answer" && kind !== "wrong_answer") return detail.error;
  return null;
}

/**
 * Runs the problem's reference solution on `testCases` ({ inputs, expected? }).
 * Returns one entry per test, in order: { output, matches, error, stderr, timeMs }.
 *   output  - what the reference solution returned (function) or printed (stdin)
 *   matches - true/false when the test has an expected value, null when it has none
 *   error   - set when the reference solution itself failed on this test (TLE, crash)
 * Throws HttpError 400 when there is no reference solution or it does not compile.
 */
export async function runReferenceSolution(problem, testCases, { timeLimitMs, memoryLimitMb } = {}) {
  if (!problem.referenceSolution || !problem.solutionLanguage) {
    throw new HttpError(400, "A reference solution is required", {
      msg: "Add a reference solution and its language first: expected outputs are computed from it."
    });
  }
  if (!Array.isArray(testCases) || testCases.length === 0) return [];

  const stdin = isStdin(problem);
  const msg = {
    schemaVersion: "1",
    submissionId: "reference-" + Date.now(),
    // Always the draft definition: while editing, the saved problem may be out of date.
    problemId: "temp",
    language: problem.solutionLanguage,
    code: problem.referenceSolution,
    problemType: stdin ? "stdin" : "function",
    compareMode: problem.compareConfig?.mode || "STRUCTURAL",
    compareConfig: problem.compareConfig || {},
    tests: testCases.map((tc) => ({
      inputs: tc.inputs,
      expected: hasValue(tc.expected) ? tc.expected : null,
      isHidden: true
    }))
  };
  // Run under the limits students will get; the judge clamps them.
  const time = timeLimitMs ?? problem.timeLimitMs;
  const memory = memoryLimitMb ?? problem.memoryLimitMb;
  if (time > 0) msg.timeLimitMs = Math.round(time);
  if (memory > 0) msg.memoryLimitMb = Math.round(memory);
  if (!stdin) {
    msg.functionName = problem.functionName;
    msg.parameters = problem.parameters;
    msg.returnType = problem.returnType;
  }

  let result;
  try {
    const response = await judgeFetch("/run", { body: JSON.stringify(msg), timeoutMs: REFERENCE_RUN_TIMEOUT_MS });
    if (!response.ok) {
      const text = await response.text();
      throw new HttpError(response.status >= 500 ? 502 : 400, "Judge rejected the reference run", { msg: `Judge error: ${text}` });
    }
    result = await response.json();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "Judge unavailable", { msg: `Could not reach the judge to run the reference solution: ${err.message}` });
  }

  if (result.status === "Compilation Error") {
    throw new HttpError(400, "Reference solution does not compile", {
      msg: "The reference solution does not compile.",
      compileOutput: result.stderr || result.error || null
    });
  }

  const details = Array.isArray(result.details) ? result.details : [];
  return testCases.map((tc, i) => {
    const detail = details.find((d) => d.test === i + 1) || details[i];
    if (!detail) return { output: null, matches: null, error: "The judge returned no result for this test", stderr: "", timeMs: 0 };
    const error = errorText(detail);
    return {
      output: detail.output ?? null,
      matches: error ? false : hasValue(tc.expected) ? !!detail.passed : null,
      error,
      stderr: detail.stderr || detail.traceback || "",
      timeMs: detail.timeMs ?? 0
    };
  });
}

/**
 * Expected outputs for a student's own Run tests, computed from the reference solution and
 * cached per problem version and input, so repeated Runs of the same input cost nothing.
 * Returns an array aligned with `inputsList`; an entry is undefined when no expected output
 * could be computed (no reference solution, or it failed on that input).
 */
export async function referenceOutputsFor(problem, inputsList) {
  if (!problem.referenceSolution || !problem.solutionLanguage || inputsList.length === 0) {
    return inputsList.map(() => undefined);
  }
  const version = problem.updatedAt ? new Date(problem.updatedAt).getTime() : 0;
  const keyFor = (inputs) =>
    `refout:${problem._id}:${version}:` + crypto.createHash("sha1").update(JSON.stringify(inputs)).digest("hex");

  const out = new Array(inputsList.length);
  const missing = [];
  for (let i = 0; i < inputsList.length; i++) {
    const cached = await getCacheJSON(keyFor(inputsList[i]));
    if (cached && "output" in cached) out[i] = cached.output;
    else missing.push(i);
  }
  if (missing.length > 0) {
    const results = await runReferenceSolution(problem, missing.map((i) => ({ inputs: inputsList[i] })));
    for (let k = 0; k < missing.length; k++) {
      const i = missing[k];
      if (results[k].error) continue; // the student's input broke the reference solution: no expected
      out[i] = results[k].output;
      await setCacheJSON(keyFor(inputsList[i]), { output: results[k].output }, 24 * 3600);
    }
  }
  return out;
}
