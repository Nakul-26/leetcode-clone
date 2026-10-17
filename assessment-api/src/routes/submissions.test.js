import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import Problem from '../../models/Problem.mjs';
import Assessment from '../../models/Assessment.mjs';
import AssessmentAttempt from '../../models/AssessmentAttempt.mjs';
import * as authService from '../services/auth.service.js';

describe('Submissions API', () => {
  let studentToken;
  let studentId;
  let problemId;
  let otherProblemId;

  beforeEach(async () => {
    // Create student user
    const student = await authService.register({
      name: 'Student User',
      email: `student-${Date.now()}@test.com`,
      password: 'password123',
      role: 'student'
    });
    studentToken = student.token;
    studentId = student.user.id;

    // Seed a problem
    const problem = await Problem.create({
      title: 'Two Sum',
      description: 'Sum of two numbers',
      difficulty: 'Easy',
      functionName: 'twoSum',
      parameters: [{ name: 'nums', type: 'array<number>' }, { name: 'target', type: 'number' }],
      returnType: 'array<number>',
      testCases: [{ inputs: [[2, 7, 11, 15], 9], expected: [0, 1], isSample: true }],
      referenceSolution: 'function twoSum(nums, target) { return [0, 1]; }',
      solutionLanguage: 'javascript'
    });
    problemId = problem._id;

    const otherProblem = await Problem.create({
      title: 'Other Problem',
      description: 'Not included in the assessment',
      difficulty: 'Easy',
      functionName: 'solve',
      parameters: [{ name: 'value', type: 'number' }],
      returnType: 'number',
      testCases: [{ inputs: [1], expected: 1, isSample: true }],
      referenceSolution: 'function solve(value) { return value; }',
      solutionLanguage: 'javascript'
    });
    otherProblemId = otherProblem._id;
  });

  async function createAssessmentAttempt(overrides = {}) {
    const assessment = await Assessment.create({
      title: 'Submission Rules Assessment',
      problems: [{ problemId, maxScore: 100 }],
      durationMinutes: 60,
      allowedLanguages: ['javascript'],
      startTime: new Date(Date.now() - 60_000),
      endTime: new Date(Date.now() + 3_600_000),
      createdBy: studentId,
      status: 'Published',
      ...overrides.assessment
    });
    const attempt = await AssessmentAttempt.create({
      assessmentId: assessment._id,
      studentId,
      status: 'Active',
      ...overrides.attempt
    });
    return { assessment, attempt };
  }

  it('POST /api/submissions should create a submission', async () => {
    const submission = {
      problemId: problemId.toString(),
      language: 'javascript',
      code: 'function twoSum(nums, target) { return [0, 1]; }'
    };

    const res = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send(submission);
    
    expect(res.status).toBe(202);
    expect(res.body._id).toBeDefined();
    expect(res.body.status).toBe('Pending');
  });

  it('GET /api/submissions/:id should return submission status', async () => {
    // Create submission
    const subRes = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        problemId: problemId.toString(),
        language: 'javascript',
        code: 'function twoSum(nums, target) { return [0, 1]; }'
      });
    const submissionId = subRes.body._id;

    const res = await request(app)
      .get(`/api/submissions/${submissionId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    
    expect(res.status).toBe(200);
    expect(res.body._id).toBe(submissionId);
    expect(res.body.status).toBeDefined();
  });

  it('accepts a submission for an active assessment attempt', async () => {
    const { assessment, attempt } = await createAssessmentAttempt();

    const res = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        problemId: problemId.toString(),
        language: 'javascript',
        code: 'function twoSum(nums, target) { return [0, 1]; }',
        assessmentId: assessment._id.toString(),
        attemptId: attempt._id.toString()
      });

    expect(res.status).toBe(202);
    expect(res.body.attemptId).toBe(attempt._id.toString());
  });

  it('rejects assessment submissions outside the attempt rules', async () => {
    const { assessment, attempt } = await createAssessmentAttempt();
    const baseSubmission = {
      problemId: problemId.toString(),
      language: 'javascript',
      code: 'function twoSum(nums, target) { return [0, 1]; }',
      assessmentId: assessment._id.toString(),
      attemptId: attempt._id.toString()
    };

    const wrongProblem = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ ...baseSubmission, problemId: otherProblemId.toString() });
    expect(wrongProblem.status).toBe(400);
    expect(wrongProblem.body.msg).toBe('Problem is not part of this assessment');

    const wrongLanguage = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ ...baseSubmission, language: 'python' });
    expect(wrongLanguage.status).toBe(400);
    expect(wrongLanguage.body.msg).toBe('Language is not allowed for this assessment');

    await AssessmentAttempt.findByIdAndUpdate(attempt._id, { status: 'Submitted', submittedAt: new Date() });
    const completedAttempt = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send(baseSubmission);
    expect(completedAttempt.status).toBe(409);
    expect(completedAttempt.body.msg).toContain('no longer accepts submissions');
  });

  it('times out expired attempts before accepting a submission', async () => {
    const { assessment, attempt } = await createAssessmentAttempt({
      attempt: { startedAt: new Date(Date.now() - 3_700_000) }
    });

    const res = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        problemId: problemId.toString(),
        language: 'javascript',
        code: 'function twoSum(nums, target) { return [0, 1]; }',
        assessmentId: assessment._id.toString(),
        attemptId: attempt._id.toString()
      });

    expect(res.status).toBe(409);
    expect(res.body.msg).toContain('timed out');
    const updatedAttempt = await AssessmentAttempt.findById(attempt._id);
    expect(updatedAttempt.status).toBe('TimedOut');
  });
});

describe('Submissions API — mcq/subjective', () => {
  let studentToken;
  let studentId;
  let facultyToken;
  let mcqProblemId;
  let subjectiveProblemId;

  beforeEach(async () => {
    const student = await authService.register({
      name: 'MCQ Student',
      email: `mcq-student-${Date.now()}@test.com`,
      password: 'password123',
      role: 'student'
    });
    studentToken = student.token;
    studentId = student.user.id;

    const faculty = await authService.register({
      name: 'Grading Faculty',
      email: `grading-faculty-${Date.now()}@test.com`,
      password: 'password123',
      role: 'faculty'
    });
    facultyToken = faculty.token;

    const mcqProblem = await Problem.create({
      title: 'Capital of France',
      description: 'Pick the capital of France',
      difficulty: 'Easy',
      problemType: 'mcq',
      options: [
        { text: 'Paris', isCorrect: true },
        { text: 'London', isCorrect: false },
        { text: 'Berlin', isCorrect: false }
      ]
    });
    mcqProblemId = mcqProblem._id;

    const subjectiveProblem = await Problem.create({
      title: 'Explain recursion',
      description: 'In your own words, explain recursion',
      difficulty: 'Medium',
      problemType: 'subjective',
      maxWords: 100
    });
    subjectiveProblemId = subjectiveProblem._id;
  });

  it('auto-grades a correct mcq submission as Success', async () => {
    const res = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ problemId: mcqProblemId.toString(), selectedOptions: [0] });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('Success');
    expect(res.body.score).toBe(100);
  });

  it('auto-grades an incorrect mcq submission as Fail', async () => {
    const res = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ problemId: mcqProblemId.toString(), selectedOptions: [1] });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('Fail');
    expect(res.body.score).toBe(0);
  });

  it('rejects an mcq submission with no selectedOptions', async () => {
    const res = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ problemId: mcqProblemId.toString() });

    expect(res.status).toBe(400);
  });

  it('rejects an mcq submission with an out-of-range option index', async () => {
    const res = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ problemId: mcqProblemId.toString(), selectedOptions: [99] });

    expect(res.status).toBe(400);
  });

  it('queues a subjective submission as PendingReview with zero score', async () => {
    const res = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ problemId: subjectiveProblemId.toString(), answerText: 'Recursion is a function calling itself.' });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PendingReview');
    expect(res.body.score).toBe(0);
  });

  it('rejects a subjective submission exceeding maxWords', async () => {
    const longAnswer = Array(101).fill('word').join(' ');
    const res = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ problemId: subjectiveProblemId.toString(), answerText: longAnswer });

    expect(res.status).toBe(400);
  });

  it('lets faculty grade a subjective submission and lists it in the ungraded queue first', async () => {
    const assessment = await Assessment.create({
      title: 'Subjective Grading Assessment',
      problems: [{ problemId: subjectiveProblemId, maxScore: 50 }],
      durationMinutes: 30,
      startTime: new Date(Date.now() - 60_000),
      endTime: new Date(Date.now() + 3_600_000),
      createdBy: studentId,
      status: 'Published'
    });
    const attempt = await AssessmentAttempt.create({
      assessmentId: assessment._id,
      studentId,
      status: 'Active'
    });

    const submitRes = await request(app)
      .post('/api/submissions')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        problemId: subjectiveProblemId.toString(),
        answerText: 'A function that calls itself.',
        assessmentId: assessment._id.toString(),
        attemptId: attempt._id.toString()
      });
    const submissionId = submitRes.body._id;

    await request(app)
      .post(`/api/submissions/${submissionId}/grade`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ score: 40, feedback: 'Good explanation' })
      .expect(403);

    const ungraded = await request(app)
      .get(`/api/submissions/assessment/${assessment._id}/ungraded`)
      .set('Authorization', `Bearer ${facultyToken}`);
    expect(ungraded.status).toBe(200);
    expect(ungraded.body.length).toBe(1);

    const gradeRes = await request(app)
      .post(`/api/submissions/${submissionId}/grade`)
      .set('Authorization', `Bearer ${facultyToken}`)
      .send({ score: 40, feedback: 'Good explanation' });

    expect(gradeRes.status).toBe(200);
    expect(gradeRes.body.status).toBe('Graded');
    expect(gradeRes.body.score).toBe(40);

    const updatedAttempt = await AssessmentAttempt.findById(attempt._id);
    expect(updatedAttempt.score).toBe(40);
  });
});
