import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";

vi.mock("../services/evaluation.service.js", () => ({
  INTERACTIVE_QUEUE_NAME: "submission_queue_fast",
  publishSubmissionMessage: vi.fn().mockResolvedValue(undefined)
}));

import app from "../app.js";
import { publishSubmissionMessage } from "../services/evaluation.service.js";
import * as authService from "../services/auth.service.js";
import User from "../../models/User.mjs";
import College from "../../models/College.mjs";
import ApiClient from "../../models/ApiClient.mjs";
import Submission from "../../models/Submission.mjs";

const b64 = (s) => Buffer.from(s).toString("base64");
const unb64 = (s) => Buffer.from(s, "base64").toString();
const item = (stdin, source = "print(input())", extra = {}) =>
  ({ language_id: 71, source_code: b64(source), stdin: b64(stdin), ...extra });

describe("Batch endpoint: same-source coalescing", () => {
  let key, otherKey;

  const issue = async (token, name) =>
    (await request(app).post("/api/admin/api-clients").set("Authorization", `Bearer ${token}`)
      .send({ name, scopes: ["codeassess"] })).body.key;

  beforeEach(async () => {
    await User.deleteMany({}); await College.deleteMany({});
    await ApiClient.deleteMany({}); await Submission.deleteMany({});
    publishSubmissionMessage.mockReset();
    publishSubmissionMessage.mockResolvedValue(undefined);

    const college = await College.create({ name: "C", slug: "c" });
    const admin = await authService.register({
      name: "A", email: "a@test.com", password: "password123", role: "admin", collegeId: college._id
    });
    key = await issue(admin.token, "one");
    otherKey = await issue(admin.token, "two");
  });

  const post = (k, submissions, qs = "?base64_encoded=true") =>
    request(app).post(`/api/codeAssess/submissions/batch${qs}`).set("x-rapidapi-key", k).send({ submissions });
  const get = (k, tokens) =>
    request(app).get(`/api/codeAssess/submissions/batch?tokens=${tokens.join(",")}`).set("x-rapidapi-key", k);

  it("compiles once: identical source becomes one submission with one test per item", async () => {
    const res = await post(key, [item("1"), item("2"), item("3")]);
    expect(res.status).toBe(201);

    expect(publishSubmissionMessage).toHaveBeenCalledTimes(1);
    const [msg] = publishSubmissionMessage.mock.calls[0];
    expect(msg.tests.map((t) => t.inputs[0])).toEqual(["1", "2", "3"]);
    expect(await Submission.countDocuments({ kind: "adhoc" })).toBe(1);

    // Every item still gets its own token, in request order.
    const id = msg.submissionId;
    expect(res.body).toEqual([{ token: `${id}.0` }, { token: `${id}.1` }, { token: `${id}.2` }]);
  });

  it("does not coalesce different sources, languages or limits", async () => {
    await post(key, [
      item("a", "print(1)"), item("b", "print(2)"),
      { ...item("c", "print(1)"), language_id: 63 },
      item("d", "print(1)", { cpu_time_limit: 2 })
    ]);
    expect(publishSubmissionMessage).toHaveBeenCalledTimes(4);
  });

  it("returns tokens in request order even when groups interleave", async () => {
    const res = await post(key, [item("x", "A"), item("y", "B"), item("z", "A")]);
    expect(res.body).toHaveLength(3);
    // Items 0 and 2 share a source, so they share an id and differ by index.
    const [id0, i0] = res.body[0].token.split(".");
    const [id2, i2] = res.body[2].token.split(".");
    expect(id0).toBe(id2);
    expect([i0, i2]).toEqual(["0", "1"]);
    // The lone item keeps a plain id, identical to a single request.
    expect(res.body[1].token).toMatch(/^[0-9a-f]{24}$/);
    expect(res.body[1].token).not.toBe(id0);
  });

  it("splits a large group by worst-case run time so the judge budget is not exceeded", async () => {
    // 10s default limit => 6 cases per submission.
    await post(key, Array.from({ length: 13 }, (_, i) => item(String(i))));
    const sizes = publishSubmissionMessage.mock.calls.map(([m]) => m.tests.length);
    expect(sizes).toEqual([6, 6, 1]);
  });

  it("answers an invalid item in place without rejecting the rest", async () => {
    const res = await post(key, [item("1"), { language_id: 71 }, { ...item("3"), language_id: 9999 }, item("4")]);
    expect(res.status).toBe(201);
    expect(res.body[0].token).toBeTruthy();
    expect(res.body[1].error).toMatch(/required/);
    expect(res.body[2].error).toMatch(/Unsupported/);
    expect(res.body[3].token).toBeTruthy();
    // The two good items share a source, so they ran as one group.
    expect(publishSubmissionMessage).toHaveBeenCalledTimes(1);
    expect(publishSubmissionMessage.mock.calls[0][0].tests).toHaveLength(2);
  });

  it("refuses an oversized item in place without rejecting the rest", async () => {
    const big = { language_id: 71, source_code: b64("x".repeat(200 * 1024 + 1)), stdin: b64("") };
    const res = await post(key, [item("1"), big]);
    expect(res.status).toBe(201);
    expect(res.body[0].token).toBeTruthy();
    expect(res.body[1].error).toMatch(/exceeds/);
  });

  it("rejects an empty or oversized batch", async () => {
    expect((await post(key, [])).status).toBe(422);
    const big = await post(key, Array.from({ length: 21 }, (_, i) => item(String(i))));
    expect(big.status).toBe(422);
    expect(big.body.error).toMatch(/20/);
    expect(publishSubmissionMessage).not.toHaveBeenCalled();
  });

  it("requires an API key: shared-secret callers have no way to read a coalesced result", async () => {
    const res = await request(app).post("/api/codeAssess/submissions/batch")
      .set("x-rapidapi-key", "codeassess_shim_secret").send({ submissions: [item("1")] });
    expect(res.status).toBe(403);
    expect(publishSubmissionMessage).not.toHaveBeenCalled();
  });

  it("fails the whole request, not a 201 of errors, when nothing could be queued", async () => {
    publishSubmissionMessage.mockRejectedValue(Object.assign(new Error("down"), { status: 503 }));
    const res = await post(key, [item("1"), item("2")]);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await Submission.countDocuments({ status: "Pending" })).toBe(0);
  });

  describe("reading results back", () => {
    const finish = (id, testResult, status = "Success") =>
      Submission.updateOne({ _id: id }, { $set: { status, testResult } });

    it("resolves each item to its own test case, including mixed outcomes", async () => {
      const res = await post(key, [item("ok"), item("slow"), item("boom")]);
      const id = res.body[0].token.split(".")[0];
      await finish(id, {
        status: "Time Limit Exceeded",
        details: [
          { passed: true, stdout: "ok\n", timeMs: 12, exitCode: 0 },
          { passed: false, errorType: "timeout", timeMs: 2000, exitCode: -1 },
          { passed: false, errorType: "runtime", stderr: "boom", timeMs: 5, exitCode: 1 }
        ]
      }, "Error");

      const out = (await get(key, res.body.map((r) => r.token))).body.submissions;
      expect(out.map((o) => o.status.id)).toEqual([3, 5, 11]);
      expect(unb64(out[0].stdout)).toBe("ok\n");
      expect(unb64(out[2].stderr)).toBe("boom");
      expect(out[2].exit_code).toBe(1);
      expect(out[1].exit_code).toBe(-1);
      // The overall verdict (TLE) must not leak onto the case that passed.
      expect(out[0].status.id).toBe(3);
    });

    it("reports a compile error against every item in the group", async () => {
      const res = await post(key, [item("1"), item("2")]);
      const id = res.body[0].token.split(".")[0];
      await finish(id, { status: "Compilation Error", stderr: "syntax error" }, "Error");

      const out = (await get(key, res.body.map((r) => r.token))).body.submissions;
      expect(out.map((o) => o.status.id)).toEqual([6, 6]);
      expect(unb64(out[1].compile_output)).toBe("syntax error");
      expect(out[1].exit_code).toBe(-1);
    });

    it("reports in-queue with null fields while pending", async () => {
      const res = await post(key, [item("1"), item("2")]);
      const out = (await get(key, res.body.map((r) => r.token))).body.submissions;
      expect(out.every((o) => o.status.id === 1 && o.stdout === null)).toBe(true);
    });

    it("a case index with no recorded result is an internal error, not someone else's output", async () => {
      const res = await post(key, [item("1"), item("2")]);
      const id = res.body[0].token.split(".")[0];
      await finish(id, { status: "Accepted", details: [{ passed: true, stdout: "only one\n" }] });
      const out = (await get(key, res.body.map((r) => r.token))).body.submissions;
      expect(out[0].status.id).toBe(3);
      expect(out[1].status.id).toBe(13);
    });

    it("a single GET resolves a coalesced token", async () => {
      const res = await post(key, [item("1"), item("2")]);
      const id = res.body[0].token.split(".")[0];
      await finish(id, { status: "Accepted", details: [{ passed: true, stdout: "A" }, { passed: true, stdout: "B" }] });
      const one = await request(app).get(`/api/codeAssess/submissions/${res.body[1].token}`).set("x-rapidapi-key", key);
      expect(one.status).toBe(200);
      expect(unb64(one.body.stdout)).toBe("B");
    });

    it("returns null for another client's token and for malformed ones", async () => {
      const res = await post(key, [item("1")]);
      const mine = res.body[0].token;
      const out = (await get(otherKey, [mine, "not-a-token", `${mine}.zzz`])).body.submissions;
      expect(out).toEqual([null, null, null]);
    });

    it("does not let GET /batch be captured by the single-token route", async () => {
      const res = await get(key, ["a".repeat(24)]);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("submissions");
    });
  });
});
