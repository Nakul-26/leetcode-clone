import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { env } from '../config/env.js';
import User from '../../models/User.mjs';
import jwt from 'jsonwebtoken';

describe('Integration API', () => {
  let studentToken;
  const serviceKey = env.TESTING_PLATFORM_KEY || 'testing_platform_secret';

  // beforeEach, not beforeAll: the global setup empties the database before every test, and a
  // token whose account is gone is refused.
  beforeEach(async () => {
    // Create a student directly in the database
    const user = await User.create({
      name: 'Integration Student',
      email: 'integration@student.com',
      password: 'hashed_password', // Doesn't matter for token verification
      role: 'student'
    });

    studentToken = jwt.sign(
      { _id: user._id.toString(), id: user._id.toString(), role: user.role, email: user.email, name: user.name },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );
  });

  it('should fail if x-service-key is missing', async () => {
    const res = await request(app)
      .get('/api/integration/assessments/123')
      .set('Authorization', `Bearer ${studentToken}`);
    
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Unauthorized service');
  });

  it('should fail if x-service-key is incorrect', async () => {
    const res = await request(app)
      .get('/api/integration/assessments/123')
      .set('x-service-key', 'wrong_key')
      .set('Authorization', `Bearer ${studentToken}`);
    
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Unauthorized service');
  });

  it('should fail if student token is missing', async () => {
    const res = await request(app)
      .get('/api/integration/assessments/123')
      .set('x-service-key', serviceKey);
    
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('No token');
  });

  it('should return 404 for non-existent assessment with valid keys', async () => {
    const res = await request(app)
      .get('/api/integration/assessments/000000000000000000000000') // Valid BSON ID but non-existent
      .set('x-service-key', serviceKey)
      .set('Authorization', `Bearer ${studentToken}`);
    
    expect(res.status).toBe(404);
  });

  it('should fail with an invalid token', async () => {
    const res = await request(app)
      .get('/api/integration/assessments/000000000000000000000000')
      .set('x-service-key', serviceKey)
      .set('Authorization', 'Bearer invalid_token');
    
    expect(res.status).toBe(401);
  });

  it('should prevent cross-student submission (Scenario 4)', async () => {
    // 1. Create another student
    const studentB = await User.create({
      name: 'Student B',
      email: 'studentb@example.com',
      password: 'password',
      role: 'student'
    });
    // 2. Create an attempt for Student B
    // We need an assessment first
    const assessment = await (await import('../../models/Assessment.mjs')).default.create({
      title: 'Test Assessment',
      startTime: new Date(),
      endTime: new Date(Date.now() + 3600000),
      durationMinutes: 60,
      problems: [],
      createdBy: studentB._id // doesn't matter much for this test
    });

    const attemptB = await (await import('../../models/AssessmentAttempt.mjs')).default.create({
      assessmentId: assessment._id,
      studentId: studentB._id,
      status: 'Active',
      startedAt: new Date()
    });

    // 3. Try to submit to Student B's attempt using Student A's token
    const res = await request(app)
      .post('/api/integration/submissions')
      .set('x-service-key', serviceKey)
      .set('Authorization', `Bearer ${studentToken}`) // studentToken is Student A
      .send({
        problemId: '000000000000000000000000',
        code: 'print(1)',
        language: 'python',
        assessmentId: assessment._id.toString(),
        attemptId: attemptB._id.toString()
      });

    expect(res.status).toBe(403);
    expect(res.body.msg).toContain('You do not own this attempt');
  });

  it('should allow fetching results with only service key', async () => {
    const res = await request(app)
      .get('/api/integration/results/000000000000000000000000')
      .set('x-service-key', serviceKey);
    
    // It should be allowed (not 401/403) even if it returns 404 or empty array
    // Since assessment doesn't exist, it might return empty array or 404 depending on implementation
    // listAssessmentAttempts returns attemptsRepo.findAll which returns [] if none found
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
