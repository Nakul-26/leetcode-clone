// Turns the IDE's editable JSON test-case strings (one JSON array of args per case) into
// the {inputs, expected, isSample} shape problems.run()/POST /problems/:id/run expects.
// `problem` is optional — when given, an `expected` value is looked up from the problem's
// own sample test cases by index (AssessmentWorkspace does this so a Run during an exam can
// show pass/fail, not just raw output); ProblemPage's practice-mode Run never has a known
// expected value for a user-authored case, so it's left null there.
export function buildCustomTests(testCaseStrings, problem) {
  return testCaseStrings.map((tcStr, idx) => {
    const parsed = JSON.parse(tcStr || '[]');
    const inputArr = Array.isArray(parsed) ? parsed : [parsed];
    const expected = (problem?.testCases?.[idx]?.expected !== undefined)
      ? problem.testCases[idx].expected
      : null;
    return { inputs: inputArr, expected, isSample: true };
  });
}
