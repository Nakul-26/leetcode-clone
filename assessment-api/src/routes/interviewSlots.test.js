import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import College from '../../models/College.mjs';
import Assessment from '../../models/Assessment.mjs';
import * as authService from '../services/auth.service.js';
import * as interviewSlotsService from '../services/interviewSlots.service.js';

describe('Interview Slots API', () => {
  let collegeId;
  let adminToken;
  let facultyToken;
  let facultyId;
  let studentToken;
  let studentId;
  let otherStudentToken;
  let otherStudentId;
  let driveId;
  let candidateId;

  beforeEach(async () => {
    const college = await College.create({ name: 'Test College', slug: `test-college-${Date.now()}` });
    collegeId = college._id.toString();

    const admin = await authService.register({
      name: 'Placement Admin',
      email: `admin-${Date.now()}@test.com`,
      password: 'password123',
      role: 'admin',
      collegeId
    });
    adminToken = admin.token;

    const faculty = await authService.register({
      name: 'Faculty Interviewer',
      email: `faculty-${Date.now()}@test.com`,
      password: 'password123',
      role: 'faculty',
      collegeId
    });
    facultyToken = faculty.token;
    facultyId = faculty.user.id;

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
      section: 'CSE-A'
    });
    otherStudentToken = student2.token;
    otherStudentId = student2.user.id;

    const driveRes = await request(app)
      .post('/api/drives')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyName: 'Acme Corp',
        rounds: [
          { name: 'Technical Interview', type: 'interview' },
          { name: 'Aptitude Test', type: 'interview' }
        ],
        status: 'Active'
      });
    driveId = driveRes.body._id;

    await request(app)
      .post(`/api/drives/${driveId}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ studentIds: [studentId] });

    const list = await request(app)
      .get(`/api/drives/${driveId}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`);
    candidateId = list.body[0]._id;
  });

  function futureDate(hours = 24) {
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  }

  it('staff can schedule a slot with an internal interviewer', async () => {
    const res = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ interviewerId: facultyId, scheduledAt: futureDate(), meetingLink: 'https://meet.example.com/abc' });

    expect(res.status).toBe(201);
    expect(res.body.slot.status).toBe('Scheduled');
    expect(res.body.slot.interviewerId.name).toBe('Faculty Interviewer');
    expect(res.body.accessToken).toBeUndefined();
  });

  it('staff can schedule a slot with an external interviewer and gets a one-time access token', async () => {
    const res = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        externalInterviewerName: 'External Bob',
        externalInterviewerEmail: 'bob@partner.com',
        scheduledAt: futureDate()
      });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.slot.externalInterviewerEmail).toBe('bob@partner.com');
  });

  it('student cannot schedule a slot', async () => {
    const res = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ interviewerId: facultyId, scheduledAt: futureDate() });
    expect(res.status).toBe(403);
  });

  it('rejects scheduling for a non-interview (assessment) round', async () => {
    const admin = await authService.register({
      name: 'Assessment Owner',
      email: `owner-${Date.now()}@test.com`,
      password: 'password123',
      role: 'admin',
      collegeId
    });
    const assessment = await Assessment.create({
      title: 'Aptitude MCQ',
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      durationMinutes: 60,
      createdBy: admin.user.id,
      collegeId
    });

    const mixedDrive = await request(app)
      .post('/api/drives')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        companyName: 'Beta Inc',
        rounds: [
          { name: 'Aptitude MCQ', type: 'assessment', assessmentId: assessment._id.toString() },
          { name: 'Technical Interview', type: 'interview' }
        ],
        status: 'Active'
      });
    const beta = mixedDrive.body;
    await request(app)
      .post(`/api/drives/${beta._id}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ studentIds: [studentId] });
    const betaCandidates = await request(app)
      .get(`/api/drives/${beta._id}/candidates`)
      .set('Authorization', `Bearer ${adminToken}`);
    const betaCandidateId = betaCandidates.body[0]._id;

    const res = await request(app)
      .post(`/api/interview-slots/candidate/${betaCandidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roundIndex: 0, scheduledAt: futureDate(), interviewerId: facultyId });
    expect(res.status).toBe(400);

    const ok = await request(app)
      .post(`/api/interview-slots/candidate/${betaCandidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ roundIndex: 1, scheduledAt: futureDate(), interviewerId: facultyId });
    expect(ok.status).toBe(201);
  });

  it('requires either an interviewer or an external email', async () => {
    const res = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ scheduledAt: futureDate() });
    expect(res.status).toBe(400);
  });

  it('an external interviewer can view slot details via the signed link, but not with a bad token', async () => {
    const created = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        externalInterviewerName: 'External Bob',
        externalInterviewerEmail: 'bob@partner.com',
        scheduledAt: futureDate()
      });
    const token = created.body.accessToken;

    const ok = await request(app).get(`/api/interview-slots/external/${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.companyName).toBe('Acme Corp');
    expect(ok.body.candidateName).toBe('Student A');
    expect(ok.body.accessTokenHash).toBeUndefined();

    const bad = await request(app).get(`/api/interview-slots/external/not-a-real-token`);
    expect(bad.status).toBe(404);
  });

  it('a student can see their own scheduled interviews', async () => {
    await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ interviewerId: facultyId, scheduledAt: futureDate() });

    const res = await request(app)
      .get('/api/interview-slots/my')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);

    const otherRes = await request(app)
      .get('/api/interview-slots/my')
      .set('Authorization', `Bearer ${otherStudentToken}`);
    expect(otherRes.body.length).toBe(0);
  });

  it('a student cannot view another student\'s slot by id', async () => {
    const created = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ interviewerId: facultyId, scheduledAt: futureDate() });
    const slotId = created.body.slot._id;

    const forbidden = await request(app)
      .get(`/api/interview-slots/${slotId}`)
      .set('Authorization', `Bearer ${otherStudentToken}`);
    expect(forbidden.status).toBe(404);

    const ok = await request(app)
      .get(`/api/interview-slots/${slotId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(ok.status).toBe(200);
  });

  it('staff can reschedule, cancel, and complete a slot', async () => {
    const created = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ interviewerId: facultyId, scheduledAt: futureDate() });
    const slotId = created.body.slot._id;

    const rescheduled = await request(app)
      .put(`/api/interview-slots/${slotId}`)
      .set('Authorization', `Bearer ${facultyToken}`)
      .send({ scheduledAt: futureDate(48) });
    expect(rescheduled.status).toBe(200);

    const completed = await request(app)
      .post(`/api/interview-slots/${slotId}/complete`)
      .set('Authorization', `Bearer ${facultyToken}`)
      .send({ notes: 'Went well' });
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe('Completed');

    const cancelAfterComplete = await request(app)
      .post(`/api/interview-slots/${slotId}/cancel`)
      .set('Authorization', `Bearer ${facultyToken}`);
    expect(cancelAfterComplete.status).toBe(409);
  });

  it('regenerating an external link invalidates the old token', async () => {
    const created = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        externalInterviewerName: 'External Bob',
        externalInterviewerEmail: 'bob@partner.com',
        scheduledAt: futureDate()
      });
    const slotId = created.body.slot._id;
    const oldToken = created.body.accessToken;

    const regen = await request(app)
      .post(`/api/interview-slots/${slotId}/regenerate-link`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(regen.status).toBe(200);
    const newToken = regen.body.accessToken;
    expect(newToken).not.toBe(oldToken);

    const oldRes = await request(app).get(`/api/interview-slots/external/${oldToken}`);
    expect(oldRes.status).toBe(404);

    const newRes = await request(app).get(`/api/interview-slots/external/${newToken}`);
    expect(newRes.status).toBe(200);
  });

  it('a drive from another college cannot be scheduled against by that college\'s admin', async () => {
    const otherCollege = await College.create({ name: 'Other College', slug: `other-college-${Date.now()}` });
    const outsideAdmin = await authService.register({
      name: 'Outside Admin',
      email: `outside-${Date.now()}@test.com`,
      password: 'password123',
      role: 'admin',
      collegeId: otherCollege._id.toString()
    });

    const res = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${outsideAdmin.token}`)
      .send({ interviewerId: facultyId, scheduledAt: futureDate() });
    expect(res.status).toBe(404);
  });

  it('an interviewer sees their assigned slots via /my, separate from a student\'s own', async () => {
    await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ interviewerId: facultyId, scheduledAt: futureDate() });

    const asInterviewer = await request(app)
      .get('/api/interview-slots/my')
      .set('Authorization', `Bearer ${facultyToken}`);
    expect(asInterviewer.status).toBe(200);
    expect(asInterviewer.body.length).toBe(1);

    const asAdmin = await request(app)
      .get('/api/interview-slots/my')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(asAdmin.body.length).toBe(0);
  });

  it('the assigned interviewer can submit a scorecard with valid ratings', async () => {
    const created = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ interviewerId: facultyId, scheduledAt: futureDate() });
    const slotId = created.body.slot._id;

    const res = await request(app)
      .post(`/api/interview-slots/${slotId}/scorecard`)
      .set('Authorization', `Bearer ${facultyToken}`)
      .send({ ratings: { communication: 4, problemSolving: 5, technicalDepth: 3 }, notes: 'Strong candidate' });
    expect(res.status).toBe(200);
    expect(res.body.scorecards).toHaveLength(1);
    expect(res.body.scorecards[0].ratings.problemSolving).toBe(5);
    expect(res.body.scorecards[0].submittedByName).toBe('Faculty Interviewer');
  });

  it('rejects an out-of-range scorecard rating', async () => {
    const created = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ interviewerId: facultyId, scheduledAt: futureDate() });
    const slotId = created.body.slot._id;

    const res = await request(app)
      .post(`/api/interview-slots/${slotId}/scorecard`)
      .set('Authorization', `Bearer ${facultyToken}`)
      .send({ ratings: { communication: 7 } });
    expect(res.status).toBe(400);
  });

  it('an external interviewer can submit a scorecard via their token, without an account', async () => {
    const created = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        externalInterviewerName: 'External Bob',
        externalInterviewerEmail: 'bob@partner.com',
        scheduledAt: futureDate()
      });
    const token = created.body.accessToken;

    const res = await request(app)
      .post(`/api/interview-slots/external/${token}/scorecard`)
      .send({ ratings: { communication: 3 }, notes: 'Solid enough' });
    expect(res.status).toBe(200);
    expect(res.body.scorecards).toHaveLength(1);
    expect(res.body.scorecards[0].submittedByName).toBe('External Bob');
  });

  it('lets multiple submitters (staff + external) each keep their own scorecard, and a re-submit replaces only their own entry', async () => {
    const created = await request(app)
      .post(`/api/interview-slots/candidate/${candidateId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ interviewerId: facultyId, scheduledAt: futureDate() });
    const slotId = created.body.slot._id;

    await request(app)
      .post(`/api/interview-slots/${slotId}/scorecard`)
      .set('Authorization', `Bearer ${facultyToken}`)
      .send({ ratings: { communication: 2 }, notes: 'first pass' });

    const admin2 = await authService.register({
      name: 'Second Interviewer', email: `interviewer2-${Date.now()}@test.com`, password: 'password123', role: 'faculty', collegeId
    });
    const both = await request(app)
      .post(`/api/interview-slots/${slotId}/scorecard`)
      .set('Authorization', `Bearer ${admin2.token}`)
      .send({ ratings: { communication: 5 }, notes: 'second interviewer' });
    expect(both.body.scorecards).toHaveLength(2);

    const resubmit = await request(app)
      .post(`/api/interview-slots/${slotId}/scorecard`)
      .set('Authorization', `Bearer ${facultyToken}`)
      .send({ ratings: { communication: 4 }, notes: 'revised' });
    expect(resubmit.body.scorecards).toHaveLength(2);
    const facultyEntry = resubmit.body.scorecards.find((s) => s.submittedByName === 'Faculty Interviewer');
    expect(facultyEntry.ratings.communication).toBe(4);
    expect(facultyEntry.notes).toBe('revised');
  });

  describe('resolveSlotForParticipant (used by the live interview room\'s WS join-room auth)', () => {
    it('resolves the candidate, the assigned interviewer, and the external token to the same slot', async () => {
      const created = await request(app)
        .post(`/api/interview-slots/candidate/${candidateId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ interviewerId: facultyId, scheduledAt: futureDate() });
      const slotId = created.body.slot._id;

      const asCandidate = await interviewSlotsService.resolveSlotForParticipant(slotId, {
        user: { _id: studentId, role: 'student', collegeId }
      });
      expect(asCandidate.identity.kind).toBe('candidate');

      const asInterviewer = await interviewSlotsService.resolveSlotForParticipant(slotId, {
        user: { _id: facultyId, role: 'faculty', collegeId, name: 'Faculty Interviewer' }
      });
      expect(asInterviewer.identity.kind).toBe('interviewer');

      await expect(interviewSlotsService.resolveSlotForParticipant(slotId, {
        user: { _id: otherStudentId, role: 'student', collegeId }
      })).rejects.toMatchObject({ status: 404 });
    });

    it('rejects a valid external token when the slotId in the join request doesn\'t match', async () => {
      const created = await request(app)
        .post(`/api/interview-slots/candidate/${candidateId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          externalInterviewerName: 'External Bob',
          externalInterviewerEmail: 'bob@partner.com',
          scheduledAt: futureDate()
        });
      const accessToken = created.body.accessToken;
      const realSlotId = created.body.slot._id;

      const ok = await interviewSlotsService.resolveSlotForParticipant(realSlotId, { accessToken });
      expect(ok.identity.kind).toBe('external');

      await expect(interviewSlotsService.resolveSlotForParticipant('000000000000000000000000', { accessToken }))
        .rejects.toMatchObject({ status: 403 });
    });
  });
});
