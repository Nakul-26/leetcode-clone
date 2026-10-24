// The editable test cases under the IDE, for Run (JUDGE_FIX_PLAN Phase 6).
//
// Function problems: each case is a JSON array of arguments, e.g. [[2,7,11,15], 9].
// Stdin problems: each case is the raw text the program reads, typed as-is.
//
// Only inputs are sent. The server works out each expected output itself (the matching sample's
// answer, or the reference solution's output), so a student's own case is never compared with
// an answer that belongs to a different input.

// Must match MAX_CUSTOM_TESTS in assessment-api problems.service.js.
export const MAX_CUSTOM_TESTS = 8;

export const isStdinProblem = (problem) => (problem?.problemType || 'function') === 'stdin';

export function emptyTestCase(problem) {
  return isStdinProblem(problem) ? '' : '[]';
}

// The sample tests, as editable strings, to start the editor with.
export function initialTestCases(problem) {
  const samples = (problem?.testCases || []).filter((tc) => tc.isSample).slice(0, MAX_CUSTOM_TESTS);
  if (samples.length === 0) return [emptyTestCase(problem)];
  return samples.map((tc) => {
    if (isStdinProblem(problem)) {
      return String(Array.isArray(tc.inputs) ? (tc.inputs[0] ?? '') : (tc.inputs ?? ''));
    }
    return typeof tc.inputs === 'string' ? tc.inputs : JSON.stringify(tc.inputs);
  });
}

// Throws (JSON.parse) on a function-problem case that is not valid JSON.
export function buildCustomTests(testCaseStrings, problem) {
  return testCaseStrings.slice(0, MAX_CUSTOM_TESTS).map((str) => {
    if (isStdinProblem(problem)) return { inputs: [str ?? ''] };
    const parsed = JSON.parse(str || '[]');
    return { inputs: Array.isArray(parsed) ? parsed : [parsed] };
  });
}
