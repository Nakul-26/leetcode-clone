import { ipKeyGenerator } from "express-rate-limit";

// Who a rate limit counts against. Requests reach the API through Cloudflare, cloudflared and
// the frontend's nginx, and the app does not set "trust proxy", so req.ip is the proxy's
// address for every visitor: each limiter was one bucket shared by the whole site (100 logins
// per 15 minutes for everyone, and a load test could lock all users out of /api).
//
// Cloudflare sets CF-Connecting-IP to the visitor's address and overwrites any value the
// client sends. A request that skips Cloudflare (straight to a published host port) can set
// the header itself, which only lets it pick its own bucket; it falls back to req.ip when
// absent. ipKeyGenerator groups IPv6 addresses by /56 so one host can't rotate addresses.
export function rateLimitKey(req) {
  const header = req.headers["cf-connecting-ip"];
  const ip = (typeof header === "string" && header.trim()) || req.ip || "";
  return ipKeyGenerator(ip);
}

// Callers of the public judge API authenticate with an API key and are limited per key by
// admitApiClient (requests per minute and runs per month, set on the API Keys page). The
// per-IP general limiter on top capped a partner or the load test at 10,000 requests per
// 15 minutes whatever their key allowed.
export function isApiKeyJudgeRoute(req) {
  const url = req.originalUrl || req.url || "";
  return url.startsWith("/api/codeAssess") || url.startsWith("/api/v1/codeAssess");
}
