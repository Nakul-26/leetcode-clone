import { describe, it, expect } from 'vitest';
import request from 'supertest';

// Regression test for a production login failure: the API's CORS allowlist was empty, so a
// browser POST from the deployed frontend (which always carries an Origin header, even
// same-site) was rejected with "Not allowed by CORS" and surfaced as a generic 500.
// The shared test setup has already loaded config/env.js, so set the value on that object
// before app.js reads it at import time (changing process.env now would be too late).
import { env } from './config/env.js';
env.CORS_ALLOWED_ORIGINS = 'https://assess.example.test, https://other.example.test';
const { default: app } = await import('./app.js');

describe('CORS allowlist', () => {
  it('lets a listed browser origin through', async () => {
    const res = await request(app)
      .get('/api/health/ready')
      .set('Origin', 'https://assess.example.test');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://assess.example.test');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('handles the preflight for a listed origin', async () => {
    const res = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', 'https://other.example.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://other.example.test');
  });

  it('rejects an origin that is not listed', async () => {
    const res = await request(app)
      .get('/api/health/ready')
      .set('Origin', 'https://evil.example.test');
    expect(res.status).not.toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still allows requests with no Origin header (curl, server-to-server partners)', async () => {
    const res = await request(app).get('/api/health/ready');
    expect(res.status).toBe(200);
  });
});
