import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../app.js";
import * as authService from "./auth.service.js";
import UsageEvent from "../../models/UsageEvent.mjs";
import { getLanguageStats, MAX_DAYS, DEFAULT_DAYS } from "./languageStats.service.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

async function seed(language, elapsedList, extra = {}) {
  await UsageEvent.insertMany(
    elapsedList.map((elapsedMs) => ({ language, elapsedMs, status: "Accepted", createdAt: daysAgo(1), ...extra }))
  );
}

describe("getLanguageStats", () => {
  beforeEach(async () => {
    await UsageEvent.deleteMany({});
  });

  it("counts submissions, test cases, share and per-day averages per language", async () => {
    await seed("cpp", [100, 200, 300, 400], { testCount: 3, source: "queue" });
    await seed("python", [50, 60], { source: "raw-run" });

    const stats = await getLanguageStats({ days: 10, now: NOW });
    const cpp = stats.languages.find((l) => l.language === "cpp");
    const py = stats.languages.find((l) => l.language === "python");

    expect(stats.windowDays).toBe(10);
    expect(stats.totalSubmissions).toBe(6);
    expect(stats.totalPerDay).toBe(0.6);
    expect(cpp.submissions).toBe(4);
    expect(cpp.testCases).toBe(12);
    expect(cpp.perDay).toBe(0.4);
    expect(cpp.share).toBe(66.7);
    expect(py.testCases).toBe(2); // no testCount -> one execution each
    expect(cpp.sources).toEqual({ queue: 4 });
    expect(py.sources).toEqual({ "raw-run": 2 });
  });

  it("reports run time, exact percentiles and compute share, heaviest language first", async () => {
    const tenRuns = [10, 20, 30, 40, 50, 60, 70, 80, 90, 1000];
    await seed("java", tenRuns);
    await seed("python", [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);

    const { languages } = await getLanguageStats({ days: 30, now: NOW });
    const java = languages[0];

    expect(java.language).toBe("java"); // more total compute despite fewer submissions
    expect(java.avgElapsedMs).toBe(145);
    expect(java.p50ElapsedMs).toBe(50);
    expect(java.p95ElapsedMs).toBe(90);
    expect(java.maxElapsedMs).toBe(1000);
    expect(java.totalComputeMs).toBe(1450);
    expect(java.computeShare).toBeCloseTo((1450 / (1450 + 60)) * 100, 0);
    expect(languages[1].language).toBe("python");
  });

  it("splits outcomes by status and treats events without a source as queue traffic", async () => {
    await UsageEvent.insertMany([
      { language: "cpp", status: "Accepted", elapsedMs: 10, createdAt: daysAgo(1) },
      { language: "cpp", status: "Compilation Error", elapsedMs: 20, createdAt: daysAgo(1), source: "run" }
    ]);
    const [cpp] = (await getLanguageStats({ now: NOW })).languages;
    expect(cpp.statuses).toEqual({ Accepted: 1, "Compilation Error": 1 });
    expect(cpp.sources).toEqual({ queue: 1, run: 1 });
  });

  it("only counts events inside the window and clamps the window size", async () => {
    await seed("go", [10]);
    await UsageEvent.create({ language: "go", elapsedMs: 10, createdAt: daysAgo(40) });

    expect((await getLanguageStats({ days: 30, now: NOW })).totalSubmissions).toBe(1);
    expect((await getLanguageStats({ days: 60, now: NOW })).totalSubmissions).toBe(2);
    expect((await getLanguageStats({ days: "abc", now: NOW })).windowDays).toBe(DEFAULT_DAYS);
    expect((await getLanguageStats({ days: 0, now: NOW })).windowDays).toBe(DEFAULT_DAYS);
    expect((await getLanguageStats({ days: 99999, now: NOW })).windowDays).toBe(MAX_DAYS);
  });

  it("survives events with no run time and an empty window", async () => {
    expect((await getLanguageStats({ now: NOW })).languages).toEqual([]);
    await UsageEvent.create({ language: "ruby", status: "Error", createdAt: daysAgo(1) });
    const [ruby] = (await getLanguageStats({ now: NOW })).languages;
    expect(ruby.submissions).toBe(1);
    expect(ruby.avgElapsedMs).toBeNull();
    expect(ruby.p95ElapsedMs).toBeNull();
  });
});

describe("GET /api/admin/language-stats", () => {
  let superadmin, admin;

  beforeEach(async () => {
    superadmin = await authService.register({ name: "S", email: "s@lang.test", password: "password123", role: "superadmin" });
    admin = await authService.register({ name: "A", email: "a@lang.test", password: "password123", role: "admin" });
    await UsageEvent.create({ language: "cpp", elapsedMs: 100, status: "Accepted", createdAt: new Date() });
  });

  it("is superadmin only", async () => {
    const denied = await request(app).get("/api/admin/language-stats").set("Authorization", `Bearer ${admin.token}`);
    expect(denied.status).toBe(403);
    const anonymous = await request(app).get("/api/admin/language-stats");
    expect(anonymous.status).toBe(401);
  });

  it("returns the per-language table and honours ?days", async () => {
    const res = await request(app).get("/api/admin/language-stats?days=7").set("Authorization", `Bearer ${superadmin.token}`);
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(7);
    expect(res.body.languages[0]).toMatchObject({ language: "cpp", submissions: 1 });
  });
});
