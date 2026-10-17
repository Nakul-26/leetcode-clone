import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import College from '../../models/College.mjs';
import * as authService from '../services/auth.service.js';

describe('Drives API', () => {
  let collegeId;
  let otherCollegeId;
  let adminToken;
  let facultyToken;
  let studentToken;
  let studentId;
  let otherSectionStudentToken;
  let otherSectionStudentId;
  let outsideCollegeAdminToken;

  beforeEach(async () => {
    const college = await College.create({ name: 'Test College', slug: `test-college-${Date.now()}` });
    collegeId = college._id.toString();

    const otherCollege = await College.create({ name: 'Other College', slug: `other-college-${Date.now()}` });
    otherCollegeId = otherCollege._id.toString();

    const admin = await authService.register({
      name: 'Placement Admin',
      email: `admin-${Date.now()}@test.com`,
      password: 'password123',
      role: 'admin',
      collegeId
    });
    adminToken = admin.token;

    const faculty = await authService.register({
      name: 'Faculty User',
      email: `faculty-${Date.now()}@test.com`,
      password: 'password123',
      role: 'faculty',
      collegeId
    });
    facultyToken = faculty.token;

    const student = await authService.register({
      name: 'Student A',
      email: `student-a-${Date.now()}@test.com`,
      password: 'password123',
      role: 'student',
      collegeId,
      section: 'CSE-A'
    });
    studentToken = student.token;
    studentId = student.user.id;

    const student2 = await authService.register({
      name: 'Student B',
      email: `student-b-${Date.now()}@test.com`,
      password: 'password123',
      role: 'student',
      collegeId,
      section: 'CSE-B'
    });
    otherSectionStudentToken = student2.token;
    otherSectionStudentId = student2.user.id;

    const outsideAdmin = await authService.register({
      name: 'Outside Admin',
      email: `outside-admin-${Date.now()}@test.com`,
      password: 'password123',
      role: 'admin',
      collegeId: otherCollegeId
    });
    outsideCollegeAdminToken = outsideAdmin.token;
  });

  function driveDraftPayload(overrides = {}) {
    return {
      companyName: 'Acme Corp',
      description: 'SDE hiring drive',
      rounds: [
        { name: 'Aptitude Test', type: 'interview', passCriteria: 'Score >= 40%' },
        { name: 'Technical Interview', type: 'interview' }
      ],
      eligibility: { sections: ['CSE-A'] },
      status: 'Active',
      ...overrides
    };
  }

  async function createDrive(token = adminToken, overrides = {}) {
    const res = await request(app)
      .post('/api/drives')
      .set('Authorization', `Bearer ${token}`)
      .send(driveDraftPayload(overrides));
    return res;
  }

  it('admin can create a drive and it is scoped to their college', async () => {
    const res = await createDrive();
    expect(res.status).toBe(201);
    expect(res.body.companyName).toBe('Acme Corp');
    expect(res.body.rounds.length).toBe(2);
  });

  it('student cannot create a drive', async () => {
    const res = await request(app)
      .post('/api/drives')
      .set('Authorization', `Bearer ${studentToken}`)
      .send(driveDraftPayload());
    expect(res.status).toBe(403);
  });

  it('rejects a drive with no rounds', async () => {
    const res = await request(app)
      .post('/api/drives')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(driveDraftPayload({ rounds: [] }));
    expect(res.status).toBe(400);
  });

  it('student only sees Active drives, not Draft ones', async () => {
    await createDrive(adminToken, { status: 'Draft' });
    await createDrive(adminToken, { status: 'Active', companyName: 'Visible Co' });

    const res = await request(app)
      .get('/api/drives')
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].companyName).toBe('Visible Co');
  });

  it('a drive from another college is invisible (404) to this college\'s admin', async () => {
    const created = await createDrive(adminToken);
    const driveId = created.body._id;

    const res = await request(app)
      .get(`/api/drives/${driveId}`)
      .set('Authorization', `Bearer ${outsideCollegeAdminToken}`);

    expect(res.status).toBe(404);
  });

  it('admin can bulk-enroll specific students', async () => {
    const created = await createDrive();
    const driveId = created.body._id;

    const res = await request(app)
      .post(`/api/drives/${driveId}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ studentIds: [studentId, otherSectionStudentId] });

    expect(res.status).toBe(201);
    expect(res.body.enrolled).toBe(2);

    const list = await request(app)
      .get(`/api/drives/${driveId}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.length).toBe(2);
    expect(list.body.every((c) => c.status === 'Applied')).toBe(true);
  });

  it('re-enrolling an already-enrolled student is a no-op (idempotent)', async () => {
    const created = await createDrive();
    const driveId = created.body._id;

    await request(app)
      .post(`/api/drives/${driveId}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ studentIds: [studentId] });

    const res = await request(app)
      .post(`/api/drives/${driveId}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ studentIds: [studentId] });

    expect(res.status).toBe(201);
    expect(res.body.enrolled).toBe(0);
    expect(res.body.skipped).toBe(1);
  });

  it('auto-enroll only picks students matching the drive\'s eligible sections', async () => {
    const created = await createDrive(adminToken, { eligibility: { sections: ['CSE-A'] } });
    const driveId = created.body._id;

    const res = await request(app)
      .post(`/api/drives/${driveId}/candidates/auto-enroll`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(201);
    expect(res.body.enrolled).toBe(1); // only Student A (CSE-A)

    const list = await request(app)
      .get(`/api/drives/${driveId}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.length).toBe(1);
    expect(list.body[0].studentId.section).toBe('CSE-A');
  });

  async function enrollStudent(driveId) {
    await request(app)
      .post(`/api/drives/${driveId}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ studentIds: [studentId] });
    const list = await request(app)
      .get(`/api/drives/${driveId}/candidates`)
      .set('Authorization', `Bearer ${facultyToken}`);
    return list.body[0]._id;
  }

  it('full pipeline: pass round 1, advance, pass round 2 (final) -> Selected', async () => {
    const created = await createDrive();
    const driveId = created.body._id;
    const candidateId = await enrollStudent(driveId);

    const pass1 = await request(app)
      .post(`/api/drives/candidates/${candidateId}/result`)
      .set('Authorization', `Bearer ${facultyToken}`)
      .send({ result: 'Pass', notes: 'Did well' });
    expect(pass1.status).toBe(200);
    expect(pass1.body.status).toBe('RoundPassed');

    const advance1 = await request(app)
      .post(`/api/drives/candidates/${candidateId}/advance`)
      .set('Authorization', `Bearer ${facultyToken}`);
    expect(advance1.status).toBe(200);
    expect(advance1.body.status).toBe('InProgress');
    expect(advance1.body.currentRoundIndex).toBe(1);

    const pass2 = await request(app)
      .post(`/api/drives/candidates/${candidateId}/result`)
      .set('Authorization', `Bearer ${facultyToken}`)
      .send({ result: 'Pass' });
    expect(pass2.body.status).toBe('RoundPassed');

    const advance2 = await request(app)
      .post(`/api/drives/candidates/${candidateId}/advance`)
      .set('Authorization', `Bearer ${facultyToken}`);
    expect(advance2.status).toBe(200);
    expect(advance2.body.status).toBe('Selected');
  });

  it('failing a round sets status to RoundFailed and blocks advancing', async () => {
    const created = await createDrive();
    const driveId = created.body._id;
    const candidateId = await enrollStudent(driveId);

    const fail = await request(app)
      .post(`/api/drives/candidates/${candidateId}/result`)
      .set('Authorization', `Bearer ${facultyToken}`)
      .send({ result: 'Fail', notes: 'Did not qualify' });
    expect(fail.body.status).toBe('RoundFailed');

    const advance = await request(app)
      .post(`/api/drives/candidates/${candidateId}/advance`)
      .set('Authorization', `Bearer ${facultyToken}`);
    expect(advance.status).toBe(409);
  });

  it('faculty can reject a candidate directly', async () => {
    const created = await createDrive();
    const driveId = created.body._id;
    const candidateId = await enrollStudent(driveId);

    const res = await request(app)
      .post(`/api/drives/candidates/${candidateId}/reject`)
      .set('Authorization', `Bearer ${facultyToken}`)
      .send({ reason: 'Not a fit' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Rejected');
  });

  it('a student can withdraw their own candidacy but not someone else\'s', async () => {
    const created = await createDrive();
    const driveId = created.body._id;
    const candidateId = await enrollStudent(driveId);

    const forbidden = await request(app)
      .post(`/api/drives/candidates/${candidateId}/withdraw`)
      .set('Authorization', `Bearer ${otherSectionStudentToken}`);
    expect(forbidden.status).toBe(403);

    const ok = await request(app)
      .post(`/api/drives/candidates/${candidateId}/withdraw`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('Withdrawn');
  });

  it('student can check their own candidacy status for a drive', async () => {
    const created = await createDrive();
    const driveId = created.body._id;
    await enrollStudent(driveId);

    const res = await request(app)
      .get(`/api/drives/${driveId}/my-candidacy`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Applied');

    const noneRes = await request(app)
      .get(`/api/drives/${driveId}/my-candidacy`)
      .set('Authorization', `Bearer ${otherSectionStudentToken}`);
    expect(noneRes.body).toBeNull();
  });

  it('student cannot list all candidates for a drive', async () => {
    const created = await createDrive();
    const driveId = created.body._id;

    const res = await request(app)
      .get(`/api/drives/${driveId}/candidates`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(403);
  });

  it('admin can delete a drive', async () => {
    const created = await createDrive();
    const driveId = created.body._id;

    const res = await request(app)
      .delete(`/api/drives/${driveId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/drives/${driveId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.status).toBe(404);
  });

  it('faculty cannot delete a drive (admin/superadmin only)', async () => {
    const created = await createDrive();
    const driveId = created.body._id;

    const res = await request(app)
      .delete(`/api/drives/${driveId}`)
      .set('Authorization', `Bearer ${facultyToken}`);
    expect(res.status).toBe(403);
  });
});
