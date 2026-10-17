import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "../../models/User.mjs";
import College from "../../models/College.mjs";
import { env } from "../config/env.js";
import { getPlan } from "../config/plans.js";
import { HttpError } from "../utils/httpError.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import * as auditService from "./audit.service.js";

// superadmin operates across colleges; everyone else is scoped to their own. Mirrors
// assessments.service.js's collegeScopeFor exactly, including the same "known gap left
// open on purpose" for legacy admins with no collegeId (see C2 in
// docs/PLATFORM_AUDIT_AND_SAAS_ROADMAP.md) — falls back to unscoped rather than
// scoped-to-nothing.
function collegeScopeFor(user) {
  if (!user || user.role === 'superadmin') return undefined;
  return user.collegeId || undefined;
}

// Phase 2 billing seat limit — no-op for plans with an unbounded seat count (Infinity),
// and fails open if the college doesn't exist yet (e.g. legacy/unscoped data) so this
// never blocks account creation for reasons unrelated to billing.
async function assertSeatCapacity(collegeId, incomingSeats) {
  if (!collegeId) return;
  const college = await College.findById(collegeId);
  if (!college) return;

  const plan = getPlan(college.planId);
  if (!Number.isFinite(plan.seatLimit)) return;

  const currentSeats = await User.countDocuments({ collegeId });
  if (currentSeats + incomingSeats > plan.seatLimit) {
    throw new HttpError(402, "Seat limit reached for your plan", {
      message: `Seat limit reached for your plan (${plan.seatLimit} seats). Upgrade to add more users.`
    });
  }
}

function toPublicUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
    usn: user.usn || null,
    section: user.section || null,
    collegeId: user.collegeId || null
  };
}

export async function register({ name, email, password, role, collegeId, usn, section }) {
  const normalizedCollegeId = typeof collegeId === "string" ? collegeId.trim() : collegeId;
  if (normalizedCollegeId && !mongoose.isValidObjectId(normalizedCollegeId)) {
    throw new HttpError(400, "Invalid collegeId", {
      message: "collegeId must be a valid Mongo ObjectId"
    });
  }

  const emailLower = email.toLowerCase();
  const existing = await User.findOne({ email: emailLower });
  if (existing) {
    throw new HttpError(409, "Email already registered", { message: "Email already registered" });
  }

  if (usn) {
    const existingUsn = await User.findOne({ usn: usn.trim() });
    if (existingUsn) {
      throw new HttpError(409, "USN already registered", { message: "USN already registered" });
    }
  }

  await assertSeatCapacity(normalizedCollegeId, 1);

  const hashed = await bcrypt.hash(password, 10);
  const user = await User.create({
    name,
    email: emailLower,
    password: hashed,
    role,
    usn: usn ? usn.trim() : undefined,
    section: section ? section.trim() : undefined,
    collegeId: normalizedCollegeId || undefined
  });

  const token = jwt.sign(
    { id: user._id.toString(), role: user.role, email: user.email, name: user.name, collegeId: user.collegeId || null },
    env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  return { token, user: toPublicUser(user) };
}

export async function bulkRegister(users, defaultPassword, collegeId) {
  const results = {
    created: [],
    errors: [],
    count: 0
  };

  const seenEmails = new Set();
  const seenUsns = new Set();
  const verifiedUsersToCreate = [];

  for (let i = 0; i < users.length; i++) {
    const userData = users[i];
    const email = userData.email ? userData.email.trim().toLowerCase() : "";
    const usn = userData.usn ? userData.usn.trim() : "";
    const name = userData.name ? userData.name.trim() : "";
    const section = userData.section ? userData.section.trim() : "";

    if (!name) {
      results.errors.push({ row: i + 1, email, usn, error: "Name is required" });
      continue;
    }
    if (!email) {
      results.errors.push({ row: i + 1, email, usn, error: "Email is required" });
      continue;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      results.errors.push({ row: i + 1, email, usn, error: "Invalid email format" });
      continue;
    }

    if (seenEmails.has(email)) {
      results.errors.push({ row: i + 1, email, usn, error: "Duplicate email in upload batch" });
      continue;
    }
    seenEmails.add(email);

    if (usn) {
      if (seenUsns.has(usn)) {
        results.errors.push({ row: i + 1, email, usn, error: "Duplicate USN in upload batch" });
        continue;
      }
      seenUsns.add(usn);
    }

    try {
      const existingEmail = await User.findOne({ email });
      if (existingEmail) {
        results.errors.push({ row: i + 1, email, usn, error: "Email already registered in system" });
        continue;
      }

      if (usn) {
        const existingUsn = await User.findOne({ usn });
        if (existingUsn) {
          results.errors.push({ row: i + 1, email, usn, error: "USN already registered in system" });
          continue;
        }
      }

      let plainPassword = userData.password || defaultPassword;
      if (!plainPassword) {
        plainPassword = Math.random().toString(36).substring(2, 10);
      }

      verifiedUsersToCreate.push({
        name,
        email,
        plainPassword,
        usn: usn || undefined,
        section: section || undefined
      });
    } catch (err) {
      results.errors.push({ row: i + 1, email, usn, error: `Validation error: ${err.message}` });
    }
  }

  if (verifiedUsersToCreate.length > 0) {
    await assertSeatCapacity(collegeId, verifiedUsersToCreate.length);
  }

  const createdIds = [];
  try {
    for (const userData of verifiedUsersToCreate) {
      const hashedPassword = await bcrypt.hash(userData.plainPassword, 10);
      const user = await User.create({
        name: userData.name,
        email: userData.email,
        password: hashedPassword,
        usn: userData.usn,
        section: userData.section,
        role: "student",
        collegeId: collegeId || undefined
      });

      createdIds.push(user._id);

      results.created.push({
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        usn: user.usn || null,
        section: user.section || null,
        role: user.role,
        password: userData.plainPassword
      });
      results.count++;
    }
  } catch (creationError) {
    console.error("Catastrophic error during bulk registration, rolling back...", creationError);
    if (createdIds.length > 0) {
      await User.deleteMany({ _id: { $in: createdIds } });
    }
    throw new HttpError(500, "Catastrophic error during bulk import. All modifications in this batch have been rolled back.");
  }

  return results;
}

// Fixed bcrypt hash of an unrelated, unguessable string — used only so bcrypt.compare
// always runs on an unknown-email login attempt, matching the cost of the real
// user.password comparison below. Without this, a nonexistent email short-circuits
// before bcrypt.compare and returns much faster than a wrong-password attempt on a real
// account, letting the ~50-100ms gap be used to enumerate valid emails even though both
// cases return identical error text.
const DUMMY_PASSWORD_HASH = "$2b$10$SHhjQgShaXsISHR6GrxOo.wWzSWSHx.SZEgIfGUxxS1BupxLT17ci";

export async function login({ email, password }, auditInfo = {}) {
  const user = await User.findOne({ email: email.toLowerCase() });

  const ok = await bcrypt.compare(password, user ? user.password : DUMMY_PASSWORD_HASH);
  if (!user || !ok) {
    await auditService.logEvent({
      event: "LOGIN_FAILED",
      collegeId: user?.collegeId || undefined,
      details: { email: email.toLowerCase() },
      ...auditInfo
    });
    throw new HttpError(401, "Invalid credentials", { message: "Invalid credentials" });
  }

  const token = jwt.sign(
    { id: user._id.toString(), role: user.role, email: user.email, name: user.name, collegeId: user.collegeId || null },
    env.JWT_SECRET,
    { expiresIn: "7d" }
  );

  await auditService.logEvent({
    event: "LOGIN_SUCCESS",
    userId: user._id,
    collegeId: user.collegeId || undefined,
    ...auditInfo
  });

  return { token, user: toPublicUser(user) };
}

export async function listUsers(query = {}, requestingUser) {
  const { search, role, page = 1, limit = 50 } = query;
  const filter = {};

  const scope = collegeScopeFor(requestingUser);
  if (scope) filter.collegeId = scope;

  if (search) {
    const safeSearch = escapeRegex(search);
    filter.$or = [
      { name: { $regex: safeSearch, $options: 'i' } },
      { email: { $regex: safeSearch, $options: 'i' } }
    ];
  }

  if (role) {
    filter.role = role;
  }

  const total = await User.countDocuments(filter);
  const users = await User.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .select('-password');

  return {
    users: users.map(toPublicUser),
    total,
    page: Number(page),
    totalPages: Math.ceil(total / limit)
  };
}

// Non-superadmin callers may only act on a target within their own college — a 404
// (not 403) so cross-college user IDs aren't distinguishable from nonexistent ones,
// matching the convention in assessments.repo.js's findById(id, collegeId).
function assertTargetInScope(targetUser, requestingUser) {
  const scope = collegeScopeFor(requestingUser);
  if (scope && String(targetUser.collegeId || '') !== String(scope)) {
    throw new HttpError(404, "User not found");
  }
}

export async function resetUserPassword(userId, newPassword, adminUser, auditInfo = {}) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, "User not found");
  assertTargetInScope(user, adminUser);

  const hashed = await bcrypt.hash(newPassword, 10);
  await User.updateOne({ _id: userId }, { password: hashed });

  await auditService.logEvent({
    event: "USER_PASSWORD_RESET",
    userId: adminUser._id,
    collegeId: adminUser.collegeId || undefined,
    details: { targetUserId: userId, targetEmail: user.email },
    ...auditInfo
  });

  return { msg: "Password reset successful" };
}

// Single-user seat-management counterpart to bulkRegister — for adding one user to an
// existing college outside the CSV/bulk-import flow (see
// docs/PLATFORM_AUDIT_AND_SAAS_ROADMAP.md Phase 2: "an admin console for seat-level
// management... is still open"). A non-superadmin caller is always scoped to their own
// college and can never assign the superadmin role (privilege escalation guard).
export async function adminCreateUser({ name, email, password, role, usn, section }, requestingUser, auditInfo = {}) {
  if (role === 'superadmin' && requestingUser.role !== 'superadmin') {
    throw new HttpError(403, "Forbidden", { message: "Only a superadmin can create a superadmin account" });
  }

  const scope = collegeScopeFor(requestingUser);
  const collegeId = scope || requestingUser.collegeId || undefined;

  const plainPassword = password || Math.random().toString(36).substring(2, 10);
  const { user } = await register({ name, email, password: plainPassword, role, collegeId, usn, section });

  await auditService.logEvent({
    event: "USER_CREATED",
    userId: requestingUser._id,
    collegeId: collegeId || undefined,
    details: { targetUserId: user.id, targetEmail: user.email, role: user.role },
    ...auditInfo
  });

  return { user, password: plainPassword };
}

export async function deleteUser(userId, requestingUser, auditInfo = {}) {
  const user = await User.findById(userId);
  if (!user) throw new HttpError(404, "User not found");
  assertTargetInScope(user, requestingUser);

  if (String(user._id) === String(requestingUser._id)) {
    throw new HttpError(400, "Cannot delete your own account");
  }
  if (user.role === 'superadmin' && requestingUser.role !== 'superadmin') {
    throw new HttpError(403, "Forbidden", { message: "Only a superadmin can delete a superadmin account" });
  }

  await User.deleteOne({ _id: userId });

  await auditService.logEvent({
    event: "USER_DELETED",
    userId: requestingUser._id,
    collegeId: requestingUser.collegeId || undefined,
    details: { targetUserId: userId, targetEmail: user.email },
    ...auditInfo
  });

  return { msg: "User deleted successfully" };
}
