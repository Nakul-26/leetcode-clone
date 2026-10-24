import dotenv from "dotenv";

dotenv.config();

export const env = {
  PORT: process.env.PORT || 3000,
  MONGO_URI: process.env.MONGO_URI || "mongodb://mongo:27017",
  MONGO_DB_NAME: process.env.MONGO_DB_NAME || "assessment_db",
  REDIS_URI: process.env.REDIS_URI || "redis://localhost:6379",
  RABBITMQ_URI: process.env.RABBITMQ_URI || "amqp://localhost",
  JWT_SECRET: process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? null : "dev_secret_change_me"),
  TESTING_PLATFORM_KEY: process.env.TESTING_PLATFORM_KEY || (process.env.NODE_ENV === "production" ? null : "testing_platform_secret"),
  ARVENTIQ_SECRET: process.env.ARVENTIQ_SECRET || (process.env.NODE_ENV === "production" ? null : "arventiq_dev_secret"),
  // Shared secret for the GO Judge public API /codeAssess/submissions shim. Kept
  // separate from TESTING_PLATFORM_KEY so it can be rotated independently of the main
  // integration key, and because the caller sends it as `x-rapidapi-key` (it's
  // built to talk to a GO Judge-style instance), not `x-service-key`.
  CODEASSESS_SHIM_KEY: process.env.CODEASSESS_SHIM_KEY || (process.env.NODE_ENV === "production" ? null : "codeassess_shim_secret"),
  JUDGE_SERVICE_URL: process.env.JUDGE_SERVICE_URL || "http://judge-service-go:8081",
  // H5 fair-scheduling quota: submissions per college allowed within the rolling
  // window below, enforced in quota.service.js before a submission is queued.
  // Sized for inter-college fairness on a shared judge, not per-user throttling —
  // see STUDENT_SUBMISSION_QUOTA below for that. 30/60s was measured to be too
  // strict for a single college running a real exam (500 students sharing one
  // pool); raise via env, e.g. COLLEGE_SUBMISSION_QUOTA=300, once judge capacity
  // (container pool autoscaling, language mix) has been sized for that cohort —
  // see docker-compose.prod.yml's "Submission quota" section.
  COLLEGE_SUBMISSION_QUOTA: Number(process.env.COLLEGE_SUBMISSION_QUOTA) || 30,
  COLLEGE_SUBMISSION_QUOTA_WINDOW_SECONDS: Number(process.env.COLLEGE_SUBMISSION_QUOTA_WINDOW_SECONDS) || 60,
  // Per-student companion to the college-wide quota above: caps how much of the
  // (now much larger) shared college pool any single student can consume, so a
  // runaway auto-submit loop or one impatient student can't starve the other
  // 499 students in the same exam. Checked first in submissions.service.js so a
  // student hitting their own limit gets a clear, specific message rather than a
  // confusing "college quota exceeded".
  STUDENT_SUBMISSION_QUOTA: Number(process.env.STUDENT_SUBMISSION_QUOTA) || 10,
  STUDENT_SUBMISSION_QUOTA_WINDOW_SECONDS: Number(process.env.STUDENT_SUBMISSION_QUOTA_WINDOW_SECONDS) || 60,
  // Defaults for external API clients (plan Phase 4), applied when a client has no limit of its
  // own set. 0 means unlimited, so nothing changes until a limit is deliberately configured.
  // Counted in test cases, not requests: a batch of six is six.
  API_CLIENT_DEFAULT_RATE_PER_MIN: Number(process.env.API_CLIENT_DEFAULT_RATE_PER_MIN) || 0,
  API_CLIENT_DEFAULT_MONTHLY_QUOTA: Number(process.env.API_CLIENT_DEFAULT_MONTHLY_QUOTA) || 0,
  // Stuck-submission reaper (JUDGE_FIX_PLAN R8, stuckSubmissions.service.js). A row still
  // Pending this long after its last change is re-queued once, then marked Error. 15 min is
  // past the judge's own retry window (~7 min) plus the longest run. Set
  // STUCK_SUBMISSION_REAPER_ENABLED=false to turn it off.
  STUCK_SUBMISSION_REAPER_ENABLED: process.env.STUCK_SUBMISSION_REAPER_ENABLED !== "false",
  STUCK_SUBMISSION_AFTER_MINUTES: Number(process.env.STUCK_SUBMISSION_AFTER_MINUTES) || 15,
  STUCK_SUBMISSION_CHECK_SECONDS: Number(process.env.STUCK_SUBMISSION_CHECK_SECONDS) || 60,
  // Phase 2 billing (Stripe). Unlike the secrets above, these have no production
  // fail-fast guard on purpose: billing isn't live yet, so a missing key must not crash
  // the whole API. billing.service.js/stripe.js soft-fail (503) at call time instead.
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || null,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || null,
  STRIPE_PRICE_ID_PRO: process.env.STRIPE_PRICE_ID_PRO || null,
  BILLING_SUCCESS_URL: process.env.BILLING_SUCCESS_URL || null,
  BILLING_CANCEL_URL: process.env.BILLING_CANCEL_URL || null,
  // H8: browser-facing CORS allowlist for cookie-based auth (comma-separated origins).
  // No production default on purpose - there is no deployed frontend yet, so this stays
  // unset until one exists; set it then, no code change needed at that point.
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS || "",
  // Phase C notifications (SMTP via nodemailer) - optional, same soft-fail-when-unconfigured
  // pattern as Stripe above: no live mail provider yet, so these have no production
  // fail-fast. notification.service.js/mailer.js no-op instead of throwing when unset.
  SMTP_HOST: process.env.SMTP_HOST || null,
  SMTP_PORT: Number(process.env.SMTP_PORT) || 587,
  SMTP_USER: process.env.SMTP_USER || null,
  SMTP_PASS: process.env.SMTP_PASS || null,
  SMTP_FROM: process.env.SMTP_FROM || null,
  // Base URL of the deployed frontend, used to build links embedded in emails (e.g. an
  // external interviewer's signed access link). No production default for the same reason
  // as CORS_ALLOWED_ORIGINS - unset until a frontend is actually deployed against this API.
  APP_BASE_URL: process.env.APP_BASE_URL || "http://localhost:5173"
};

if (process.env.NODE_ENV === "production" && !env.JWT_SECRET) {
  throw new Error("FATAL: JWT_SECRET is required in production environment");
}

if (process.env.NODE_ENV === "production" && !env.TESTING_PLATFORM_KEY) {
  throw new Error("FATAL: TESTING_PLATFORM_KEY is required in production environment");
}

if (process.env.NODE_ENV === "production" && !env.ARVENTIQ_SECRET) {
  throw new Error("FATAL: ARVENTIQ_SECRET is required in production environment");
}

if (process.env.NODE_ENV === "production" && !env.CODEASSESS_SHIM_KEY) {
  throw new Error("FATAL: CODEASSESS_SHIM_KEY is required in production environment");
}
