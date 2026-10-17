import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";
import routes from "./routes/index.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { getAllowedOrigins } from "./config/corsOrigins.js";

import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./config/swagger.js";

const app = express();

// Sets X-Frame-Options, Content-Security-Policy, X-Content-Type-Options, HSTS, etc.
// This is a JSON API with no server-rendered HTML, so helmet's defaults are safe as-is.
app.use(helmet());

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10000, // Increased for load testing
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100, // Still reasonably strict for auth
  message: "Too many attempts, please try again after 15 minutes",
  standardHeaders: true,
  legacyHeaders: false,
});

const integrationLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10000, // High limit for the testing platform integration
  message: "Too many integration requests, applying backpressure",
  standardHeaders: true,
  legacyHeaders: false,
});

const arventiqLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10000, // High limit — same rationale as integrationLimiter
  message: "Too many Arventiq requests, applying backpressure",
  standardHeaders: true,
  legacyHeaders: false,
});

// Public, unauthenticated route (external interviewer's signed link) — stricter than
// generalLimiter since there's no account behind it to hold accountable.
const interviewLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: "Too many requests, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
});

app.use((req, res, next) => {
  req.id = req.headers["x-request-id"] || uuidv4();
  res.setHeader("x-request-id", req.id);
  console.log(`[REQ:${req.id}] 📥 Incoming request: ${req.method} , ${req.url}`);
  // console.log("👉 Headers:", req.headers.origin); // Less spammy logs
  if (req.body && Object.keys(req.body).length > 0) {
    // console.log("👉 Body:", req.body);
  }
  next();
});

// H8: explicit allowlist rather than origin:"*" (which browsers reject outright when
// combined with credentials:true - the combination previously here was silently a no-op
// for any credentialed/cookie request). No hardcoded production origin: there is no
// deployed frontend yet, so CORS_ALLOWED_ORIGINS stays unset until one exists - see
// docs/PLATFORM_AUDIT_AND_SAAS_ROADMAP.md, H8.
const allowedOrigins = getAllowedOrigins();

const corsOptions = {
  origin(origin, callback) {
    // No Origin header at all = same-origin or a non-browser client (curl, server-to-server
    // integrations) - always allowed, since CORS is a browser-enforced concept only.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  optionsSuccessStatus: 200,
  credentials: true
};

app.use(cors(corsOptions));
app.use(cookieParser());
// H8 CSRF mitigation: SameSite=Lax on the auth cookie is the primary defense (blocks it
// being sent on cross-site subrequests). This is a lightweight second layer - a bare
// cross-site HTML form can't set custom headers, but axios/fetch from our own frontend
// can, so state-changing requests authenticated via the cookie must carry this header.
// Bearer-header callers (integration/codeAssess partners) never hit this, since they don't
// send the cookie in the first place.
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
app.use((req, res, next) => {
  if (
    STATE_CHANGING_METHODS.has(req.method) &&
    req.cookies?.token &&
    req.headers["x-requested-with"] !== "XMLHttpRequest"
  ) {
    return res.status(403).json({ message: "Missing required request header" });
  }
  next();
});
// The CodeAssess shim carries base64 source+stdin payloads that can comfortably exceed
// the platform's normal 100kb request cap; give it its own, larger limit before the
// general parser below runs (body-parser skips re-parsing an already-consumed body).
app.use("/api/codeAssess", express.json({ limit: "2mb" }));
app.use("/api/v1/codeAssess", express.json({ limit: "2mb" }));
// Stripe webhook signature verification needs the raw, unparsed body — mounted ahead
// of the general express.json() below for the same reason as the codeAssess shim above.
app.use("/api/billing/webhook", express.raw({ type: "application/json" }));
app.use("/api/v1/billing/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// Swagger Documentation
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Versioned Routes
app.use("/api/v1/auth", authLimiter);
app.use("/api/v1/integration", integrationLimiter);
app.use("/api/v1/arventiq", arventiqLimiter);
app.use("/api/v1/interview-slots/external", interviewLinkLimiter);
app.use("/api/v1", generalLimiter);
app.use("/api/v1", routes);

// Backward Compatibility / Default Prefix
app.use("/api/auth", authLimiter);
app.use("/api/integration", integrationLimiter);
app.use("/api/interview-slots/external", interviewLinkLimiter);
app.use("/api", generalLimiter);
app.use("/api", routes);

app.get("/", (req, res) => {
  res.json({
    message: "Assessment Microservice API",
    version: "1.0.0",
    docs: "/api-docs",
    v1: "/api/v1"
  });
});

app.use(errorHandler);

export default app;
