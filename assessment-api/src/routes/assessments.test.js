import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import Problem from '../../models/Problem.mjs';
import Assessment from '../../models/Assessment.mjs';
import * as authService from '../services/auth.service.js';

describe('Assessments API', () => {
  let adminToken;
  let adminId;
  let studentToken;
  let problemId;

  beforeEach(async () => {
    // Create admin user
    const admin = await authService.register({
      name: 'Admin User',
      email: `admin-${Date.now()}@test.com`,
      password: 'password123',
      role: 'admin'
    });
    adminToken = admin.token;
    adminId = admin.user.id;

    // Create student user
    const student = await authService.register({
      name: 'Student User',
      email: `student-${Date.now()}@test.com`,
      password: 'password123',
      role: 'student'
    });
    studentToken = student.token;

    // Seed a problem
    const problem = await Problem.create({
      title: 'Test Problem',
      description: 'Test Description',
      difficulty: 'Easy',
      functionName: 'solve',
      parameters: [{ name: 'n', type: 'number' }],
      returnType: 'number',
      testCases: [{ inputs: [1], expected: 1, isSample: true }],
      referenceSolution: 'function solve(n) { return n; }',
      solutionLanguage: 'javascript'
    });
    problemId = problem._id;

    // Seed an assessment
    await Assessment.create({
      title: 'Standard Assessment',
      description: 'Description',
      problems: [{ problemId: problemId, maxScore: 100 }],
      durationMinutes: 60,
      startTime: new Date(),
      endTime: new Date(Date.now() + 86400000),
      createdBy: adminId,
      status: 'Published'
    });
  });

  it('GET /api/assessments should return list of assessments for authenticated user', async () => {
    const res = await request(app)
      .get('/api/assessments')
      .set('Authorization', `Bearer ${studentToken}`);
    
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
  });

  it('GET /api/assessments/:id/my-attempt should return null before starting and the attempt after starting', async () => {
    const listRes = await request(app)
      .get('/api/assessments')
      .set('Authorization', `Bearer ${studentToken}`);
    const assessmentId = listRes.body[0]._id;

    const beforeRes = await request(app)
      .get(`/api/assessments/${assessmentId}/my-attempt`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(beforeRes.status).toBe(200);
    expect(beforeRes.body).toBeNull();

    const startRes = await request(app)
      .post(`/api/assessments/${assessmentId}/start`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(startRes.status).toBe(200);

    const afterRes = await request(app)
      .get(`/api/assessments/${assessmentId}/my-attempt`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(afterRes.status).toBe(200);
    expect(afterRes.body._id).toBe(startRes.body._id);
  });

  it('POST /api/assessments should create an assessment for admin', async () => {
    const newAssessment = {
      title: 'New Assessment',
      description: 'New Description',
      problems: [{ problemId: problemId.toString(), maxScore: 100 }],
      durationMinutes: 30,
      startTime: new Date(),
      endTime: new Date(Date.now() + 86400000),
      status: 'Published'
    };

    const res = await request(app)
      .post('/api/assessments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(newAssessment);
    
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('New Assessment');
  });

  it('POST /api/assessments/:id/start should start an assessment for student', async () => {
    const listRes = await request(app)
      .get('/api/assessments')
      .set('Authorization', `Bearer ${studentToken}`);
    const assessmentId = listRes.body[0]._id;

    const res = await request(app)
      .post(`/api/assessments/${assessmentId}/start`)
      .set('Authorization', `Bearer ${studentToken}`);
    
    expect(res.status).toBe(200);
    expect(res.body.assessmentId).toBe(assessmentId);
  });

  it('POST /api/assessments should reject invalid scoring and duplicate problems', async () => {
    const res = await request(app)
      .post('/api/assessments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Invalid Assessment',
        problems: [
          { problemId: problemId.toString(), maxScore: 0 },
          { problemId: problemId.toString(), maxScore: 100 }
        ],
        durationMinutes: 0,
        startTime: new Date(),
        endTime: new Date(Date.now() + 86400000),
        status: 'Draft'
      });

    expect(res.status).toBe(400);
    expect(res.body.errors).toContain('Duration must be greater than zero');
    expect(res.body.errors).toContain('An assessment cannot contain duplicate problems');
    expect(res.body.errors).toContain('Every problem max score must be greater than zero');
  });

  it('POST /api/assessments/:id/announcements should allow admin to post announcements and GET should return them', async () => {
    const listRes = await request(app)
      .get('/api/assessments')
      .set('Authorization', `Bearer ${studentToken}`);
    const assessmentId = listRes.body[0]._id;

    const announceRes = await request(app)
      .post(`/api/assessments/${assessmentId}/announcements`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ message: 'Typo in question 1 has been fixed.' });

    expect(announceRes.status).toBe(201);
    expect(announceRes.body.message).toBe('Typo in question 1 has been fixed.');

    const getRes = await request(app)
      .get(`/api/assessments/${assessmentId}/announcements`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body)).toBe(true);
    expect(getRes.body.length).toBe(1);
    expect(getRes.body[0].message).toBe('Typo in question 1 has been fixed.');
  });

  it('GET /api/assessments/:id/analytics should allow admin to fetch analytics and reject student', async () => {
    const listRes = await request(app)
      .get('/api/assessments')
      .set('Authorization', `Bearer ${studentToken}`);
    const assessmentId = listRes.body[0]._id;

    // Student should be rejected (403)
    const studentRes = await request(app)
      .get(`/api/assessments/${assessmentId}/analytics`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(studentRes.status).toBe(403);

    // Admin should be allowed (200)
    const adminRes = await request(app)
      .get(`/api/assessments/${assessmentId}/analytics`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body).toHaveProperty('overallStats');
    expect(adminRes.body).toHaveProperty('sectionReports');
    expect(adminRes.body).toHaveProperty('questionReports');
    expect(adminRes.body.overallStats.totalStudents).toBeGreaterThanOrEqual(0);
  });

  it('should support Assessment Lock/Unlock, Grace Time, and Draft Sync operations', async () => {
    // 1. Get assessment ID
    const listRes = await request(app)
      .get('/api/assessments')
      .set('Authorization', `Bearer ${studentToken}`);
    const assessmentId = listRes.body[0]._id;

    // 2. Lock Assessment (Admin)
    const lockRes = await request(app)
      .post(`/api/assessments/${assessmentId}/lock`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(lockRes.status).toBe(200);

    // Verify it is locked in database
    const getRes = await request(app)
      .get(`/api/assessments/${assessmentId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(getRes.body.locked).toBe(true);

    // Verify student cannot start a locked assessment
    const startRes = await request(app)
      .post(`/api/assessments/${assessmentId}/start`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(startRes.status).toBe(409);

    // 3. Unlock Assessment (Admin)
    const unlockRes = await request(app)
      .post(`/api/assessments/${assessmentId}/unlock`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(unlockRes.status).toBe(200);

    // Start attempt now that it is unlocked
    const startOkRes = await request(app)
      .post(`/api/assessments/${assessmentId}/start`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(startOkRes.status).toBe(200);
    const attemptId = startOkRes.body._id;

    // 4. Save Draft
    const codeDrafts = { codeMap: { [problemId]: 'console.log("hello");' }, langMap: { [problemId]: 'javascript' } };
    const draftRes = await request(app)
      .post(`/api/assessments/attempts/${attemptId}/draft`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ codeDrafts });
    expect(draftRes.status).toBe(200);

    // Verify draft is populated in the database
    const attemptDetail = await request(app)
      .get(`/api/assessments/attempts/${attemptId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(attemptDetail.body.codeDrafts).toEqual(codeDrafts);

    // 5. Add Grace Time
    const graceRes = await request(app)
      .post(`/api/assessments/attempts/${attemptId}/grace`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ graceMinutes: 10 });
    expect(graceRes.status).toBe(200);
    expect(graceRes.body.graceMinutes).toBe(10);
  });

  it('should handle Challenge / Appeal workflow endpoints correctly', async () => {
    // 1. Get assessment ID and start a new attempt (by another student or using clean database state)
    const listRes = await request(app)
      .get('/api/assessments')
      .set('Authorization', `Bearer ${studentToken}`);
    const assessmentId = listRes.body[0]._id;

    // Start attempt for student
    const startRes = await request(app)
      .post(`/api/assessments/${assessmentId}/start`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(startRes.status).toBe(200);
    const attemptId = startRes.body._id;

    // 2. Student cannot raise challenge while attempt is Active
    const activeChallengeRes = await request(app)
      .post(`/api/assessments/attempts/${attemptId}/challenge`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reason: 'Failed testcases explanation' });
    expect(activeChallengeRes.status).toBe(400);

    // 3. Student submits assessment
    const submitRes = await request(app)
      .post(`/api/assessments/attempts/${attemptId}/submit`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.status).toBe('Submitted');

    // 4. Student raises challenge
    const raiseRes = await request(app)
      .post(`/api/assessments/attempts/${attemptId}/challenge`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reason: 'I believe my solution is correct.' });
    expect(raiseRes.status).toBe(200);
    expect(raiseRes.body.challenge.status).toBe('Raised');
    expect(raiseRes.body.challenge.reason).toBe('I believe my solution is correct.');

    // 5. Student cannot raise challenge again
    const doubleRaiseRes = await request(app)
      .post(`/api/assessments/attempts/${attemptId}/challenge`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reason: 'Another reason.' });
    expect(doubleRaiseRes.status).toBe(409);

    // 6. Student cannot resolve challenge
    const studentResolveRes = await request(app)
      .post(`/api/assessments/attempts/${attemptId}/challenge/resolve`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ status: 'Accepted', facultyComment: 'Approved' });
    expect(studentResolveRes.status).toBe(403);

    // 7. Admin resolves challenge with Acceptance
    const resolveRes = await request(app)
      .post(`/api/assessments/attempts/${attemptId}/challenge/resolve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'Accepted', facultyComment: 'Agreed. Full marks awarded.' });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.challenge.status).toBe('Accepted');
    expect(resolveRes.body.challenge.facultyComment).toBe('Agreed. Full marks awarded.');
  });

  it('GET /api/assessments/attempts/:attemptId/submissions should include problemType and options for mcq submissions', async () => {
    const mcqProblem = await Problem.create({
      title: 'Capital of France',
      description: 'Pick the capital of France',
      difficulty: 'Easy',
      problemType: 'mcq',
      options: [
        { text: 'Paris', isCorrect: true },
        { text: 'London', isCorrect: false }
      ]
    });

    const mcqAssessment = await Assessment.create({
      title: 'MCQ Assessment',
      description: 'Description',
      problems: [{ problemId: mcqProblem._id, maxScore: 100 }],
      durationMinutes: 60,
      startTime: new Date(),
      endTime: new Date(Date.now() + 86400000),
      createdBy: adminId,
      status: 'Published'
    });

    const startRes = await request(app)
      .post(`/api/assessments/${mcqAssessment._id}/start`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(startRes.status).toBe(200);
    const attemptId = startRes.body._id;

    const submitRes = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ problemId: mcqProblem._id.toString(), selectedOptions: [0], assessmentId: mcqAssessment._id.toString(), attemptId });
    expect(submitRes.status).toBe(202);

    const listRes = await request(app)
      .get(`/api/assessments/attempts/${attemptId}/submissions`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBe(1);
    expect(listRes.body[0].problemId.problemType).toBe('mcq');
    expect(listRes.body[0].problemId.options).toEqual([
      { text: 'Paris', isCorrect: true },
      { text: 'London', isCorrect: false }
    ]);
    expect(listRes.body[0].selectedOptions).toEqual([0]);
  });
});
