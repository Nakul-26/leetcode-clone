import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import Problem from '../../models/Problem.mjs';
import * as authService from '../services/auth.service.js';

describe('Problems API', () => {
  let adminToken;
  let studentToken;

  beforeEach(async () => {
    // Create admin user
    const admin = await authService.register({
      name: 'Admin User',
      email: `admin-${Date.now()}@test.com`,
      password: 'password123',
      role: 'admin'
    });
    adminToken = admin.token;

    // Create student user
    const student = await authService.register({
      name: 'Student User',
      email: `student-${Date.now()}@test.com`,
      password: 'password123',
      role: 'student'
    });
    studentToken = student.token;

    // Seed some problems
    await Problem.create([
      {
        title: 'Two Sum',
        description: 'Sum of two numbers',
        difficulty: 'Easy',
        functionName: 'twoSum',
        parameters: [{ name: 'nums', type: 'array<number>' }, { name: 'target', type: 'number' }],
        returnType: 'array<number>',
        testCases: [{ inputs: [[2, 7, 11, 15], 9], expected: [0, 1], isSample: true }],
        referenceSolution: 'function twoSum(nums, target) { return [0, 1]; }',
        solutionLanguage: 'javascript'
      },
      {
        title: 'Reverse String',
        description: 'Reverse it',
        difficulty: 'Easy',
        functionName: 'reverseString',
        parameters: [{ name: 's', type: 'string' }],
        returnType: 'string',
        testCases: [{ inputs: ['hello'], expected: 'olleh', isSample: true }],
        referenceSolution: 'function reverseString(s) { return "olleh"; }',
        solutionLanguage: 'javascript'
      }
    ]);
  });

  it('GET /api/problems should return list of problems', async () => {
    const res = await request(app).get('/api/problems');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
  });

  it('GET /api/problems/:id should return a specific problem', async () => {
    const listRes = await request(app).get('/api/problems');
    const problem = listRes.body.find(p => p.title === 'Two Sum');
    const problemId = problem._id;

    const res = await request(app).get(`/api/problems/${problemId}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Two Sum');
  });

  it('POST /api/problems should create a problem for admin', async () => {
    const newProblem = {
      title: 'Add Two Numbers',
      description: 'Add them',
      difficulty: 'Medium',
      functionName: 'addTwo',
      parameters: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }],
      returnType: 'number',
      testCases: [{ inputs: [1, 2], expected: 3, isSample: true }],
      referenceSolution: 'function addTwo(a, b) { return a + b; }',
      solutionLanguage: 'javascript'
    };

    const res = await request(app)
      .post('/api/problems')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(newProblem);
    
    expect(res.status).toBe(201);
    expect(res.body.problem.title).toBe('Add Two Numbers');
  });

  it('POST /api/problems should fail for student', async () => {
    const res = await request(app)
      .post('/api/problems')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ title: 'Unauthorized' });

    expect(res.status).toBe(403);
  });

  it('POST /api/problems creates an mcq problem without needing a reference solution', async () => {
    const res = await request(app)
      .post('/api/problems')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Capital of France',
        description: 'Pick the capital of France',
        difficulty: 'Easy',
        problemType: 'mcq',
        options: [
          { text: 'Paris', isCorrect: true },
          { text: 'London', isCorrect: false }
        ]
      });

    expect(res.status).toBe(201);
    expect(res.body.problem.problemType).toBe('mcq');
    expect(res.body.problem.options.length).toBe(2);
  });

  it('POST /api/problems rejects an mcq problem with no correct option', async () => {
    const res = await request(app)
      .post('/api/problems')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Bad MCQ',
        description: 'No correct answer',
        difficulty: 'Easy',
        problemType: 'mcq',
        options: [
          { text: 'A', isCorrect: false },
          { text: 'B', isCorrect: false }
        ]
      });

    expect(res.status).toBe(400);
  });

  it('POST /api/problems rejects an mcq problem with only one option', async () => {
    const res = await request(app)
      .post('/api/problems')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Bad MCQ',
        description: 'Only one option',
        difficulty: 'Easy',
        problemType: 'mcq',
        options: [{ text: 'A', isCorrect: true }]
      });

    expect(res.status).toBe(400);
  });

  it('POST /api/problems creates a subjective problem without needing test cases', async () => {
    const res = await request(app)
      .post('/api/problems')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Explain recursion',
        description: 'In your own words, explain recursion',
        difficulty: 'Medium',
        problemType: 'subjective',
        maxWords: 200
      });

    expect(res.status).toBe(201);
    expect(res.body.problem.problemType).toBe('subjective');
    expect(res.body.problem.maxWords).toBe(200);
  });
});
