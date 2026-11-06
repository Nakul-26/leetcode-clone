import { describe, it, expect } from "vitest";
import http from "node:http";
import express from "express";
import rateLimit from "express-rate-limit";
import { rateLimitKey, isApiKeyJudgeRoute } from "./rateLimitKey.js";

const req = (headers = {}, ip = "172.18.0.5", originalUrl = "/api/v1/problems") => ({ headers, ip, originalUrl });

describe("rateLimitKey", () => {
  it("counts each visitor separately behind the proxy", () => {
    expect(rateLimitKey(req({ "cf-connecting-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(rateLimitKey(req({ "cf-connecting-ip": "203.0.113.8" }))).toBe("203.0.113.8");
  });

  it("falls back to the socket address without Cloudflare's header", () => {
    expect(rateLimitKey(req({}))).toBe("172.18.0.5");
    expect(rateLimitKey(req({ "cf-connecting-ip": "  " }))).toBe("172.18.0.5");
  });

  it("groups IPv6 visitors by subnet", () => {
    expect(rateLimitKey(req({ "cf-connecting-ip": "2001:db8:1:2::1" })))
      .toBe(rateLimitKey(req({ "cf-connecting-ip": "2001:db8:1:2::ffff" })));
  });
});

describe("isApiKeyJudgeRoute", () => {
  it("matches only the public judge API", () => {
    expect(isApiKeyJudgeRoute(req({}, "", "/api/codeAssess/submissions?wait=true"))).toBe(true);
    expect(isApiKeyJudgeRoute(req({}, "", "/api/v1/codeAssess/submissions/batch"))).toBe(true);
    expect(isApiKeyJudgeRoute(req({}, "", "/api/v1/problems"))).toBe(false);
    expect(isApiKeyJudgeRoute(req({}, "", "/api/auth/login"))).toBe(false);
  });
});

describe("a limiter keyed by rateLimitKey", () => {
  // One limiter, two visitors behind the same proxy: the second must not inherit the first's count.
  it("limits one visitor without blocking another", async () => {
    const app = express();
    app.use(rateLimit({ windowMs: 60_000, max: 2, keyGenerator: rateLimitKey, skip: isApiKeyJudgeRoute }));
    app.all(/.*/, (q, r) => r.json({ ok: true }));
    const server = app.listen(0);
    const port = server.address().port;
    // node:http, not fetch: the test setup replaces the global fetch.
    const hit = (ip, path = "/api/v1/problems") =>
      new Promise((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path, headers: { "cf-connecting-ip": ip } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on("error", reject);
      });
    try {
      expect([await hit("198.51.100.1"), await hit("198.51.100.1"), await hit("198.51.100.1")]).toEqual([200, 200, 429]);
      expect(await hit("198.51.100.2")).toBe(200);
      // The judge API is governed by per-key limits, not this one.
      expect(await hit("198.51.100.1", "/api/codeAssess/submissions")).toBe(200);
    } finally {
      server.close();
    }
  });
});
