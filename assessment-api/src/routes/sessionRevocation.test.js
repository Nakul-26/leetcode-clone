import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import { env } from '../config/env.js';
import User from '../../models/User.mjs';
import * as authService from '../services/auth.service.js';

// Login tokens can be taken back (session.service.js): deleting an account or resetting its
// password ends its sessions, and the role comes from the database, not the token.
describe('Session revocation', () => {
  let n = 0;
  const make = (role, extra = {}) =>
    authService.register({
      name: `${role} ${++n}`,
      email: `revoke-${role}-${Date.now()}-${n}@test.com`,
      password: 'password123',
      role,
      ...extra
    });
  const me = (token) => request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

  it('a token stops working once its account is deleted', async () => {
    const admin = await make('superadmin');
    const student = await make('student');
    expect((await me(student.token)).status).toBe(200);

    const del = await request(app)
      .delete(`/api/admin/users/${student.user.id}`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(del.status).toBe(200);

    const after = await me(student.token);
    expect(after.status).toBe(401);
    expect(after.body.message).toBe('Session expired');
  });

  it('a password reset signs the user out everywhere, and the new login works', async () => {
    const admin = await make('superadmin');
    const student = await make('student');

    const reset = await request(app)
      .post(`/api/admin/users/${student.user.id}/reset-password`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ newPassword: 'newpass456' });
    expect(reset.status).toBe(200);

    expect((await me(student.token)).status).toBe(401);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: student.user.email, password: 'newpass456' });
    expect(login.status).toBe(200);
    expect((await me(login.body.token)).status).toBe(200);
  });

  it('the role is read from the database, not the token', async () => {
    const faculty = await make('faculty');
    await User.updateOne({ _id: faculty.user.id }, { role: 'student' });
    // The cached state is dropped here as an admin action would; a direct database edit
    // would otherwise apply within the cache TTL.
    const { forgetSession } = await import('../services/session.service.js');
    await forgetSession(faculty.user.id);

    const res = await request(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${faculty.token}`);
    expect(res.status).toBe(403);
  });

  it('tokens issued before versioning (no tv claim) still work', async () => {
    const student = await make('student');
    const legacy = jwt.sign(
      { id: student.user.id, role: 'student', email: student.user.email, name: 'x' },
      env.JWT_SECRET,
      { expiresIn: '1h' }
    );
    expect((await me(legacy)).status).toBe(200);
  });

  it('a token for an id that is not an ObjectId is rejected, not a 500', async () => {
    const bogus = jwt.sign({ id: 'not-an-id', role: 'superadmin' }, env.JWT_SECRET, { expiresIn: '1h' });
    expect((await me(bogus)).status).toBe(401);
  });

  it('a faculty member cannot reset or delete an admin of their college', async () => {
    const collegeId = (await User.db.collection('colleges').insertOne({ name: `C${Date.now()}` })).insertedId.toString();
    const admin = await make('admin', { collegeId });
    const faculty = await make('faculty', { collegeId });
    const student = await make('student', { collegeId });

    const reset = await request(app)
      .post(`/api/admin/users/${admin.user.id}/reset-password`)
      .set('Authorization', `Bearer ${faculty.token}`)
      .send({ newPassword: 'takeover1' });
    expect(reset.status).toBe(403);

    const del = await request(app)
      .delete(`/api/admin/users/${admin.user.id}`)
      .set('Authorization', `Bearer ${faculty.token}`);
    expect(del.status).toBe(403);

    const ok = await request(app)
      .post(`/api/admin/users/${student.user.id}/reset-password`)
      .set('Authorization', `Bearer ${faculty.token}`)
      .send({ newPassword: 'studentpw1' });
    expect(ok.status).toBe(200);
  });
});
