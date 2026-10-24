import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";

// A counter-capable stand-in for Redis. The shared test setup mocks the client with get/set
// only, which makes every INCR throw and every quota fail open, so it cannot test enforcement.
// vi.hoisted because vi.mock factories run before the rest of the module.
const { store, fakeRedis } = vi.hoisted(() => {
  const store = new Map();
  const fakeRedis = {
    failNext: false,
    async incrBy(key, n) {
      if (fakeRedis.failNext) { fakeRedis.failNext = false; throw new Error("redis down"); }
      store.set(key, (Number(store.get(key)) || 0) + n);
      return store.get(key);
    },
    async decrBy(key, n) { store.set(key, (Number(store.get(key)) || 0) - n); return store.get(key); },
    async expire() { return 1; },
    async exists(key) { return store.has(key) ? 1 : 0; },
    async get(key) { return store.has(key) ? String(store.get(key)) : null; },
    async set(key, value, opts = {}) {
      if (opts.condition === "NX" && store.has(key)) return null;
      store.set(key, key.startsWith("apiclient_") ? Number(value) : value);
      return "OK";
    },
    async del(key) { store.delete(key); return 1; }
  };
  return { store, fakeRedis };
});

vi.mock("../config/redis.js", () => ({
  initRedis: vi.fn().mockResolvedValue(fakeRedis),
  getRedis: () => fakeRedis
}));

vi.mock("../services/evaluation.service.js", () => ({
  INTERACTIVE_QUEUE_NAME: "submission_queue_fast",
  publishSubmissionMessage: vi.fn().mockResolvedValue(undefined)
}));

import app from "../app.js";
import { publishSubmissionMessage } from "../services/evaluation.service.js";
import { admitApiClient, monthlyUsageFromDb } from "../services/apiClientQuota.service.js";
import { submitSolution } from "../services/submissions.service.js";
import * as authService from "../services/auth.service.js";
import User from "../../models/User.mjs";
import College from "../../models/College.mjs";
import ApiClient from "../../models/ApiClient.mjs";
import Submission from "../../models/Submission.mjs";
import UsageEvent from "../../models/UsageEvent.mjs";
import Problem from "../../models/Problem.mjs";

const b64 = (s) => Buffer.from(s).toString("base64");
const item = (stdin) => ({ language_id: 71, source_code: b64("print(input())"), stdin: b64(stdin) });
const counterFor = (prefix) => [...store.entries()].filter(([k]) => k.startsWith(prefix));

describe("Per-API-client admission control (plan Phase 4)", () => {
  let collegeA, collegeB, adminA, adminB, superadmin;

  const makeClient = async (limits = {}, college = collegeA) => {
    const admin = college === collegeA ? adminA : adminB;
    const res = await request(app).post("/api/admin/api-clients").set("Authorization", `Bearer ${admin.token}`)
      .send({ name: "client", scopes: ["codeassess", "integration"], ...limits });
    return { key: res.body.key, id: res.body.client._id };
  };

  beforeEach(async () => {
    store.clear();
    fakeRedis.failNext = false;
    await Promise.all([User, College, ApiClient, Submission, UsageEvent, Problem].map((m) => m.deleteMany({})));
    publishSubmissionMessage.mockReset();
    publishSubmissionMessage.mockResolvedValue(undefined);

    collegeA = await College.create({ name: "A", slug: "a" });
    collegeB = await College.create({ name: "B", slug: "b" });
    adminA = await authService.register({ name: "A", email: "a@t.com", password: "password123", role: "admin", collegeId: collegeA._id });
    adminB = await authService.register({ name: "B", email: "b@t.com", password: "password123", role: "admin", collegeId: collegeB._id });
    superadmin = await authService.register({ name: "S", email: "s@t.com", password: "password123", role: "superadmin" });
  });

  describe("admitApiClient", () => {
    it("does nothing when no limit is set, so existing clients are unaffected", async () => {
      const { id } = await makeClient();
      for (let i = 0; i < 50; i++) expect((await admitApiClient(id, 5)).allowed).toBe(true);
      expect(store.size).toBe(0);
    });

    it("counts test cases, not requests, against the per-minute limit", async () => {
      const { id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { rateLimitPerMin: 5 });

      expect((await admitApiClient(id, 3)).allowed).toBe(true);
      const second = await admitApiClient(id, 3);
      expect(second).toMatchObject({ allowed: false, code: "rate_limited" });
      expect(second.retryAfter).toBeGreaterThanOrEqual(1);
      expect(second.retryAfter).toBeLessThanOrEqual(60);
      // The refused request left nothing behind.
      expect((await admitApiClient(id, 2)).allowed).toBe(true);
    });

    it("tells a caller whose single request is larger than the limit that waiting will not help", async () => {
      const { id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { rateLimitPerMin: 4 });
      const r = await admitApiClient(id, 5);
      expect(r).toMatchObject({ allowed: false, code: "exceeds_rate_limit" });
      expect(r.retryAfter).toBeUndefined();
    });

    it("enforces the monthly quota and reports when the month rolls over", async () => {
      const { id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { monthlyQuota: 5 });

      expect((await admitApiClient(id, 3)).allowed).toBe(true);
      const over = await admitApiClient(id, 3);
      expect(over).toMatchObject({ allowed: false, code: "monthly_quota_exceeded" });
      expect(over.retryAfter).toBeGreaterThan(0);
      expect((await admitApiClient(id, 2)).allowed).toBe(true);
    });

    it("seeds the monthly counter from the durable record, so a Redis restart is not a fresh month", async () => {
      const { id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { monthlyQuota: 5 });
      await UsageEvent.create({ apiClientId: id, collegeId: collegeA._id, testCount: 4 });
      await UsageEvent.create({ apiClientId: id, collegeId: collegeA._id }); // legacy row: one execution
      expect(await monthlyUsageFromDb(new (await import("mongoose")).default.Types.ObjectId(id))).toBe(5);

      // Five already used, nothing in Redis: the very next unit must be refused.
      expect((await admitApiClient(id, 1)).code).toBe("monthly_quota_exceeded");
    });

    it("ignores usage from other clients and from earlier months when seeding", async () => {
      const a = await makeClient();
      const b = await makeClient();
      await ApiClient.updateOne({ _id: a.id }, { monthlyQuota: 3 });
      await UsageEvent.create({ apiClientId: b.id, collegeId: collegeA._id, testCount: 50 });
      const lastMonth = new Date(); lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
      await UsageEvent.create({ apiClientId: a.id, collegeId: collegeA._id, testCount: 50, createdAt: lastMonth });
      expect((await admitApiClient(a.id, 3)).allowed).toBe(true);
    });

    it("returns the monthly units when the rate limit then refuses the request", async () => {
      const { id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { rateLimitPerMin: 1, monthlyQuota: 10 });
      expect((await admitApiClient(id, 1)).allowed).toBe(true);
      expect((await admitApiClient(id, 1)).code).toBe("rate_limited");
      const [[, monthly]] = counterFor("apiclient_monthly:");
      expect(monthly).toBe(1); // not 2: the refused request did no work
    });

    it("refund() gives the units back, in full or in part", async () => {
      const { id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { rateLimitPerMin: 10 });
      const a = await admitApiClient(id, 6);
      await a.refund(2);
      expect(counterFor("apiclient_rate:")[0][1]).toBe(4);
      await a.refund();
      expect(counterFor("apiclient_rate:")[0][1]).toBe(0);
    });

    it("fails open if Redis errors, rather than taking the judge down with the counter", async () => {
      const { id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { rateLimitPerMin: 1 });
      fakeRedis.failNext = true;
      expect((await admitApiClient(id, 1)).allowed).toBe(true);
    });
  });

  describe("GO Judge public API surface", () => {
    const post = (key, body, path = "/api/codeAssess/submissions?base64_encoded=true") =>
      request(app).post(path).set("x-rapidapi-key", key).send(body);

    it("answers 429 with Retry-After and a machine-readable code, and queues nothing", async () => {
      const { key, id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { rateLimitPerMin: 1 });

      expect((await post(key, item("1"))).status).toBe(201);
      const res = await post(key, item("2"));
      expect(res.status).toBe(429);
      expect(res.body.code).toBe("rate_limited");
      expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(publishSubmissionMessage).toHaveBeenCalledTimes(1);
      expect(await Submission.countDocuments({})).toBe(1);
    });

    it("admits or refuses a whole batch together, counted in test cases", async () => {
      const { key, id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { rateLimitPerMin: 5 });

      const batch = (n) => post(key, { submissions: Array.from({ length: n }, (_, i) => item(String(i))) }, "/api/codeAssess/submissions/batch?base64_encoded=true");
      expect((await batch(3)).status).toBe(201);
      const refused = await batch(3);
      expect(refused.status).toBe(429);
      expect(publishSubmissionMessage).toHaveBeenCalledTimes(1); // the second batch queued nothing
      expect((await batch(6)).status).toBe(422); // larger than the limit: retrying is pointless
    });

    it("does not charge for items it refused individually, or for a queue failure", async () => {
      const { key, id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { rateLimitPerMin: 4 });

      const mixed = await post(key, { submissions: [item("1"), { language_id: 71 }, { ...item("3"), language_id: 9999 }] },
        "/api/codeAssess/submissions/batch?base64_encoded=true");
      expect(mixed.status).toBe(201);
      // Only the one valid item was admitted and ran.
      expect(counterFor("apiclient_rate:")[0][1]).toBe(1);

      publishSubmissionMessage.mockRejectedValue(Object.assign(new Error("down"), { status: 503 }));
      expect((await post(key, item("x"))).status).toBeGreaterThanOrEqual(500);
      expect(counterFor("apiclient_rate:")[0][1]).toBe(1); // the failed enqueue was refunded
    });

    it("leaves shared-secret callers unmetered, as documented", async () => {
      for (let i = 0; i < 5; i++) {
        const r = await request(app).post("/api/codeAssess/submissions?base64_encoded=true&wait=true")
          .set("x-rapidapi-key", "codeassess_shim_secret").send({ language_id: 71, source_code: b64("print(1)") });
        expect(r.status).toBe(200);
      }
      expect(store.size).toBe(0);
    });
  });

  describe("submitSolution (shared by /integration, /arventiq and the frontend)", () => {
    let problem, studentId;
    beforeEach(async () => {
      problem = await Problem.create({
        title: "Add", description: "d", difficulty: "Easy", functionName: "add",
        returnType: "number", parameters: [{ name: "a", type: "number" }],
        testCases: [{ inputs: [1], expected: 2, isSample: true }]
      });
      studentId = (await User.create({ name: "s", email: "st@t.com", password: "x", role: "student", collegeId: collegeA._id }))._id;
    });

    const submit = (apiClientId) =>
      submitSolution({ problemId: String(problem._id), code: "def add(a): return a", language: "python", userId: studentId, collegeId: collegeA._id, apiClientId });

    it("refuses with a 429 carrying retryAfter once the client is over its limit", async () => {
      const { id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { rateLimitPerMin: 1 });
      await submit(id);
      const err = await submit(id).catch((e) => e);
      expect(err.status).toBe(429);
      expect(err.body.code).toBe("rate_limited");
      expect(err.retryAfter).toBeGreaterThanOrEqual(1);
      expect(publishSubmissionMessage).toHaveBeenCalledTimes(1);
    });

    it("returns the unit when the submission fails to enqueue", async () => {
      const { id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { rateLimitPerMin: 1 });
      publishSubmissionMessage.mockRejectedValueOnce(Object.assign(new Error("down"), { status: 503 }));
      await expect(submit(id)).rejects.toMatchObject({ status: 503 });
      // The row created before the failed publish must not be left Pending forever.
      expect(await Submission.countDocuments({ status: "Pending" })).toBe(0);
      expect(await Submission.countDocuments({ status: "Error" })).toBe(1);
      await expect(submit(id)).resolves.toHaveProperty("submission"); // the failed attempt was not charged
    });

    it("does not meter traffic with no API client (the frontend)", async () => {
      await submit(undefined);
      await submit(undefined);
      expect(store.size).toBe(0);
    });
  });

  describe("admin controls", () => {
    const patch = (token, id, body) =>
      request(app).patch(`/api/admin/api-clients/${id}`).set("Authorization", `Bearer ${token}`).send(body);

    it("lets an admin set limits and reads them back", async () => {
      const { id } = await makeClient();
      const res = await patch(adminA.token, id, { rateLimitPerMin: 120, monthlyQuota: 50000 });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ rateLimitPerMin: 120, monthlyQuota: 50000 });
    });

    it("rejects limits that would silently break enforcement", async () => {
      const { id } = await makeClient();
      for (const bad of [{ rateLimitPerMin: -1 }, { monthlyQuota: 1.5 }, { rateLimitPerMin: "lots" }, { scopes: ["root"] }, { scopes: [] }, { name: "  " }]) {
        expect((await patch(adminA.token, id, bad)).status).toBe(400);
      }
    });

    it("does not let one college edit or read another's client, and 404s rather than 403s", async () => {
      const { id } = await makeClient({}, collegeB);
      expect((await patch(adminA.token, id, { monthlyQuota: 1 })).status).toBe(404);
      expect((await request(app).get(`/api/admin/api-clients/${id}/usage`).set("Authorization", `Bearer ${adminA.token}`)).status).toBe(404);
      expect((await ApiClient.findById(id)).monthlyQuota).toBe(0);
    });

    it("cannot move a client to another college or swap its key", async () => {
      const { id } = await makeClient();
      const before = await ApiClient.findById(id);
      await patch(adminA.token, id, { collegeId: String(collegeB._id), keyHash: "x", active: false });
      const after = await ApiClient.findById(id);
      expect(String(after.collegeId)).toBe(String(collegeA._id));
      expect(after.keyHash).toBe(before.keyHash);
      expect(after.active).toBe(true);
    });

    it("reports consumption from the durable record", async () => {
      const { id } = await makeClient();
      await patch(adminA.token, id, { monthlyQuota: 100, rateLimitPerMin: 10 });
      await UsageEvent.create({ apiClientId: id, collegeId: collegeA._id, testCount: 6 });
      await UsageEvent.create({ apiClientId: id, collegeId: collegeA._id, testCount: 6 });
      const res = await request(app).get(`/api/admin/api-clients/${id}/usage`).set("Authorization", `Bearer ${adminA.token}`);
      expect(res.status).toBe(200);
      expect(res.body.usage).toMatchObject({ usedThisMonth: 12, monthlyQuota: 100, remainingThisMonth: 88, rateLimitPerMin: 10 });
    });

    it("keeps queue stats superadmin-only and survives an unreadable broker", async () => {
      expect((await request(app).get("/api/admin/queue-stats").set("Authorization", `Bearer ${adminA.token}`)).status).toBe(403);

      const { id } = await makeClient();
      await UsageEvent.create({ apiClientId: id, collegeId: collegeA._id, testCount: 6 });
      const res = await request(app).get("/api/admin/queue-stats").set("Authorization", `Bearer ${superadmin.token}`);
      expect(res.status).toBe(200);
      // The test broker cannot be inspected: depth is null (unknown), which is not 0 (empty).
      expect(res.body.queues.bulk).toBeNull();
      expect(res.body.clients[0]).toMatchObject({ testCases: 6, executions: 1 });
    });
  });
  describe("test-case check (P12)", () => {
    const check = (key, n) => request(app)
      .post("/api/codeAssess/test-cases/check?base64_encoded=false")
      .set("x-rapidapi-key", key)
      .send({ language_id: 71, source_code: "print(input())", test_cases: Array.from({ length: n }, (_, i) => ({ stdin: `${i}` })) });

    it("is metered per test case, like a run", async () => {
      const { key, id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { rateLimitPerMin: 3 });

      expect((await check(key, 4)).body.code).toBe("exceeds_rate_limit");
      expect((await check(key, 2)).status).toBe(200);
      const over = await check(key, 2);
      expect(over.status).toBe(429);
      expect(over.body.code).toBe("rate_limited");
    });

    it("gives the units back when the request is refused before running", async () => {
      const { key, id } = await makeClient();
      await ApiClient.updateOne({ _id: id }, { rateLimitPerMin: 3 });
      const bad = await request(app)
        .post("/api/codeAssess/test-cases/check?base64_encoded=false")
        .set("x-rapidapi-key", key)
        .send({ language_id: 999, source_code: "x", test_cases: [{ stdin: "" }, { stdin: "" }, { stdin: "" }] });
      expect(bad.status).toBe(400);
      expect((await check(key, 3)).status).toBe(200);
    });
  });
});
