import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import * as authService from '../services/auth.service.js';
import User from '../../models/User.mjs';
import Problem from '../../models/Problem.mjs';
import Assessment from '../../models/Assessment.mjs';
import Submission from '../../models/Submission.mjs';
import AuditLog from '../../models/AuditLog.mjs';
import College from '../../models/College.mjs';

describe('Admin Routes, Bulk Import, and Rejudge API', () => {
  let superadminToken;
  let superadminUser;

  beforeEach(async () => {
    // Clear user, problem, assessment, submission, audit log DBs
    await User.deleteMany({});
    await Problem.deleteMany({});
    await Assessment.deleteMany({});
    await Submission.deleteMany({});
    await AuditLog.deleteMany({});

    const superadmin = await authService.register({
      name: 'Super Admin',
      email: 'superadmin@test.com',
      password: 'password123',
      role: 'superadmin'
    });
    superadminToken = superadmin.token;
    superadminUser = superadmin.user;
  });

  it('POST /api/admin/bulk-import-students should successfully import valid students and generate passwords', async () => {
    const importPayload = {
      users: [
        { name: 'John Doe', email: 'john@college.edu', usn: '1BY23CS001', section: 'A' },
        { name: 'Jane Doe', email: 'jane@college.edu', usn: '1BY23CS002', section: 'A' }
      ],
      defaultPassword: 'TempPassword123'
    };

    const res = await request(app)
      .post('/api/admin/bulk-import-students')
      .set('Authorization', `Bearer ${superadminToken}`)
      .send(importPayload);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.created).toHaveLength(2);
    expect(res.body.errors).toHaveLength(0);

    // Verify cleartext password is returned
    expect(res.body.created[0].password).toBe('TempPassword123');
    expect(res.body.created[0].usn).toBe('1BY23CS001');
    expect(res.body.created[0].section).toBe('A');

    // Verify they are saved in MongoDB
    const storedUser = await User.findOne({ email: 'john@college.edu' });
    expect(storedUser).toBeDefined();
    expect(storedUser.name).toBe('John Doe');
    expect(storedUser.usn).toBe('1BY23CS001');
    expect(storedUser.section).toBe('A');
    expect(storedUser.role).toBe('student');
  });

  it('POST /api/admin/bulk-import-students should catch internal batch duplicates and DB duplicates', async () => {
    await authService.register({
      name: 'Existing Student',
      email: 'conflict@college.edu',
      password: 'password123',
      role: 'student',
      usn: '1BY23CS999'
    });

    const importPayload = {
      users: [
        { name: 'Student A', email: 'batch-dup@test.com', usn: 'USN001', section: 'A' },
        { name: 'Student B', email: 'batch-dup@test.com', usn: 'USN002', section: 'A' },
        { name: 'Student C', email: 'conflict@college.edu', usn: 'USN003', section: 'A' },
        { name: 'Student D', email: 'unique@college.edu', usn: '1BY23CS999', section: 'B' },
        { name: 'Valid Student', email: 'valid@college.edu', usn: 'USN004', section: 'B' }
      ],
      defaultPassword: 'TempPassword123'
    };

    const res = await request(app)
      .post('/api/admin/bulk-import-students')
      .set('Authorization', `Bearer ${superadminToken}`)
      .send(importPayload);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.errors).toHaveLength(3);

    const errors = res.body.errors;
    expect(errors.some(e => e.error.includes('Duplicate email in upload batch'))).toBe(true);
    expect(errors.some(e => e.error.includes('Email already registered in system'))).toBe(true);
    expect(errors.some(e => e.error.includes('USN already registered in system'))).toBe(true);
  });

  describe('Rejudge APIs', () => {
    let problem;
    let assessment;
    let submission;

    beforeEach(async () => {
      // Create problem
      problem = await Problem.create({
        title: 'Two Sum',
        description: 'Find two numbers that add up to target',
        difficulty: 'Easy',
        functionName: 'twoSum',
        parameters: [
          { name: 'nums', type: 'array<number>' },
          { name: 'target', type: 'number' }
        ],
        returnType: 'array<number>',
        testCases: [
          { inputs: [[2,7,11,15], 9], expected: [0,1], isSample: true, isHidden: false }
        ]
      });

      // Create assessment
      assessment = await Assessment.create({
        title: 'Midterm Coding Assessment',
        problems: [{ problemId: problem._id, maxScore: 50 }],
        durationMinutes: 60,
        startTime: new Date(),
        endTime: new Date(Date.now() + 2 * 3600 * 1000),
        createdBy: superadminUser.id
      });

      // Create submission
      submission = await Submission.create({
        problemId: problem._id,
        userId: superadminUser.id,
        assessmentId: assessment._id,
        code: 'def twoSum(nums, target): return [0, 1]',
        language: 'python',
        status: 'Success',
        score: 50,
        output: '{"status":"Accepted"}',
        testResult: { status: 'Accepted', passed: 1, total: 1 }
      });
    });

    it('POST /api/admin/rejudge/submission/:submissionId should successfully trigger a single submission rejudge', async () => {
      const res = await request(app)
        .post(`/api/admin/rejudge/submission/${submission._id}`)
        .set('Authorization', `Bearer ${superadminToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.msg).toContain('Rejudge scheduled successfully');

      // Verify DB submission status is reset to Pending
      const updatedSubmission = await Submission.findById(submission._id);
      expect(updatedSubmission.status).toBe('Pending');
      expect(updatedSubmission.score).toBe(0);
      expect(updatedSubmission.output).toBeUndefined();

      // Verify audit log creation
      const audit = await AuditLog.findOne({ event: 'REJUDGE_SUBMISSION' });
      expect(audit).toBeDefined();
      expect(audit.userId.toString()).toBe(superadminUser.id);
      expect(audit.details.submissionId.toString()).toBe(submission._id.toString());
    });

    it('POST /api/admin/rejudge/problem/:problemId should trigger rejudge for all problem submissions', async () => {
      const res = await request(app)
        .post(`/api/admin/rejudge/problem/${problem._id}`)
        .set('Authorization', `Bearer ${superadminToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);

      const updatedSubmission = await Submission.findById(submission._id);
      expect(updatedSubmission.status).toBe('Pending');

      const audit = await AuditLog.findOne({ event: 'REJUDGE_PROBLEM' });
      expect(audit).toBeDefined();
      expect(audit.details.problemId.toString()).toBe(problem._id.toString());
    });

    it('POST /api/admin/rejudge/assessment/:assessmentId should trigger rejudge for all assessment submissions', async () => {
      const res = await request(app)
        .post(`/api/admin/rejudge/assessment/${assessment._id}`)
        .set('Authorization', `Bearer ${superadminToken}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);

      const updatedSubmission = await Submission.findById(submission._id);
      expect(updatedSubmission.status).toBe('Pending');

      const audit = await AuditLog.findOne({ event: 'REJUDGE_ASSESSMENT' });
      expect(audit).toBeDefined();
      expect(audit.details.assessmentId.toString()).toBe(assessment._id.toString());
    });
  });

  describe('System Settings, Incident Banner, and Backup/Restore APIs', () => {
    it('POST /api/admin/banner should set the incident banner and GET /api/health/banner should retrieve it', async () => {
      // 1. Set banner
      const bannerPayload = {
        active: true,
        message: 'System upgrade in progress. Expect intermittent downtime.',
        type: 'warning'
      };

      const setRes = await request(app)
        .post('/api/admin/banner')
        .set('Authorization', `Bearer ${superadminToken}`)
        .send(bannerPayload);

      expect(setRes.status).toBe(200);
      expect(setRes.body.msg).toContain('Incident banner updated successfully');
      expect(setRes.body.banner.active).toBe(true);
      expect(setRes.body.banner.message).toBe(bannerPayload.message);
      expect(setRes.body.banner.type).toBe('warning');

      // 2. Get banner publicly (no token needed)
      const getRes = await request(app)
        .get('/api/health/banner');

      expect(getRes.status).toBe(200);
      expect(getRes.body.active).toBe(true);
      expect(getRes.body.message).toBe(bannerPayload.message);
      expect(getRes.body.type).toBe('warning');
    });

    it('GET /api/admin/backup and POST /api/admin/restore should backup and restore the database state', async () => {
      // Create a student in the DB so there is something to backup
      await User.create({
        name: 'Backup Student',
        email: 'backup_student@test.com',
        password: 'password123',
        role: 'student'
      });

      // 1. Fetch Backup
      const backupRes = await request(app)
        .get('/api/admin/backup')
        .set('Authorization', `Bearer ${superadminToken}`)
        .send();

      expect(backupRes.status).toBe(200);
      expect(backupRes.headers['content-type']).toContain('application/json');
      expect(backupRes.body.users).toBeDefined();
      expect(backupRes.body.users.length).toBeGreaterThan(0);

      const backupData = backupRes.body;

      // 2. Clear users DB manually to simulate data loss
      await User.deleteMany({});

      // 3. Restore Backup
      const restoreRes = await request(app)
        .post('/api/admin/restore')
        .set('Authorization', `Bearer ${superadminToken}`)
        .send(backupData);

      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.msg).toContain('Database restored successfully');
      expect(restoreRes.body.results.users).toBeDefined();

      // Verify backup student is restored
      const restoredStudent = await User.findOne({ email: 'backup_student@test.com' });
      expect(restoredStudent).toBeDefined();
      expect(restoredStudent.name).toBe('Backup Student');
    });
  });

  describe('Seat management — tenant-scoped user CRUD', () => {
    let collegeA;
    let collegeB;
    let adminAToken;
    let adminAUser;
    let studentA;
    let studentB;

    beforeEach(async () => {
      collegeA = await College.create({ name: 'College A', slug: `college-a-${Date.now()}` });
      collegeB = await College.create({ name: 'College B', slug: `college-b-${Date.now()}` });

      const adminA = await authService.register({
        name: 'Admin A', email: `admin-a-${Date.now()}@test.com`, password: 'password123',
        role: 'admin', collegeId: collegeA._id.toString()
      });
      adminAToken = adminA.token;
      adminAUser = adminA.user;

      const sA = await authService.register({
        name: 'Student A', email: `student-a-${Date.now()}@test.com`, password: 'password123',
        role: 'student', collegeId: collegeA._id.toString()
      });
      studentA = sA.user;

      const sB = await authService.register({
        name: 'Student B', email: `student-b-${Date.now()}@test.com`, password: 'password123',
        role: 'student', collegeId: collegeB._id.toString()
      });
      studentB = sB.user;
    });

    it('GET /api/admin/users should only return the caller college for a non-superadmin, and all colleges for a superadmin', async () => {
      const scopedRes = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminAToken}`);
      expect(scopedRes.status).toBe(200);
      const scopedEmails = scopedRes.body.users.map(u => u.email);
      expect(scopedEmails).toContain(studentA.email);
      expect(scopedEmails).not.toContain(studentB.email);

      const allRes = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${superadminToken}`);
      expect(allRes.status).toBe(200);
      const allEmails = allRes.body.users.map(u => u.email);
      expect(allEmails).toContain(studentA.email);
      expect(allEmails).toContain(studentB.email);
    });

    it('POST /api/admin/users/:userId/reset-password should 404 for a user outside the caller college', async () => {
      const res = await request(app)
        .post(`/api/admin/users/${studentB.id}/reset-password`)
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ newPassword: 'NewPass123' });
      expect(res.status).toBe(404);
    });

    it('POST /api/admin/users should create a user scoped to the caller college, ignoring a body-supplied collegeId', async () => {
      const res = await request(app)
        .post('/api/admin/users')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ name: 'New Faculty', email: `new-faculty-${Date.now()}@test.com`, role: 'faculty', collegeId: collegeB._id.toString() });

      expect(res.status).toBe(201);
      expect(res.body.password).toBeDefined();
      const stored = await User.findOne({ email: res.body.user.email });
      expect(String(stored.collegeId)).toBe(String(collegeA._id));
    });

    it('POST /api/admin/users should reject a non-superadmin trying to create a superadmin', async () => {
      const res = await request(app)
        .post('/api/admin/users')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ name: 'Sneaky', email: `sneaky-${Date.now()}@test.com`, role: 'superadmin' });
      expect(res.status).toBe(403);
    });

    it('DELETE /api/admin/users/:userId should remove a same-college user and 404 for a cross-college user', async () => {
      const crossRes = await request(app)
        .delete(`/api/admin/users/${studentB.id}`)
        .set('Authorization', `Bearer ${adminAToken}`);
      expect(crossRes.status).toBe(404);
      expect(await User.findById(studentB.id)).not.toBeNull();

      const sameRes = await request(app)
        .delete(`/api/admin/users/${studentA.id}`)
        .set('Authorization', `Bearer ${adminAToken}`);
      expect(sameRes.status).toBe(200);
      expect(await User.findById(studentA.id)).toBeNull();
    });

    it('DELETE /api/admin/users/:userId should reject deleting your own account', async () => {
      const res = await request(app)
        .delete(`/api/admin/users/${adminAUser.id}`)
        .set('Authorization', `Bearer ${adminAToken}`);
      expect(res.status).toBe(400);
    });

    it('POST /api/admin/bulk-import-students should force a non-superadmin caller into their own college regardless of a body-supplied collegeId', async () => {
      const res = await request(app)
        .post('/api/admin/bulk-import-students')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({
          users: [{ name: 'Injected Student', email: `injected-${Date.now()}@test.com` }],
          defaultPassword: 'TempPassword123',
          collegeId: collegeB._id.toString()
        });

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      const stored = await User.findOne({ email: res.body.created[0].email });
      expect(String(stored.collegeId)).toBe(String(collegeA._id));
    });
  });

  describe('Rejudge and audit-log tenant scoping', () => {
    let collegeA;
    let collegeB;
    let adminAToken;
    let adminBToken;
    let problem;
    let assessmentA;
    let submissionA;

    beforeEach(async () => {
      collegeA = await College.create({ name: 'College A', slug: `college-a-rj-${Date.now()}` });
      collegeB = await College.create({ name: 'College B', slug: `college-b-rj-${Date.now()}` });

      const adminA = await authService.register({
        name: 'Admin A', email: `admin-a-rj-${Date.now()}@test.com`, password: 'password123',
        role: 'admin', collegeId: collegeA._id.toString()
      });
      adminAToken = adminA.token;

      const adminB = await authService.register({
        name: 'Admin B', email: `admin-b-rj-${Date.now()}@test.com`, password: 'password123',
        role: 'admin', collegeId: collegeB._id.toString()
      });
      adminBToken = adminB.token;

      problem = await Problem.create({
        title: 'Two Sum', description: 'desc', difficulty: 'Easy',
        functionName: 'twoSum',
        parameters: [{ name: 'nums', type: 'array<number>' }, { name: 'target', type: 'number' }],
        returnType: 'array<number>',
        testCases: [{ inputs: [[2, 7, 11, 15], 9], expected: [0, 1], isSample: true }]
      });

      assessmentA = await Assessment.create({
        title: 'College B Assessment',
        problems: [{ problemId: problem._id, maxScore: 50 }],
        durationMinutes: 60,
        startTime: new Date(),
        endTime: new Date(Date.now() + 2 * 3600 * 1000),
        createdBy: superadminUser.id,
        collegeId: collegeB._id
      });

      submissionA = await Submission.create({
        problemId: problem._id,
        userId: superadminUser.id,
        assessmentId: assessmentA._id,
        collegeId: collegeB._id,
        code: 'def twoSum(nums, target): return [0, 1]',
        language: 'python',
        status: 'Success',
        score: 50
      });
    });

    it('rejudge endpoints should 404 for an admin outside the target college, and succeed for a superadmin', async () => {
      const subRes = await request(app)
        .post(`/api/admin/rejudge/submission/${submissionA._id}`)
        .set('Authorization', `Bearer ${adminAToken}`);
      expect(subRes.status).toBe(404);

      const probRes = await request(app)
        .post(`/api/admin/rejudge/problem/${problem._id}`)
        .set('Authorization', `Bearer ${adminAToken}`);
      expect(probRes.status).toBe(200);
      expect(probRes.body.count).toBe(0);

      const assessRes = await request(app)
        .post(`/api/admin/rejudge/assessment/${assessmentA._id}`)
        .set('Authorization', `Bearer ${adminAToken}`);
      expect(assessRes.status).toBe(404);

      const superRes = await request(app)
        .post(`/api/admin/rejudge/submission/${submissionA._id}`)
        .set('Authorization', `Bearer ${superadminToken}`);
      expect(superRes.status).toBe(200);
    });

    it('GET /api/admin/audit-logs should only return events scoped to the caller college, and everything for a superadmin', async () => {
      // Admin A performs an action within their own college — this is the audit event
      // we're testing visibility of.
      await request(app)
        .post('/api/admin/users')
        .set('Authorization', `Bearer ${adminAToken}`)
        .send({ name: 'Audit Target', email: `audit-target-${Date.now()}@test.com`, role: 'student' });

      const bEventsRes = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', `Bearer ${adminBToken}`);
      expect(bEventsRes.status).toBe(200);
      expect(bEventsRes.body.some(l => l.event === 'USER_CREATED')).toBe(false);

      const aEventsRes = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', `Bearer ${adminAToken}`);
      expect(aEventsRes.status).toBe(200);
      expect(aEventsRes.body.some(l => l.event === 'USER_CREATED')).toBe(true);

      const allRes = await request(app)
        .get('/api/admin/audit-logs')
        .set('Authorization', `Bearer ${superadminToken}`);
      expect(allRes.status).toBe(200);
      expect(allRes.body.some(l => l.event === 'USER_CREATED')).toBe(true);
    });
  });

  describe('system-stats tenant scoping', () => {
    let collegeA;
    let collegeB;
    let adminAToken;
    let problem;
    let submissionB;

    beforeEach(async () => {
      collegeA = await College.create({ name: 'College A', slug: `college-a-ss-${Date.now()}` });
      collegeB = await College.create({ name: 'College B', slug: `college-b-ss-${Date.now()}` });

      const adminA = await authService.register({
        name: 'Admin A', email: `admin-a-ss-${Date.now()}@test.com`, password: 'password123',
        role: 'admin', collegeId: collegeA._id.toString()
      });
      adminAToken = adminA.token;

      await authService.register({
        name: 'Admin B', email: `admin-b-ss-${Date.now()}@test.com`, password: 'password123',
        role: 'admin', collegeId: collegeB._id.toString()
      });

      problem = await Problem.create({
        title: 'Two Sum', description: 'desc', difficulty: 'Easy',
        functionName: 'twoSum',
        parameters: [{ name: 'nums', type: 'array<number>' }, { name: 'target', type: 'number' }],
        returnType: 'array<number>',
        testCases: [{ inputs: [[2, 7, 11, 15], 9], expected: [0, 1], isSample: true }]
      });

      submissionB = await Submission.create({
        problemId: problem._id,
        userId: superadminUser.id,
        collegeId: collegeB._id,
        code: 'def twoSum(nums, target): return [0, 1]',
        language: 'python',
        status: 'Success',
        score: 50
      });
    });

    it("an admin's metrics and recent-submissions feed exclude another college's data", async () => {
      const res = await request(app)
        .get('/api/admin/system-stats')
        .set('Authorization', `Bearer ${adminAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.metrics.totalSubmissions).toBe(0);
      expect(res.body.metrics.totalUsers).toBe(1); // just Admin A themselves
      expect(res.body.recentSubmissions.some(s => String(s._id) === String(submissionB._id))).toBe(false);
    });

    it("superadmin's metrics and recent-submissions feed include every college's data", async () => {
      const res = await request(app)
        .get('/api/admin/system-stats')
        .set('Authorization', `Bearer ${superadminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.metrics.totalSubmissions).toBeGreaterThanOrEqual(1);
      expect(res.body.recentSubmissions.some(s => String(s._id) === String(submissionB._id))).toBe(true);
    });
  });
});

