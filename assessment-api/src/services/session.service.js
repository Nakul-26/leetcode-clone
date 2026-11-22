import mongoose from "mongoose";
import User from "../../models/User.mjs";
import { getRedis } from "../config/redis.js";

// Login tokens are signed JWTs that live 7 days, so on their own they cannot be taken back:
// a deleted account, or a session stolen before a password reset, kept working until expiry.
// Each user carries a tokenVersion that goes into the token as `tv`; every request compares it
// with the current value, and bumping it ends all of that user's sessions at once. The role
// and college are read from here too, so a change made in the database applies straight away
// rather than at the next login.
//
// The current state is cached in Redis, so a request costs one GET; revokeSessions and
// forgetSession drop the entry, and the TTL only bounds edits made outside the API.
const CACHE_TTL_SECONDS = 300;

function cacheKey(userId) {
  return `auth:session:${userId}`;
}

// The claims put into every login token (register and login).
export function tokenClaims(user) {
  return {
    id: user._id.toString(),
    role: user.role,
    email: user.email,
    name: user.name,
    collegeId: user.collegeId || null,
    tv: user.tokenVersion || 0
  };
}

async function readCache(userId) {
  const redis = getRedis();
  if (!redis) return undefined;
  try {
    const raw = await redis.get(cacheKey(userId));
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined; // Redis trouble: fall back to the database
  }
}

async function writeCache(userId, state) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(cacheKey(userId), JSON.stringify(state), { EX: CACHE_TTL_SECONDS });
  } catch {
    // best effort
  }
}

// { exists: false } for a deleted account, otherwise its current version, role and college.
export async function getSessionState(userId) {
  const cached = await readCache(userId);
  if (cached) return cached;

  const user = await User.findById(userId).select("tokenVersion role collegeId").lean();
  const state = user
    ? {
        exists: true,
        tv: user.tokenVersion || 0,
        role: user.role,
        collegeId: user.collegeId ? String(user.collegeId) : null
      }
    : { exists: false };
  await writeCache(userId, state);
  return state;
}

// The user the token stands for, with role and college as they are now, or null when the
// account is gone or the token belongs to a session that has since been revoked. Tokens issued
// before tokenVersion existed carry no `tv` and count as version 0.
export async function resolveSessionUser(decoded) {
  const userId = decoded.id || decoded._id;
  if (!userId || !mongoose.isValidObjectId(userId)) return null;

  const state = await getSessionState(userId);
  if (!state.exists || (decoded.tv || 0) !== state.tv) return null;

  return { ...decoded, role: state.role, collegeId: state.collegeId };
}

// Ends every session of this user (password reset); they have to sign in again.
export async function revokeSessions(userId) {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  await forgetSession(userId);
}

// Drops the cached state so the next request reads the database (account deleted).
export async function forgetSession(userId) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(cacheKey(userId));
  } catch {
    // best effort; the entry expires within CACHE_TTL_SECONDS
  }
}
