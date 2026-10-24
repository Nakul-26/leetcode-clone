import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import amqp from 'amqplib';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import { env } from '../config/env.js';
import Problem from '../../models/Problem.mjs';
import Submission from '../../models/Submission.mjs';
import User from '../../models/User.mjs';
import { sanitizeResultDetails } from '../services/submissions.service.js';

// JUDGE_FIX_PLAN T1: a student's graded submit asks the judge to stop at the first failed
// test; anything else (the /integration API used by partners, which may score partial passes)
// still runs every test.

// The shared amqplib mock hands every caller the same channel; its sendToQueue records publishes.
async function lastPublished() {
  const conn = await amqp.connect();
  const ch = await conn.createConfirmChannel();
  const calls = ch.sendToQueue.mock.calls;
  return JSON.parse(calls[calls.length - 1][1].toString());
}

describe('stop at first failure (T1)', () => {
  let token;
  let problemId;

  beforeEach(async () => {
    const user = await User.create({ name: 'S', email: `s-${Date.now()}@t.com`, password: 'x', role: 'student' });
    token = jwt.sign({ _id: user._id.toString(), id: user._id.toString(), role: 'student', email: user.email, name: 'S' }, env.JWT_SECRET, { expiresIn: '1h' });
    const problem = await Problem.create({
      title: 'Echo', description: 'd', difficulty: 'Easy', problemType: 'stdin',
      testCases: [{ inputs: ['1\n'], expected: '1\n' }, { inputs: ['2\n'], expected: '2\n' }]
    });
    problemId = problem._id.toString();
  });

  it('a student submit sets the flag on the message and the row', async () => {
    const res = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${token}`)
      .send({ problemId, language: 'python', code: 'print(input())' });
    expect(res.status).toBe(202);
    expect((await lastPublished()).stopOnFirstFailure).toBe(true);
    expect((await Submission.findById(res.body._id).lean()).stopOnFirstFailure).toBe(true);
  });

  it('an /integration submit runs every test', async () => {
    const res = await request(app)
      .post('/api/integration/submissions')
      .set('x-service-key', env.TESTING_PLATFORM_KEY || 'testing_platform_secret')
      .set('Authorization', `Bearer ${token}`)
      .send({ problemId, language: 'python', code: 'print(input())' });
    expect(res.status).toBe(202);
    expect((await lastPublished()).stopOnFirstFailure).toBeUndefined();
    expect((await Submission.findById(res.body._id).lean()).stopOnFirstFailure).toBeUndefined();
  });

  it('a hidden not-run test is reported as not run, not as a plain failure', () => {
    const [detail] = sanitizeResultDetails(
      [{ test: 1, passed: false, error: 'Not Run', errorType: 'not_run', expected: 'secret' }],
      [{ inputs: ['x'], expected: 'secret', isHidden: true }],
      true
    );
    expect(detail).toMatchObject({ isHidden: true, passed: false, errorType: 'not_run' });
    expect(detail.expected).toBeUndefined();
  });
});
