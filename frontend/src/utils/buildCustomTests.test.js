import { describe, it, expect } from 'vitest';
import { buildCustomTests, initialTestCases, emptyTestCase, MAX_CUSTOM_TESTS } from './buildCustomTests';

const fnProblem = {
  problemType: 'function',
  testCases: [{ inputs: [[2, 7], 9], expected: [0, 1], isSample: true }]
};
const stdinProblem = {
  problemType: 'stdin',
  testCases: [{ inputs: ['3\n1 2 3\n'], expected: '6\n', isSample: true }]
};

describe('buildCustomTests (JUDGE_FIX_PLAN Phase 6)', () => {
  it('never sends an expected value: the server works it out (P1)', () => {
    // Editing sample 1's input used to keep sample 1's answer, so correct code failed.
    const [t] = buildCustomTests(['[[1, 1], 2]'], fnProblem);
    expect(t).toEqual({ inputs: [[1, 1], 2] });
  });

  it('stdin cases are plain text, not JSON (P9)', () => {
    expect(initialTestCases(stdinProblem)).toEqual(['3\n1 2 3\n']);
    expect(buildCustomTests(['5\n'], stdinProblem)).toEqual([{ inputs: ['5\n'] }]);
    expect(emptyTestCase(stdinProblem)).toBe('');
  });

  it('function cases start as the samples in JSON', () => {
    expect(initialTestCases(fnProblem)).toEqual(['[[2,7],9]']);
    expect(emptyTestCase(fnProblem)).toBe('[]');
  });

  it(`sends at most ${MAX_CUSTOM_TESTS} cases (P2)`, () => {
    expect(buildCustomTests(Array(12).fill('[1]'), fnProblem)).toHaveLength(MAX_CUSTOM_TESTS);
  });

  it('throws on invalid JSON for function problems', () => {
    expect(() => buildCustomTests(['[1,'], fnProblem)).toThrow();
  });
});
