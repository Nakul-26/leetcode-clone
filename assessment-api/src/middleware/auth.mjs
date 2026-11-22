import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { resolveSessionUser } from "../services/session.service.js";

// Cookie first (browser sessions, H8), then Authorization header fallback (external
// server-to-server callers - /api/integration/*, /api/codeAssess/* - never send cookies and
// must keep working unchanged).
function extractToken(req) {
  if (req.cookies?.token) return req.cookies.token;
  const authHeader = req.headers.authorization || "";
  return authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
}

// jwt.sign payloads (auth.service.js) key the user id as `id`, but every downstream
// consumer (services, repos, controllers) reads Mongoose's native `_id` for consistency
// with DB documents. This is the single place that bridges the two — all app code
// should read req.user._id, never req.user.id.
function normalizeUser(user) {
  if (user.id && !user._id) user._id = user.id;
  return user;
}

function decode(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET);
  } catch {
    return null;
  }
}

export async function verifyToken(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ message: "No token" });

  const decoded = decode(token);
  if (!decoded) return res.status(401).json({ message: "Invalid token" });

  // A valid signature is not enough: the account may since have been deleted or signed out
  // everywhere (session.service.js).
  const user = await resolveSessionUser(decoded);
  if (!user) return res.status(401).json({ message: "Session expired" });

  req.user = normalizeUser(user);
  next();
}

export async function optionalVerifyToken(req, res, next) {
  const token = extractToken(req);
  const decoded = token && decode(token);
  // An invalid or revoked optional token means anonymous.
  const user = decoded && (await resolveSessionUser(decoded));
  if (user) req.user = normalizeUser(user);
  next();
}

export function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };
}
