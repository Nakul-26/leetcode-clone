import { env } from "./env.js";

// Shared by app.js (Express CORS) and realtime/signaling.js (Socket.IO CORS) so the
// allowlist can't drift between the two.
export function getAllowedOrigins() {
  const origins = env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  if (process.env.NODE_ENV !== "production") {
    origins.push("http://localhost:5173", "http://127.0.0.1:5173");
  }
  return origins;
}
