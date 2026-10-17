import { env } from "../config/env.js";
import { verifyToken } from "./auth.mjs";
import { apiClientAuth } from "./apiClient.mjs";

// Authenticates the testing-platform integration. Now resolves an ApiClient when
// an `ak_...` key is presented, and still accepts the legacy global
// TESTING_PLATFORM_KEY so existing callers keep working through the transition
// (plan Phase 1). The legacy path is logged as unattributable by apiClientAuth.
const authenticateIntegration = apiClientAuth({
  scope: "integration",
  extractKey: (req) => req.headers["x-service-key"],
  // Getter, not a value: env is read per request so tests that set it before
  // exercising a route still work, and a rotated secret takes effect without a
  // process restart.
  legacySecret: () => env.TESTING_PLATFORM_KEY,
  legacyLabel: "TESTING_PLATFORM_KEY",
  // Preserved verbatim — this surface has always answered with this body.
  unauthorizedBody: { success: false, message: "Unauthorized service" }
});

export const verifyService = (req, res, next) => {
  authenticateIntegration(req, res, (err) => {
    if (err) return next(err);

    // Set a mock user for service-to-service calls if not already set by verifyIntegrationStudent
    if (!req.user) {
      req.user = {
        role: "admin", // Services are treated as admin for backend-to-backend calls
        isService: true,
        // Carried so downstream can attribute the call when a real key was used.
        apiClientId: req.apiClient ? req.apiClient._id : undefined
      };
    }

    // Audit logging for integration requests
    console.log(
      `[INTEGRATION][REQ:${req.id}] Request from Testing Platform: ${req.method} ${req.originalUrl} | ` +
      `User: ${req.user?.id || req.user?._id || "service-only"} | ` +
      `Client: ${req.apiClient ? `${req.apiClient.name} (${req.apiClient.keyPrefix})` : "legacy-shared-secret"} | ` +
      `Time: ${new Date().toISOString()}`
    );

    next();
  });
};

export const verifyIntegrationStudent = (req, res, next) => {
  // We reuse the standard verifyToken logic to validate the student JWT
  // but we could add additional checks here if needed (e.g., 'aud' claim)
  return verifyToken(req, res, next);
};
