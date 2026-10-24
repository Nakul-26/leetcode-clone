import { mapLanguageId } from "./codeAssessShim.service.js";
import { runReferenceSolution } from "./referenceSolution.service.js";
import { HttpError } from "../utils/httpError.js";

// Test-case authoring for platforms that only use this service as a judge (the exam portal):
// they keep their questions and reference solutions themselves and send them here only to
// run (JUDGE_FIX_PLAN Phase 6, P12). Nothing in the request is stored.
//
// Given a reference solution and a list of inputs, returns what it prints for each input
// (generate) and, where the caller sent an expected output, whether that output is correct
// (check). Comparison uses the judge's rule for stdin problems: equal after trailing spaces,
// tabs and newlines are removed (judge-service-go comparator.CompareText). exact_match is also
// reported for callers that compare byte for byte.

export const MAX_CHECK_CASES = 100;

// GO Judge status ids, as on the rest of this API surface.
const STATUS = {
  OK: { id: 3, description: "Accepted" },
  TLE: { id: 5, description: "Time Limit Exceeded" },
  COMPILE: { id: 6, description: "Compilation Error" },
  RUNTIME: { id: 11, description: "Runtime Error (NZEC)" }
};

const trimEnd = (s) => String(s ?? "").replace(/[ \t\r\n]+$/, "");

function statusFor(error) {
  if (!error) return STATUS.OK;
  if (/^Time Limit/.test(error)) return STATUS.TLE;
  if (/^Memory Limit/.test(error)) return { id: 11, description: "Runtime Error (memory limit exceeded)" };
  return STATUS.RUNTIME;
}

/**
 * @param cases [{ stdin, expected_output? }] with plain-text values
 * @param mode "check" compares expected_output when present; "generate" ignores it
 */
export async function checkTestCases({ languageId, sourceCode, cases, timeLimitSec, memoryLimitKb, mode = "check" }) {
  const language = mapLanguageId(Number(languageId));
  if (!language) throw new HttpError(400, "Unsupported language", { error: `Unsupported language_id: ${languageId}` });
  if (!sourceCode) throw new HttpError(400, "No source", { error: "source_code (the reference solution) is required" });
  if (!Array.isArray(cases) || cases.length === 0) throw new HttpError(400, "No test cases", { error: "test_cases must be a non-empty array" });
  if (cases.length > MAX_CHECK_CASES) {
    throw new HttpError(422, "Too many test cases", { error: `At most ${MAX_CHECK_CASES} test cases per request`, code: "too_many_test_cases" });
  }

  const problem = { problemType: "stdin", referenceSolution: sourceCode, solutionLanguage: language };
  let runs;
  try {
    runs = await runReferenceSolution(problem, cases.map((c) => ({ inputs: [String(c.stdin ?? "")] })), {
      timeLimitMs: timeLimitSec > 0 ? timeLimitSec * 1000 : undefined,
      memoryLimitMb: memoryLimitKb > 0 ? Math.max(1, Math.round(memoryLimitKb / 1024)) : undefined
    });
  } catch (err) {
    if (err.status === 400 && err.body && "compileOutput" in err.body) {
      return {
        compile_error: true,
        compile_output: err.body.compileOutput || "",
        status: STATUS.COMPILE,
        summary: { total: cases.length, matched: 0, mismatched: 0, generated: 0, failed: cases.length },
        results: []
      };
    }
    throw err;
  }

  const summary = { total: cases.length, matched: 0, mismatched: 0, generated: 0, failed: 0 };
  const results = runs.map((r, index) => {
    const hasExpected = mode === "check" && cases[index].expected_output !== undefined && cases[index].expected_output !== null;
    const expected = hasExpected ? String(cases[index].expected_output) : null;
    const actual = r.error ? null : String(r.output ?? "");
    let match = null;
    if (r.error) {
      summary.failed++;
      if (hasExpected) match = false;
    } else if (hasExpected) {
      match = trimEnd(actual) === trimEnd(expected);
      summary[match ? "matched" : "mismatched"]++;
    } else {
      summary.generated++;
    }
    return {
      index,
      status: statusFor(r.error),
      actual_output: actual,
      expected_output: expected,
      match,
      exact_match: hasExpected && actual !== null ? actual === expected : null,
      error: r.error || null,
      stderr: r.stderr || "",
      time: ((r.timeMs || 0) / 1000).toFixed(3)
    };
  });

  const checked = summary.matched + summary.mismatched;
  return {
    compile_error: false,
    compile_output: null,
    // True only when every case had an expected output and all of them are correct.
    all_match: mode === "check" && summary.failed === 0 && summary.generated === 0 && checked === cases.length && summary.mismatched === 0,
    summary,
    results
  };
}
