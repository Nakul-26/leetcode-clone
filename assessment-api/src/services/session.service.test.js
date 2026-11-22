import { describe, it, expect, vi, beforeEach } from 'vitest';
import User from '../../models/User.mjs';

// A Redis that actually stores, unlike the global mock (which always misses).
const store = vi.hoisted(() => new Map());
vi.mock('../config/redis.js', () => ({
  initRedis: async () => {},
  getRedis: () => ({
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => { store.set(k, v); return 'OK'; },
    del: async (k) => { store.delete(k); return 1; }
  })
}));

const { resolveSessionUser, revokeSessions, forgetSession, tokenClaims } = await import('./session.service.js');

describe('session.service cache', () => {
  beforeEach(() => store.clear());

  const newUser = (role = 'student') =>
    User.create({ name: 'U', email: `s-${Date.now()}-${Math.random()}@t.com`, password: 'x', role });

  it('serves repeat requests from the cache', async () => {
    const user = await newUser();
    const claims = tokenClaims(user);
    expect(await resolveSessionUser(claims)).toBeTruthy();

    const spy = vi.spyOn(User, 'findById');
    expect(await resolveSessionUser(claims)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('revokeSessions takes effect at once despite a cached entry', async () => {
    const user = await newUser();
    const claims = tokenClaims(user);
    expect(await resolveSessionUser(claims)).toBeTruthy();

    await revokeSessions(user._id);
    expect(await resolveSessionUser(claims)).toBeNull();

    const fresh = await User.findById(user._id);
    expect(await resolveSessionUser(tokenClaims(fresh))).toBeTruthy();
  });

  it('a deleted account is refused once its entry is forgotten', async () => {
    const user = await newUser();
    const claims = tokenClaims(user);
    expect(await resolveSessionUser(claims)).toBeTruthy();

    await User.deleteOne({ _id: user._id });
    await forgetSession(user._id);
    expect(await resolveSessionUser(claims)).toBeNull();
  });

  it('returns the current role, not the one in the token', async () => {
    const user = await newUser('faculty');
    const claims = tokenClaims(user);
    await User.updateOne({ _id: user._id }, { role: 'student' });
    await forgetSession(user._id);
    expect((await resolveSessionUser(claims)).role).toBe('student');
  });
});
