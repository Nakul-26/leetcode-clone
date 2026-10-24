import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import Problem from '../../models/Problem.mjs';
import * as authService from '../services/auth.service.js';

// JUDGE_FIX_PLAN Phase 6: the reference solution is the source of truth for expected output.
//
// A fake judge /run: "code" names what the program does. "double" is correct (n -> 2n),
// "off-by-one" is wrong (n -> 2n + 1), "crash" fails. Function tests take [n]; stdin tests
// take ["n\n"] and print "2n\n".
const calls = [];
function fakeRun(code, inputs, stdin) {
  const n = Number(stdin ? String(inputs[0]).trim() : inputs[0]);
  if (code === 'crash') return { error: true };
  const v = code === 'off-by-one' ? 2 * n + 1 : 2 * n;
  return { output: stdin ? `${v}\n` : v };
}
function fakeJudge(_url, init = {}) {
  const msg = JSON.parse(init.body);
  calls.push(msg);
  const stdin = msg.problemType === 'stdin';
  const details = msg.tests.map((t, i) => {
    const r = fakeRun(msg.code, t.inputs, stdin);
    if (r.error) return { test: i + 1, passed: false, errorType: 'runtime', error: 'Runtime Error', traceback: 'ZeroDivisionError' };
    const hasExpected = t.expected !== null && t.expected !== undefined;
    const passed = hasExpected ? JSON.stringify(r.output) === JSON.stringify(t.expected) : stdin;
    return { test: i + 1, passed, output: r.output, expected: t.expected, ...(passed ? {} : { errorType: 'wrong_answer' }) };
  });
  const failed = details.some((d) => !d.passed);
  return { ok: true, json: async () => ({ status: failed ? 'Wrong Answer' : 'Accepted', details, passedCount: details.filter((d) => d.passed).length, totalCount: details.length }) };
}

describe('reference solution as the source of truth (Phase 6)', () => {
  let adminToken;
  let studentToken;
  const savedFetch = global.fetch;

  beforeEach(async () => {
    calls.length = 0;
    global.fetch = (url, init) => Promise.resolve(fakeJudge(url, init));
    adminToken = (await authService.register({ name: 'A', email: `a-${Date.now()}@t.com`, password: 'password123', role: 'admin' })).token;
    studentToken = (await authService.register({ name: 'S', email: `s-${Date.now()}@t.com`, password: 'password123', role: 'student' })).token;
  });
  afterEach(() => {
    global.fetch = savedFetch;
  });

  const stdinDraft = (testCases, referenceSolution = 'double') => ({
    title: 'Double', description: 'Print twice the number', difficulty: 'Easy', problemType: 'stdin',
    referenceSolution, solutionLanguage: 'python', testCases
  });

  describe('POST /api/problems/reference-outputs (P6)', () => {
    it('returns the reference output for each input and flags typed values that disagree', async () => {
      const res = await request(app)
        .post('/api/problems/reference-outputs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(stdinDraft([
          { inputs: ['3\n'], isSample: true },
          { inputs: ['5\n'], expected: '10\n' },
          { inputs: ['7\n'], expected: '15\n' }
        ]));
      expect(res.status).toBe(200);
      expect(res.body.tests).toMatchObject([
        { output: '6\n', matches: null, error: null },
        { output: '10\n', matches: true, error: null },
        { output: '14\n', matches: false, error: null }
      ]);
    });

    it('reports a reference solution that crashes on an input', async () => {
      const res = await request(app)
        .post('/api/problems/reference-outputs')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(stdinDraft([{ inputs: ['3\n'], isSample: true }], 'crash'));
      expect(res.status).toBe(200);
      expect(res.body.tests[0]).toMatchObject({ matches: false });
      expect(res.body.tests[0].error).toMatch(/Runtime Error/);
    });

    it('is staff-only', async () => {
      const res = await request(app)
        .post('/api/problems/reference-outputs')
        .set('Authorization', `Bearer ${studentToken}`)
        .send(stdinDraft([{ inputs: ['3\n'] }]));
      expect(res.status).toBe(403);
    });
  });

  describe('saving a stdin problem (P7, P8)', () => {
    it('is refused when an expected output disagrees with the reference solution, naming the test', async () => {
      const res = await request(app)
        .post('/api/problems')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(stdinDraft([
          { inputs: ['3\n'], expected: '6\n', isSample: true },
          { inputs: ['7\n'], expected: '15\n' }
        ]));
      expect(res.status).toBe(400);
      expect(res.body.errors.join(' ')).toMatch(/Test case 2 \(hidden\): expected "15\\n" but the reference solution gives "14\\n"/);
    });

    it('is saved when every expected output matches; the reference solution is stored but never shown to students', async () => {
      const res = await request(app)
        .post('/api/problems')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(stdinDraft([
          { inputs: ['3\n'], expected: '6\n', isSample: true },
          { inputs: ['7\n'], expected: '14\n' }
        ]));
      expect(res.status).toBe(201);
      const id = res.body.problem._id;

      const asStudent = await request(app).get(`/api/problems/${id}`).set('Authorization', `Bearer ${studentToken}`);
      expect(asStudent.status).toBe(200);
      expect(asStudent.body.referenceSolution).toBeUndefined();
      expect(asStudent.body.solutionLanguage).toBeUndefined();
      expect(asStudent.body.testCases).toHaveLength(1); // the sample only

      const asAdmin = await request(app).get(`/api/problems/${id}`).set('Authorization', `Bearer ${adminToken}`);
      expect(asAdmin.body.referenceSolution).toBe('double');
    });
  });

  describe('Run (P1-P4)', () => {
    let problemId;
    beforeEach(async () => {
      const p = await Problem.create({
        title: 'Double', description: 'd', difficulty: 'Easy', problemType: 'stdin',
        referenceSolution: 'double', solutionLanguage: 'python',
        testCases: [
          { inputs: ['3\n'], expected: '6\n', isSample: true },
          { inputs: ['4\n'], expected: '8\n', isSample: true },
          { inputs: ['100\n'], expected: '200\n', isSample: false, isHidden: true }
        ]
      });
      problemId = p._id.toString();
    });
    const run = (body) => request(app).post(`/api/problems/${problemId}/run`).set('Authorization', `Bearer ${studentToken}`).send({ language: 'python', ...body });

    it('a plain Run sends exactly the samples, never a hidden test (P4)', async () => {
      const res = await run({ code: 'double' });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].tests.map((t) => t.inputs[0])).toEqual(['3\n', '4\n']);
    });

    it("a student's own test gets its expected output from the reference solution, not from the browser (P1, P3)", async () => {
      // The browser claims sample 1's answer for a different input, as buildCustomTests used to.
      const res = await run({ code: 'double', customTests: [{ inputs: ['21\n'], expected: '6\n' }] });
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(2); // reference solution, then the student's code
      expect(calls[0].code).toBe('double');
      expect(calls[1].tests[0].expected).toBe('42\n');
      expect(res.body.status).toBe('Accepted');
      expect(res.body.details[0]).toMatchObject({ passed: true, expected: '42\n' });
    });

    it('a wrong solution fails on its own test', async () => {
      const res = await run({ code: 'off-by-one', customTests: [{ inputs: ['21\n'] }] });
      expect(res.body.details[0]).toMatchObject({ passed: false, expected: '42\n', output: '43\n' });
    });

    it('an input equal to a sample uses the sample answer without running the reference solution', async () => {
      const res = await run({ code: 'double', customTests: [{ inputs: ['4\n'] }] });
      expect(calls).toHaveLength(1);
      expect(res.body.details[0]).toMatchObject({ passed: true, expected: '8\n' });
    });

    it('accepts a stdin test as bare text', async () => {
      const res = await run({ code: 'double', customTests: ['5\n'] });
      expect(res.body.details[0]).toMatchObject({ passed: true, expected: '10\n' });
    });

    it('refuses more than 8 tests (P2)', async () => {
      const res = await run({ code: 'double', customTests: Array.from({ length: 9 }, (_, i) => [`${i}\n`]) });
      expect(res.status).toBe(400);
      expect(res.body.msg).toMatch(/at most 8/);
    });

    it('without a reference solution, an own test still runs and shows its output, with no verdict', async () => {
      await Problem.updateOne({ _id: problemId }, { $unset: { referenceSolution: 1, solutionLanguage: 1 } });
      const res = await run({ code: 'double', customTests: [{ inputs: ['21\n'] }] });
      expect(calls).toHaveLength(1);
      expect(res.body.details[0]).toMatchObject({ noExpected: true, passed: null, output: '42\n' });
      expect(res.body.status).toBe('Finished');
    });
  });
});
