import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import College from '../../models/College.mjs';
import Problem from '../../models/Problem.mjs';
import Assessment from '../../models/Assessment.mjs';
import * as authService from '../services/auth.service.js';

// Public and private problems (problemAccess.js): public ones every college sees, uses and
// edits, private ones only the college that added them. Only the owning college deletes, and
// never while an assessment uses the problem.
describe('Problem visibility', () => {
  let a, b, facultyA, facultyB, adminA, adminB, studentA, studentB, superadmin;
  let n = 0;
  const user = (role, collegeId) => authService.register({
    name: `${role}${++n}`, email: `vis-${role}-${n}-${Date.now()}@t.com`, password: 'password123', role, collegeId
  });
  const as = (u) => ({ Authorization: `Bearer ${u.token}` });

  // mcq needs no judge, so these run without one.
  const mcq = (title, visibility) => ({
    title, description: 'Pick one', difficulty: 'Easy', problemType: 'mcq',
    options: [{ text: 'yes', isCorrect: true }, { text: 'no', isCorrect: false }],
    ...(visibility ? { visibility } : {})
  });
  const create = async (u, body) => {
    const res = await request(app).post('/api/v1/problems').set(as(u)).send(body);
    expect(res.status).toBe(201);
    return res.body.problem;
  };
  const titles = async (u) => {
    const req = request(app).get('/api/v1/problems?limit=100');
    const res = u ? await req.set(as(u)) : await req;
    return res.body.map((p) => p.title);
  };

  beforeEach(async () => {
    a = await College.create({ name: 'A', slug: `a${Date.now()}` });
    b = await College.create({ name: 'B', slug: `b${Date.now()}` });
    facultyA = await user('faculty', a._id);
    facultyB = await user('faculty', b._id);
    adminA = await user('admin', a._id);
    adminB = await user('admin', b._id);
    studentA = await user('student', a._id);
    studentB = await user('student', b._id);
    superadmin = await user('superadmin');
  });

  it('records the owning college from the account, not the request', async () => {
    // The request schema refuses an owner outright...
    const forged = await request(app).post('/api/v1/problems').set(as(facultyA)).send({ ...mcq('Forged'), collegeId: String(b._id) });
    expect(forged.status).toBe(400);
    // ...and the owner is the author's college.
    const p = await create(facultyA, mcq('Owned'));
    expect(String(p.collegeId)).toBe(String(a._id));
    expect(p.visibility).toBe('public');
  });

  it('a private problem is invisible to other colleges and anonymous users', async () => {
    const p = await create(facultyA, mcq('Secret', 'private'));
    await create(facultyA, mcq('Open'));

    expect(await titles(studentA)).toEqual(expect.arrayContaining(['Secret', 'Open']));
    expect(await titles(studentB)).not.toContain('Secret');
    expect(await titles(facultyB)).not.toContain('Secret');
    expect(await titles(null)).not.toContain('Secret');
    expect(await titles(superadmin)).toContain('Secret');

    expect((await request(app).get(`/api/v1/problems/${p._id}`).set(as(studentB))).status).toBe(404);
    expect((await request(app).get(`/api/v1/problems/${p._id}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/problems/${p._id}/stats`).set(as(studentB))).status).toBe(404);
    expect((await request(app).get(`/api/v1/problems/${p._id}`).set(as(studentA))).status).toBe(200);

    const submit = await request(app).post('/api/v1/submissions').set(as(studentB))
      .send({ problemId: p._id, selectedOptions: [0] });
    expect(submit.status).toBe(404);
  });

  it('the Public / Private filter', async () => {
    await create(facultyA, mcq('Mine', 'private'));
    await create(facultyA, mcq('Shared'));
    const only = async (v) => (await request(app).get(`/api/v1/problems?visibility=${v}`).set(as(facultyA))).body.map((p) => p.title);
    expect(await only('private')).toEqual(['Mine']);
    expect(await only('public')).toEqual(['Shared']);
  });

  it('a public problem can be edited by another college', async () => {
    const p = await create(facultyA, mcq('Shared'));
    const res = await request(app).put(`/api/v1/problems/${p._id}`).set(as(facultyB)).send(mcq('Shared, improved'));
    expect(res.status).toBe(200);
    expect(res.body.problem.title).toBe('Shared, improved');
    expect(String(res.body.problem.collegeId)).toBe(String(a._id)); // still A's
  });

  it('a private problem cannot be edited by another college', async () => {
    const p = await create(facultyA, mcq('Secret', 'private'));
    const res = await request(app).put(`/api/v1/problems/${p._id}`).set(as(facultyB)).send(mcq('Hijacked'));
    expect(res.status).toBe(404);
    expect((await request(app).put(`/api/v1/problems/${p._id}`).set(as(facultyA)).send(mcq('Secret v2', 'private'))).status).toBe(200);
  });

  it('only the owning college changes public/private', async () => {
    const p = await create(facultyA, mcq('Shared'));
    const byB = await request(app).put(`/api/v1/problems/${p._id}`).set(as(facultyB)).send(mcq('Shared', 'private'));
    expect(byB.status).toBe(403);
    const byA = await request(app).put(`/api/v1/problems/${p._id}`).set(as(facultyA)).send(mcq('Shared', 'private'));
    expect(byA.status).toBe(200);
    expect(byA.body.problem.visibility).toBe('private');
  });

  it('a problem another college\'s assessment uses cannot be made private', async () => {
    const p = await create(facultyA, mcq('Shared'));
    await Assessment.create({
      title: 'B exam', collegeId: b._id, createdBy: facultyB.user.id, durationMinutes: 30,
      startTime: new Date(), endTime: new Date(Date.now() + 3600e3), problems: [{ problemId: p._id }]
    });
    const res = await request(app).put(`/api/v1/problems/${p._id}`).set(as(facultyA)).send(mcq('Shared', 'private'));
    expect(res.status).toBe(409);
  });

  it('only the owning college deletes, and not while an assessment uses it', async () => {
    const p = await create(adminA, mcq('Shared'));
    expect((await request(app).delete(`/api/v1/problems/${p._id}`).set(as(adminB))).status).toBe(403);

    const exam = await Assessment.create({
      title: 'A exam', collegeId: a._id, createdBy: adminA.user.id, durationMinutes: 30,
      startTime: new Date(), endTime: new Date(Date.now() + 3600e3), problems: [{ problemId: p._id }]
    });
    expect((await request(app).delete(`/api/v1/problems/${p._id}`).set(as(adminA))).status).toBe(409);

    await Assessment.deleteOne({ _id: exam._id });
    expect((await request(app).delete(`/api/v1/problems/${p._id}`).set(as(adminA))).status).toBe(200);
  });

  it('a problem no college owns is deleted only by a superadmin', async () => {
    const legacy = await Problem.create(mcq('Legacy'));
    expect((await request(app).delete(`/api/v1/problems/${legacy._id}`).set(as(adminA))).status).toBe(403);
    expect((await request(app).delete(`/api/v1/problems/${legacy._id}`).set(as(superadmin))).status).toBe(200);
  });

  it('nobody else edits a problem while another college\'s exam using it is running', async () => {
    const p = await create(facultyA, mcq('Shared'));
    const exam = await Assessment.create({
      title: 'B exam', collegeId: b._id, createdBy: facultyB.user.id, durationMinutes: 30, status: 'Published',
      startTime: new Date(Date.now() - 60e3), endTime: new Date(Date.now() + 3600e3), problems: [{ problemId: p._id }]
    });
    const edit = (u) => request(app).put(`/api/v1/problems/${p._id}`).set(as(u)).send(mcq('Shared v2'));

    expect((await edit(facultyA)).status).toBe(409); // even the owner
    expect((await edit(facultyB)).status).toBe(200); // the college running the exam may fix it
    expect((await edit(superadmin)).status).toBe(200);

    // Once it has ended, anyone may edit again.
    await Assessment.updateOne({ _id: exam._id }, { endTime: new Date(Date.now() - 1000), startTime: new Date(Date.now() - 7200e3) });
    expect((await edit(facultyA)).status).toBe(200);
  });

  it('refuses code over 64 KB with a clear message', async () => {
    const p = await create(facultyA, mcq('Shared'));
    const big = 'x'.repeat(64 * 1024 + 1);
    const run = await request(app).post(`/api/v1/problems/${p._id}/run`).set(as(studentA)).send({ code: big, language: 'python' });
    expect(run.status).toBe(413);
    expect(run.body.msg).toContain('64 KB');
  });

  it('an assessment cannot use another college\'s private problem', async () => {
    const p = await create(facultyA, mcq('Secret', 'private'));
    const body = {
      title: 'Exam', durationMinutes: 30,
      startTime: new Date(Date.now() + 3600e3).toISOString(), endTime: new Date(Date.now() + 7200e3).toISOString(),
      problems: [{ problemId: p._id }]
    };
    expect((await request(app).post('/api/v1/assessments').set(as(facultyB)).send(body)).status).toBe(400);
    expect((await request(app).post('/api/v1/assessments').set(as(facultyA)).send(body)).status).toBe(201);
  });
});
