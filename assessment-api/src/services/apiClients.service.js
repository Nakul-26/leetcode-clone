import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import ApiClient from "../../models/ApiClient.mjs";
import User from "../../models/User.mjs";
import { generateApiKey } from "../utils/apiKey.js";
import { HttpError } from "../utils/HttpError.js";

const VALID_SCOPES = ["integration", "arventiq", "codeassess"];

// Same convention as assessments/audit services: superadmin sees everything,
// everyone else is pinned to their own college.
function collegeScopeFor(user) {
  if (!user || user.role === "superadmin") return undefined;
  return user.collegeId || undefined;
}

// A client's submissions need an owning User because Submission.userId is a
// required ref. One per client rather than one globally, so submissions stay
// attributable — that is the whole point of ApiClient.
async function createServiceUser({ name, keyPrefix, collegeId }) {
  const placeholderPassword = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  return User.create({
    name: `API Client: ${name}`,
    // Unreachable as a login: the address is synthetic and the password is random
    // material that is never shown to anyone, including the client's owner.
    email: `apiclient-${keyPrefix}@system.internal`,
    password: placeholderPassword,
    role: "admin",
    collegeId
  });
}

/**
 * Issues a new API key. The plaintext key is returned exactly once, here, and is
 * never recoverable afterwards — only its sha256 is stored.
 */
export async function createApiClient(
  { name, scopes = [], collegeId: requestedCollegeId, rateLimitPerMin = 0, monthlyQuota = 0 } = {},
  requestingUser
) {
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new HttpError(400, "name is required");
  }

  const invalid = (Array.isArray(scopes) ? scopes : []).filter((s) => !VALID_SCOPES.includes(s));
  if (invalid.length > 0) {
    throw new HttpError(400, `Invalid scope(s): ${invalid.join(", ")}. Valid: ${VALID_SCOPES.join(", ")}`);
  }
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new HttpError(400, "At least one scope is required");
  }

  // collegeId comes from the caller's own claim, never from the request body —
  // accepting it from the body is the injection bug already fixed twice in this
  // codebase (bulk-import-students, questions). Only a superadmin may name a
  // college other than their own.
  const scope = collegeScopeFor(requestingUser);
  let collegeId = scope;
  if (requestingUser?.role === "superadmin") {
    if (!requestedCollegeId) throw new HttpError(400, "collegeId is required when issuing as superadmin");
    if (!mongoose.Types.ObjectId.isValid(String(requestedCollegeId))) {
      throw new HttpError(400, "collegeId is not a valid id");
    }
    collegeId = requestedCollegeId;
  }
  if (!collegeId) throw new HttpError(400, "Issuing user has no college to attribute this key to");

  const { key, keyPrefix, keyHash } = generateApiKey();
  const serviceUser = await createServiceUser({ name: name.trim(), keyPrefix, collegeId });

  const client = await ApiClient.create({
    name: name.trim(),
    keyPrefix,
    keyHash,
    collegeId,
    serviceUserId: serviceUser._id,
    scopes,
    rateLimitPerMin: Number(rateLimitPerMin) || 0,
    monthlyQuota: Number(monthlyQuota) || 0
  });

  return { client: present(client), key };
}

export async function listApiClients(requestingUser) {
  const filter = {};
  const scope = collegeScopeFor(requestingUser);
  if (scope) filter.collegeId = scope;
  const clients = await ApiClient.find(filter).sort({ createdAt: -1 }).limit(500);
  return clients.map(present);
}

/**
 * Revokes a key. Deactivates rather than deletes, so existing submissions keep a
 * resolvable apiClientId and historical usage stays attributable for billing.
 */
export async function revokeApiClient(id, requestingUser) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    throw new HttpError(404, "API client not found");
  }
  const filter = { _id: id };
  const scope = collegeScopeFor(requestingUser);
  if (scope) filter.collegeId = scope;

  const client = await ApiClient.findOne(filter);
  // 404 rather than 403 for a key belonging to another college: a 403 would
  // confirm the id exists, which is itself a cross-tenant leak.
  if (!client) throw new HttpError(404, "API client not found");

  client.active = false;
  client.revokedAt = new Date();
  await client.save();
  return present(client);
}

// keyHash never leaves the server; keyPrefix is the safe handle for display.
function present(c) {
  return {
    _id: c._id,
    name: c.name,
    keyPrefix: c.keyPrefix,
    collegeId: c.collegeId,
    scopes: c.scopes,
    rateLimitPerMin: c.rateLimitPerMin,
    monthlyQuota: c.monthlyQuota,
    active: c.active,
    lastUsedAt: c.lastUsedAt,
    revokedAt: c.revokedAt,
    createdAt: c.createdAt
  };
}
