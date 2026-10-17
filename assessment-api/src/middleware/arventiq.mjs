import crypto from "crypto";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";
import { apiClientAuth } from "./apiClient.mjs";
import User from "../../models/User.mjs";

const SERVICE_ACCOUNT_EMAIL = "arventiq-service@system.internal";

// Arventiq submissions have no per-candidate JWT — every request authenticates
// with the shared secret only, and is attributed to one shared service-account
// User (mirrors verifyService's mock user in integration.mjs, but this one is a
// real persisted User since Submission.userId is a required ref). Candidate/exam
// identity travels as opaque externalStudentId/externalAssessmentId metadata
// instead — see docs/arventiq-integration/PLAN.md §6.
let serviceUserIdPromise = null;

async function getOrCreateServiceUserId() {
  if (!serviceUserIdPromise) {
    serviceUserIdPromise = (async () => {
      const existing = await User.findOne({ email: SERVICE_ACCOUNT_EMAIL });
      if (existing) return existing._id;

      const placeholderPassword = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
      const created = await User.create({
        name: "Arventiq Service Account",
        email: SERVICE_ACCOUNT_EMAIL,
        password: placeholderPassword, // unreachable via login: verifyArventiq is shared-secret only, not password auth
        role: "admin"
      });
      return created._id;
    })().catch((err) => {
      // Don't cache a rejected promise — let the next request retry.
      serviceUserIdPromise = null;
      throw err;
    });
  }
  return serviceUserIdPromise;
}

// Resolves an ApiClient from an `ak_...` bearer token, still accepting the legacy
// global ARVENTIQ_SECRET so existing callers keep working (plan Phase 1).
const authenticateArventiq = apiClientAuth({
  scope: "arventiq",
  extractKey: (req) => {
    const authHeader = req.headers["authorization"] || "";
    return authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  },
  legacySecret: () => env.ARVENTIQ_SECRET,
  legacyLabel: "ARVENTIQ_SECRET",
  // Preserved verbatim - this surface has always answered with this body.
  unauthorizedBody: { success: false, message: "Unauthorized: invalid Arventiq credentials" }
});

export const verifyArventiq = (req, res, next) => {
  authenticateArventiq(req, res, async (err) => {
    if (err) return next(err);

    try {
      // Submission.userId is a required ref, so every call needs a User to own what
      // it creates. A real ApiClient carries its own serviceUserId, which is what
      // makes its submissions attributable; the legacy shared-secret path (and any
      // client provisioned before that field existed) falls back to the single
      // global service account - exactly the unattributable behaviour ApiClient
      // exists to replace.
      const serviceUserId = req.apiClient?.serviceUserId || (await getOrCreateServiceUserId());

      req.user = {
        _id: serviceUserId,
        id: serviceUserId.toString(),
        role: "admin",
        isService: true,
        isArventiq: true,
        apiClientId: req.apiClient ? req.apiClient._id : undefined
      };

      console.log(
        `[ARVENTIQ][REQ:${req.id}] ${req.method} ${req.originalUrl} | ` +
        `Client: ${req.apiClient ? `${req.apiClient.name} (${req.apiClient.keyPrefix})` : "legacy-shared-secret"} | ` +
        `Time: ${new Date().toISOString()}`
      );
      next();
    } catch (e) {
      next(e);
    }
  });
};
