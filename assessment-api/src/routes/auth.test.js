import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import * as authService from '../services/auth.service.js';

describe('Auth API', () => {
  const testUser = {
    name: 'Test User',
    email: 'test@example.com',
    password: 'password123',
    role: 'student'
  };

  it('POST /api/auth/register should fail for unauthorized request (public registration disabled)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(testUser);
    
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/register should succeed if requested by superadmin', async () => {
    // Create a superadmin user directly via service
    const superadmin = await authService.register({
      name: 'Super Admin',
      email: `superadmin-${Date.now()}@test.com`,
      password: 'password123',
      role: 'superadmin'
    });

    const uniqueEmail = `test-${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/auth/register')
      .set('Authorization', `Bearer ${superadmin.token}`)
      .send({ ...testUser, email: uniqueEmail });
    
    expect(res.status).toBe(201);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(uniqueEmail);
    expect(res.body.token).toBeDefined();
  });

  it('POST /api/auth/login should authenticate a user', async () => {
    // Register user via service directly
    const uniqueEmail = `login-test-${Date.now()}@example.com`;
    await authService.register({ ...testUser, email: uniqueEmail });

    // Then login
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: uniqueEmail,
        password: testUser.password
      });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe(uniqueEmail);
  });

  it('POST /api/auth/login should fail with wrong credentials', async () => {
    // Register user via service directly
    const uniqueEmail = `wrong-cred-test-${Date.now()}@example.com`;
    await authService.register({ ...testUser, email: uniqueEmail });

    // Then login with wrong password
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: uniqueEmail,
        password: 'wrongpassword'
      });

    expect(res.status).toBe(401);
    expect(res.body.message || res.body.msg).toBeDefined();
  });

  it('GET /api/v1/auth/me returns the signed-in account and its role from the database', async () => {
    const reg = await authService.register({ ...testUser, email: `me-${Date.now()}@example.com`, role: 'faculty' });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${reg.token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: reg.user.id, email: reg.user.email, role: 'faculty', college: null });
    expect(res.body.user.password).toBeUndefined();

    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
  });

  describe('cookie-based auth (H8)', () => {
    it('authenticates via the httpOnly cookie alone, with no Authorization header', async () => {
      const uniqueEmail = `cookie-auth-${Date.now()}@example.com`;
      await authService.register({ ...testUser, email: uniqueEmail });

      const agent = request.agent(app); // persists Set-Cookie across requests
      const loginRes = await agent.post('/api/auth/login').send({ email: uniqueEmail, password: testUser.password });
      expect(loginRes.status).toBe(200);
      expect(loginRes.headers['set-cookie']).toBeDefined();

      // No Authorization header set here - only the agent's cookie jar authenticates this.
      const res = await agent.get('/api/v1/billing/status');
      expect(res.status).toBe(200);
    });

    it('logout clears the cookie so a subsequent protected request 401s', async () => {
      const uniqueEmail = `cookie-logout-${Date.now()}@example.com`;
      await authService.register({ ...testUser, email: uniqueEmail });

      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ email: uniqueEmail, password: testUser.password });

      const logoutRes = await agent.post('/api/auth/logout').set('X-Requested-With', 'XMLHttpRequest');
      expect(logoutRes.status).toBe(200);

      const res = await agent.get('/api/v1/billing/status');
      expect(res.status).toBe(401);
    });

    it('rejects a cookie-authenticated state-changing request with no X-Requested-With header', async () => {
      const uniqueEmail = `csrf-check-${Date.now()}@example.com`;
      await authService.register({ ...testUser, email: uniqueEmail });

      const agent = request.agent(app);
      await agent.post('/api/auth/login').send({ email: uniqueEmail, password: testUser.password });

      // Logout is otherwise unauthenticated, but the CSRF-lite check runs ahead of any
      // route logic for state-changing methods carrying the auth cookie.
      const res = await agent.post('/api/auth/logout');
      expect(res.status).toBe(403);
    });

    it('still authenticates via a bare Authorization header with no cookie (integration/service callers)', async () => {
      const uniqueEmail = `bearer-only-${Date.now()}@example.com`;
      const registered = await authService.register({ ...testUser, email: uniqueEmail });

      const res = await request(app)
        .get('/api/v1/billing/status')
        .set('Authorization', `Bearer ${registered.token}`);
      expect(res.status).toBe(200);
    });
  });
});
