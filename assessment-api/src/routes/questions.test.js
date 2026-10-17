import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import College from '../../models/College.mjs';
import Question from '../../models/Question.mjs';
import * as authService from '../services/auth.service.js';

describe('Questions API — tenant scoping', () => {
  let collegeA, collegeB;
  let adminAToken, facultyAToken, adminBToken, superadminToken;
  let facultyAId;
  let questionA; // private, authored by facultyA, collegeA
  let questionB; // private, authored by an outsider, collegeB

  beforeEach(async () => {
    collegeA = await College.create({ name: 'College A', slug: `college-a-q-${Date.now()}` });
    collegeB = await College.create({ name: 'College B', slug: `college-b-q-${Date.now()}` });

    const adminA = await authService.register({
      name: 'Admin A', email: `admin-a-q-${Date.now()}@test.com`, password: 'password123',
      role: 'admin', collegeId: collegeA._id.toString()
    });
    adminAToken = adminA.token;

    const facultyA = await authService.register({
      name: 'Faculty A', email: `faculty-a-q-${Date.now()}@test.com`, password: 'password123',
      role: 'faculty', collegeId: collegeA._id.toString()
    });
    facultyAToken = facultyA.token;
    facultyAId = facultyA.user.id;

    const adminB = await authService.register({
      name: 'Admin B', email: `admin-b-q-${Date.now()}@test.com`, password: 'password123',
      role: 'admin', collegeId: collegeB._id.toString()
    });
    adminBToken = adminB.token;

    const superadmin = await authService.register({
      name: 'Superadmin', email: `superadmin-q-${Date.now()}@test.com`, password: 'password123',
      role: 'superadmin'
    });
    superadminToken = superadmin.token;

    questionA = await Question.create({
      title: 'College A Private Question', collegeId: collegeA._id, author: facultyAId, visibility: 'Private'
    });
    questionB = await Question.create({
      title: 'College B Private Question', collegeId: collegeB._id, author: adminB.user.id, visibility: 'Private'
    });
  });

  it('listQuestions only returns the caller\'s own college for admin and faculty', async () => {
    const resAdminA = await request(app)
      .get('/api/questions')
      .set('Authorization', `Bearer ${adminAToken}`);
    expect(resAdminA.status).toBe(200);
    const idsA = resAdminA.body.questions.map((q) => q._id);
    expect(idsA).toContain(String(questionA._id));
    expect(idsA).not.toContain(String(questionB._id));

    const resFacultyA = await request(app)
      .get('/api/questions')
      .set('Authorization', `Bearer ${facultyAToken}`);
    const idsFacultyA = resFacultyA.body.questions.map((q) => q._id);
    expect(idsFacultyA).toContain(String(questionA._id));
    expect(idsFacultyA).not.toContain(String(questionB._id));
  });

  it('a query.collegeId param cannot be used by a scoped admin to escape their own college', async () => {
    const res = await request(app)
      .get(`/api/questions?collegeId=${collegeB._id}`)
      .set('Authorization', `Bearer ${adminAToken}`);
    const ids = res.body.questions.map((q) => q._id);
    expect(ids).not.toContain(String(questionB._id));
  });

  it('superadmin sees every college\'s questions', async () => {
    const res = await request(app)
      .get('/api/questions')
      .set('Authorization', `Bearer ${superadminToken}`);
    const ids = res.body.questions.map((q) => q._id);
    expect(ids).toContain(String(questionA._id));
    expect(ids).toContain(String(questionB._id));
  });

  it('getQuestionById 404s an admin from a different college, and succeeds for superadmin', async () => {
    const resAdminB = await request(app)
      .get(`/api/questions/${questionA._id}`)
      .set('Authorization', `Bearer ${adminBToken}`);
    expect(resAdminB.status).toBe(404);

    const resSuperadmin = await request(app)
      .get(`/api/questions/${questionA._id}`)
      .set('Authorization', `Bearer ${superadminToken}`);
    expect(resSuperadmin.status).toBe(200);
  });

  it('updateQuestion 403s an admin from a different college', async () => {
    const res = await request(app)
      .put(`/api/questions/${questionA._id}`)
      .set('Authorization', `Bearer ${adminBToken}`)
      .send({ title: 'Hijacked' });
    expect(res.status).toBe(403);

    const untouched = await Question.findById(questionA._id);
    expect(untouched.title).toBe('College A Private Question');
  });

  it('deleteQuestion 403s an admin from a different college, and succeeds for the owning college\'s admin', async () => {
    const resOutside = await request(app)
      .delete(`/api/questions/${questionA._id}`)
      .set('Authorization', `Bearer ${adminBToken}`);
    expect(resOutside.status).toBe(403);

    const resOwn = await request(app)
      .delete(`/api/questions/${questionA._id}`)
      .set('Authorization', `Bearer ${adminAToken}`);
    expect(resOwn.status).toBe(200);
    expect(await Question.findById(questionA._id)).toBeNull();
  });

  it('createQuestion ignores a collegeId injected in the payload for a non-superadmin', async () => {
    const res = await request(app)
      .post('/api/questions')
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ title: 'New Question', collegeId: collegeB._id.toString() });
    expect(res.status).toBe(201);
    expect(String(res.body.collegeId)).toBe(String(collegeA._id));
  });

  it('updateQuestion ignores a collegeId injected in the payload', async () => {
    const res = await request(app)
      .put(`/api/questions/${questionA._id}`)
      .set('Authorization', `Bearer ${adminAToken}`)
      .send({ title: 'Updated', collegeId: collegeB._id.toString() });
    expect(res.status).toBe(200);
    expect(String(res.body.collegeId)).toBe(String(collegeA._id));
  });
});
