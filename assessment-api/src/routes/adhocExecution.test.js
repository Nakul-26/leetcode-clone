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

describe("Judge0 shim: queue-backed path for keyed clients", () => {
  let key, otherKey;

  const issue = async (token, name) =>
    (await request(app).post("/api/admin/api-clients").set("Authorization", `Bearer ${token}`)
      .send({ name, scopes: ["codeassess"] })).body.key;

  beforeEach(async () => {
    await User.deleteMany({}); await College.deleteMany({});
    await ApiClient.deleteMany({}); await Submission.deleteMany({});
    publishSubmissionMessage.mockClear();

    const college = await College.create({ name: "C", slug: "c" });
    const admin = await authService.register({
      name: "A", email: "a@test.com", password: "password123", role: "admin", collegeId: college._id
    });
    key = await issue(admin.token, "one");
    otherKey = await issue(admin.token, "two");
  });

  const post = (k, qs = "?base64_encoded=true&wait=true", extra = {}) =>
    request(app).post(`/api/codeAssess/submissions${qs}`).set("x-rapidapi-key", k)
      .send({ language_id: 71, source_code: b64("print(input())"), stdin: b64("hi"), ...extra });

  it("enqueues an ad-hoc stdin submission on the interactive queue", async () => {
    const res = await post(key, "?base64_encoded=true");
    expect(res.status).toBe(201);

    expect(publishSubmissionMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = publishSubmissionMessage.mock.calls[0];
    expect(opts.queue).toBe("submission_queue_fast");
    expect(msg).toMatchObject({ kind: "adhoc", problemType: "stdin", language: "python", submissionId: res.body.token });
    expect(msg.problemId).toBeUndefined();
    expect(msg.tests).toEqual([{ inputs: ["hi"], expected: null, isHidden: true }]);
    expect(msg.apiClientId).toBeTruthy();

    const row = await Submission.findById(res.body.token);
    expect(row.kind).toBe("adhoc");
    expect(row.problemId).toBeUndefined();
    expect(row.expiresAt).toBeInstanceOf(Date);
  });

  it("wait=true returns the judged result once the judge writes it", async () => {
    publishSubmissionMessage.mockImplementationOnce(async (msg) => {
      setTimeout(() => Submission.updateOne({ _id: msg.submissionId }, { $set: {
        status: "Success",
        testResult: { status: "Accepted", details: [{ stdout: "hi\n", stderr: "", timeMs: 40, exitCode: 0 }] }
      } }).exec(), 150);
    });
    const res = await post(key);
    expect(res.status).toBe(200);
    expect(res.body.status).toEqual({ id: 3, description: "Accepted" });
    expect(Buffer.from(res.body.stdout, "base64").toString()).toBe("hi\n");
    expect(res.body.time).toBeCloseTo(0.04);
  });

  it("maps a crash to 11 and a judge failure to 13", async () => {
    const run = async (update) => {
      publishSubmissionMessage.mockImplementationOnce(async (msg) => {
        await Submission.updateOne({ _id: msg.submissionId }, { $set: update });
      });
      return (await post(key)).body;
    };
    const crash = await run({ status: "Error", testResult: { status: "Runtime Error", details: [{ stderr: "boom", exitCode: 1, timeMs: 5 }] } });
    expect(crash.status.id).toBe(11);
    expect(crash.exit_code).toBe(1);

    const broken = await run({ status: "Error", output: "no containers" });
    expect(broken.status.id).toBe(13);
  });

  it("GET returns the real status, and another client's token is a 404", async () => {
    const created = await post(key, "?base64_encoded=true");
    const mine = await request(app).get(`/api/codeAssess/submissions/${created.body.token}`).set("x-rapidapi-key", key);
    expect(mine.status).toBe(200);
    expect(mine.body.status.id).toBe(1); // still queued, in Judge0's own terms

    const theirs = await request(app).get(`/api/codeAssess/submissions/${created.body.token}`).set("x-rapidapi-key", otherKey);
    expect(theirs.status).toBe(404);
  });

  it("a queue outage fails the request and does not strand a Pending row", async () => {
    publishSubmissionMessage.mockRejectedValueOnce(Object.assign(new Error("down"), { status: 503 }));
    const res = await post(key);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await Submission.countDocuments({ status: "Pending" })).toBe(0);
  });

  it("legacy shared-secret callers still take the synchronous path", async () => {
    const res = await request(app).post("/api/codeAssess/submissions?base64_encoded=true&wait=true")
      .set("x-rapidapi-key", "codeassess_shim_secret")
      .send({ language_id: 71, source_code: b64("print(1)") });
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^sync-/);
    expect(publishSubmissionMessage).not.toHaveBeenCalled();
  });
});
