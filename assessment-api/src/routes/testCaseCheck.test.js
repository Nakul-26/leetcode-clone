import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { env } from '../config/env.js';

// JUDGE_FIX_PLAN P12: /codeAssess/test-cases/{generate,check} for a platform that keeps its own
// reference solutions. A fake judge /run: source "double" prints 2n, "off-by-one" prints 2n+1,
// "crash" fails, "badsyntax" does not compile.
const calls = [];
function fakeJudge(_url, init = {}) {
  const msg = JSON.parse(init.body);
  calls.push(msg);
  if (msg.code === 'badsyntax') {
    return { ok: true, json: async () => ({ status: 'Compilation Error', stderr: 'SyntaxError: invalid syntax', details: [] }) };
  }
  const details = msg.tests.map((t, i) => {
    if (msg.code === 'crash') return { test: i + 1, passed: false, errorType: 'runtime', error: 'Runtime Error', stderr: 'ZeroDivisionError' };
    const n = Number(String(t.inputs[0]).trim());
    const v = msg.code === 'off-by-one' ? 2 * n + 1 : 2 * n;
    return { test: i + 1, passed: true, output: `${v}\n`, timeMs: 12 };
  });
  return { ok: true, json: async () => ({ status: 'Accepted', details }) };
}

const key = env.CODEASSESS_SHIM_KEY || 'codeassess_shim_secret';
const b64 = (s) => Buffer.from(s).toString('base64');
const unb64 = (s) => (s == null ? s : Buffer.from(s, 'base64').toString('utf8'));
const post = (path, body, query = '') => request(app).post(`/api/codeAssess/test-cases/${path}${query}`).set('x-rapidapi-key', key).send(body);

describe('/codeAssess/test-cases (P12)', () => {
  const savedFetch = global.fetch;
  beforeEach(() => {
    calls.length = 0;
    global.fetch = (url, init) => Promise.resolve(fakeJudge(url, init));
  });
  afterEach(() => {
    global.fetch = savedFetch;
  });

  it('generate returns the reference output for each input (base64 by default)', async () => {
    const res = await post('generate', {
      language_id: 71, source_code: b64('double'),
      test_cases: [{ stdin: b64('3\n') }, { stdin: b64('10\n'), expected_output: b64('ignored') }]
    });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => unb64(r.actual_output))).toEqual(['6\n', '20\n']);
    expect(res.body.results.every((r) => r.match === null)).toBe(true);
    expect(res.body.summary).toMatchObject({ total: 2, generated: 2 });
    expect(calls[0]).toMatchObject({ language: 'python', problemType: 'stdin', problemId: 'temp' });
  });

  it('check says which expected outputs are wrong, ignoring trailing whitespace like the judge', async () => {
    const res = await post('check', {
      language_id: 71, source_code: 'double',
      test_cases: [
        { stdin: '3\n', expected_output: '6' },        // missing trailing newline: still correct
        { stdin: '5\n', expected_output: '11\n' },     // wrong
        { stdin: '7\n' }                               // no expected: generated
      ]
    }, '?base64_encoded=false');
    expect(res.status).toBe(200);
    expect(res.body.results.map((r) => r.match)).toEqual([true, false, null]);
    expect(res.body.results[0].exact_match).toBe(false);
    expect(res.body.results[1]).toMatchObject({ actual_output: '10\n', expected_output: '11\n' });
    expect(res.body.summary).toEqual({ total: 3, matched: 1, mismatched: 1, generated: 1, failed: 0 });
    expect(res.body.all_match).toBe(false);
  });

  it('all_match is true only when every case has a correct expected output', async () => {
    const res = await post('check', {
      language_id: 71, source_code: 'double', test_cases: [{ stdin: '1\n', expected_output: '2\n' }, { stdin: '2\n', expected_output: '4\n' }]
    }, '?base64_encoded=false');
    expect(res.body.all_match).toBe(true);
  });

  it('reports a reference solution that crashes on an input', async () => {
    const res = await post('check', { language_id: 71, source_code: 'crash', test_cases: [{ stdin: '1\n', expected_output: '2\n' }] }, '?base64_encoded=false');
    expect(res.body.results[0]).toMatchObject({ match: false, actual_output: null, status: { id: 11 } });
    expect(res.body.results[0].stderr).toMatch(/ZeroDivisionError/);
    expect(res.body.summary.failed).toBe(1);
  });

  it('reports a reference solution that does not compile', async () => {
    const res = await post('generate', { language_id: 71, source_code: 'badsyntax', test_cases: [{ stdin: '1\n' }] }, '?base64_encoded=false');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ compile_error: true, status: { id: 6 }, results: [] });
    expect(res.body.compile_output).toMatch(/SyntaxError/);
  });

  it('passes the time and memory limits to the judge', async () => {
    await post('generate', { language_id: 54, source_code: 'double', test_cases: [{ stdin: '1\n' }], cpu_time_limit: 2, memory_limit: 262144 }, '?base64_encoded=false');
    expect(calls[0]).toMatchObject({ language: 'cpp', timeLimitMs: 2000, memoryLimitMb: 256 });
  });

  it('rejects bad requests', async () => {
    expect((await post('check', { language_id: 999, source_code: 'x', test_cases: [{ stdin: '' }] }, '?base64_encoded=false')).status).toBe(400);
    expect((await post('check', { language_id: 71, source_code: 'x', test_cases: [] }, '?base64_encoded=false')).status).toBe(400);
    expect((await post('check', { language_id: 71, source_code: 'x', test_cases: Array(101).fill({ stdin: '' }) }, '?base64_encoded=false')).status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('requires the API key', async () => {
    const res = await request(app).post('/api/codeAssess/test-cases/check').send({ language_id: 71, source_code: 'x', test_cases: [{ stdin: '' }] });
    expect(res.status).toBe(401);
  });
});
