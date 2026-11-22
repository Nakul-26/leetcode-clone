import { describe, it, expect, vi } from 'vitest';

// The judge's /run answer for a stdin Python program that read "5 3" with int(input()).
const runResult = vi.hoisted(() => ({
  status: 'Runtime Error',
  details: [{
    test: 1,
    errorType: 'runtime',
    stdout: '',
    stderr: 'Traceback (most recent call last):\n  File "/app/solution.py", line 1, in <module>\n    n = int(input())\nValueError: invalid literal for int() with base 10: \'5 3\'',
    exitCode: 1
  }]
}));

vi.mock('./judgeClient.service.js', () => ({
  judgeFetch: vi.fn(async () => ({ ok: true, json: async () => runResult }))
}));
vi.mock('../repositories/problems.repo.js', () => ({
  findByExternalId: vi.fn(async () => ({ _id: 'p1', problemType: 'stdin' }))
}));

const { runArventiqCode, mapSubmissionToArventiqVerdict } = await import('./arventiq.service.js');

// Arventiq's students get the same plain-language hints as this platform's own pages.
describe('Arventiq diagnostics', () => {
  it('Run explains a stdin input mistake', async () => {
    const res = await runArventiqCode({ questionId: 'q1', code: 'n = int(input())\nprint(n)\n', codeLanguage: 'python', customInput: '5 3\n' });
    expect(res.errorType).toBe('runtime');
    expect(res.stderr).not.toContain('/app/');
    expect(res.diagnostics.length).toBeGreaterThan(0);
    expect(res.diagnostics.map((d) => JSON.stringify(d)).join(' ')).toContain('input().split()');
  });

  it('a verdict passes through the diagnostics computed on read', () => {
    const diagnostics = [{ line: 1, message: 'ValueError', hint: 'use split()' }];
    const verdict = mapSubmissionToArventiqVerdict({
      status: 'Runtime Error',
      testResult: { status: 'Runtime Error', total: 1, passed: 0, details: [], diagnostics }
    });
    expect(verdict.diagnostics).toEqual(diagnostics);
  });

  it('a verdict without errors has an empty list', () => {
    const verdict = mapSubmissionToArventiqVerdict({
      status: 'Accepted',
      testResult: { status: 'Accepted', total: 1, passed: 1, details: [] }
    });
    expect(verdict.diagnostics).toEqual([]);
  });
});
