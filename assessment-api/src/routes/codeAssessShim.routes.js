import express from "express";
import { env } from "../config/env.js";
import { apiClientAuth } from "../middleware/apiClient.mjs";
import { submitRawExecution, getRawExecution } from "../controllers/codeAssessShim.controller.js";

const router = express.Router();

// exam-platform's judge.js sends the shared secret as `x-rapidapi-key` (it's built to
// talk to a GO Judge/RapidAPI-shaped instance, not branded to this service) — deliberately
// not the `x-service-key` used by the /integration/* routes, so this key can be rotated
// independently. The header name itself lives in exam-platform's judge.js, not here —
// renaming it requires a coordinated change on that side too.
// Resolves an ApiClient from an `ak_...` key, still accepting the legacy global
// CODEASSESS_SHIM_KEY so existing callers keep working (plan Phase 1). The 401 body
// is kept exactly as it was: this is a public GO Judge-style surface and reshaping its
// error response would break clients written against this API.
const verifyCodeAssessKey = apiClientAuth({
  scope: "codeassess",
  extractKey: (req) => req.headers["x-rapidapi-key"],
  legacySecret: () => env.CODEASSESS_SHIM_KEY,
  legacyLabel: "CODEASSESS_SHIM_KEY",
  unauthorizedBody: { error: "Unauthorized" }
});
router.use(verifyCodeAssessKey);

router.post("/submissions", submitRawExecution);
router.get("/submissions/:token", getRawExecution);

export default router;
