import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import * as authService from '../services/auth.service.js';

// JUDGE_FIX_PLAN P11: an optional second solution (a brute force, say) is run on the same
// inputs and must agree with the reference solution, so one wrong reference solution cannot
// set every expected output.
//
// A fake judge /run: "code" names what the program does with n (stdin: it reads n, prints
// the result). "double" and "brute" are correct (2n). "wrong-on-big" is right below 100 and
// off by one from 100 on. "slow" runs out of time from 100 on. "no-compile" does not compile.
const calls = [];
function fakeRun(code, n) {
  if (code === 'slow' && n >= 100) return { tle: true };
  if (code === 'wrong-on-big' && n >= 100) return { output: `${2 * n + 1}\n` };
  return { output: `${2 * n}\n` };
}
function fakeJudge(_url, init = {}) {
  const msg = JSON.parse(init.body);
  calls.push(msg);
  if (msg.code === 'no-compile') {
    return { ok: true, json: async () => ({ status: 'Compilation Error', stderr: 'SyntaxError: bad', details: [] }) };
  }
  const details = msg.tests.map((t, i) => {
    const r = fakeRun(msg.code, Number(String(t.inputs[0]).trim()));
    if (r.tle) return { test: i + 1, passed: false, errorType: 'timeout', error: 'Time Limit Exceeded' };
    const hasExpected = t.expected !== null && t.expected !== undefined;
    const passed = hasExpected ? r.output === t.expected : true;
    return { test: i + 1, passed, output: r.output, expected: t.expected, ...(passed ? {} : { errorType: 'wrong_answer' }) };
  });
  return { ok: true, json: async () => ({ status: details.every((d) => d.passed) ? 'Accepted' : 'Wrong Answer', details }) };
}

describe('second solution cross-check (P11)', () => {
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

  const draft = (reference, alternate, extra = {}) => ({
    title: 'Double', description: 'Print twice the number', difficulty: 'Easy', problemType: 'stdin',
    referenceSolution: reference, solutionLanguage: 'python',
    alternateSolution: alternate, alternateSolutionLanguage: alternate ? 'cpp' : '',
    testCases: [
      { inputs: ['3\n'], expected: '6\n', isSample: true },
      { inputs: ['100\n'], expected: '200\n' }
    ],
    ...extra
  });
  const save = (body) => request(app).post('/api/problems').set('Authorization', `Bearer ${adminToken}`).send(body);

  it('saves when both solutions agree, and runs the second one in its own language with more time', async () => {
    const res = await save(draft('double', 'brute', { timeLimitMs: 1000 }));
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ code: 'brute', language: 'cpp', timeLimitMs: 3000 });
    // The second solution is checked against what the reference produced.
    expect(calls[1].tests.map((t) => t.expected)).toEqual(['6\n', '200\n']);
  });

  it('refuses to save where they disagree, naming the test and both outputs', async () => {
    // The author's expected outputs came from the wrong reference solution, so they agree with
    // it: only the second solution can catch this.
    const body = draft('wrong-on-big', 'brute');
    body.testCases[1].expected = '201\n';
    const res = await save(body);
    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toMatch(/Test case 2 \(hidden\): the reference solution gives "201\\n" but the second solution gives "200\\n"/);
  });

  it('a second solution that runs out of time on a big test is a warning, not a disagreement', async () => {
    const res = await save(draft('double', 'slow'));
    expect(res.status).toBe(201);
  });

  it('refuses a second solution that does not compile', async () => {
    const res = await save(draft('double', 'no-compile'));
    expect(res.status).toBe(400);
    // Once, not once per test.
    expect(res.body.errors).toEqual([expect.stringMatching(/^The second solution does not compile:\nSyntaxError: bad/)]);
  });

  it('needs a language with a second solution', async () => {
    const res = await save({ ...draft('double', 'brute'), alternateSolutionLanguage: '' });
    expect(res.status).toBe(400);
    expect(res.body.errors.join(' ')).toMatch(/alternateSolutionLanguage is required/);
  });

  it('without one, nothing extra runs', async () => {
    const res = await save(draft('double', ''));
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
  });

  it('generating expected outputs reports, per test, whether the second solution agrees', async () => {
    const res = await request(app)
      .post('/api/problems/reference-outputs')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(draft('wrong-on-big', 'slow', { testCases: [{ inputs: ['3\n'], isSample: true }, { inputs: ['100\n'] }, { inputs: ['5\n'] }] }));
    expect(res.status).toBe(200);
    expect(res.body.tests.map((t) => t.output)).toEqual(['6\n', '201\n', '10\n']);
    expect(res.body.alternate).toMatchObject([
      { agrees: true, skipped: false },
      { agrees: null, skipped: true },
      { agrees: true, skipped: false }
    ]);
  });

  it('is stored for staff, never shown to students, and can be removed by an edit', async () => {
    const created = await save(draft('double', 'brute'));
    const id = created.body.problem._id;

    const asStudent = await request(app).get(`/api/problems/${id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(asStudent.body.alternateSolution).toBeUndefined();
    expect(asStudent.body.alternateSolutionLanguage).toBeUndefined();

    const asAdmin = await request(app).get(`/api/problems/${id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(asAdmin.body).toMatchObject({ alternateSolution: 'brute', alternateSolutionLanguage: 'cpp' });

    const edited = await request(app).put(`/api/problems/${id}`).set('Authorization', `Bearer ${adminToken}`)
      .send({ ...draft('double', ''), alternateSolution: '   ' });
    expect(edited.status).toBe(200);
    const after = await request(app).get(`/api/problems/${id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(after.body.alternateSolution || '').toBe('');
  });
});
