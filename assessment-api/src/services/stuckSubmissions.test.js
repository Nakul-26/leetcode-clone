import { describe, it, expect, vi, beforeEach } from "vitest";

const { fake } = vi.hoisted(() => ({ fake: { depths: { bulk: 0, bulkRetry: 0 }, publishFails: false } }));

vi.mock("./evaluation.service.js", () => ({
  INTERACTIVE_QUEUE_NAME: "submission_queue_fast",
  publishSubmissionMessage: vi.fn(async () => {
    if (fake.publishFails) throw Object.assign(new Error("down"), { status: 503 });
  })
}));
vi.mock("./queueStats.service.js", () => ({
  getQueueDepths: vi.fn(async () => ({ ...fake.depths }))
}));

import mongoose from "mongoose";
import Submission from "../../models/Submission.mjs";
import Problem from "../../models/Problem.mjs";
import { publishSubmissionMessage } from "./evaluation.service.js";
import { reapStuckSubmissions } from "./stuckSubmissions.service.js";

const MIN = 60_000;
const now = new Date("2026-10-24T12:00:00Z");

// Inserted through the driver so updatedAt can be set in the past (Mongoose would stamp now).
async function insertRow(fields) {
  const _id = new mongoose.Types.ObjectId();
  await Submission.collection.insertOne({
    _id, userId: new mongoose.Types.ObjectId(), language: "python", code: "print(1)",
    status: "Pending", createdAt: new Date(now - 30 * MIN), updatedAt: new Date(now - 30 * MIN), ...fields
  });
  return _id;
}

describe("stuck-submission reaper (JUDGE_FIX_PLAN R8)", () => {
  let problem;
  beforeEach(async () => {
    fake.depths = { bulk: 0, bulkRetry: 0 };
    fake.publishFails = false;
    publishSubmissionMessage.mockClear();
    problem = await Problem.create({
      title: "Echo", description: "d", difficulty: "Easy", problemType: "stdin",
      testCases: [{ inputs: ["1\n"], expected: "1\n" }]
    });
  });

  it("re-queues a stuck row once with a full message, then marks it Error", async () => {
    const collegeId = new mongoose.Types.ObjectId();
    const id = await insertRow({ problemId: problem._id, collegeId });

    expect(await reapStuckSubmissions({ now })).toMatchObject({ requeued: 1, failed: 0 });
    expect(publishSubmissionMessage).toHaveBeenCalledTimes(1);
    const [msg] = publishSubmissionMessage.mock.calls[0];
    expect(msg).toMatchObject({ submissionId: id.toString(), problemId: problem._id.toString(), language: "python", problemType: "stdin", collegeId: String(collegeId) });
    let row = await Submission.findById(id).lean();
    expect(row).toMatchObject({ status: "Pending", stuckRequeues: 1 });

    // Re-queueing restarted the clock: right away nothing is stuck.
    expect(await reapStuckSubmissions({ now: new Date() })).toEqual({ requeued: 0, failed: 0 });

    // Still Pending a full window later: give up.
    expect(await reapStuckSubmissions({ now: new Date(Date.now() + 16 * MIN) })).toMatchObject({ requeued: 0, failed: 1 });
    row = await Submission.findById(id).lean();
    expect(row.status).toBe("Error");
    expect(row.output).toMatch(/submit it again/);
    expect(publishSubmissionMessage).toHaveBeenCalledTimes(1);
  });

  it("leaves recent and finished rows alone", async () => {
    await insertRow({ problemId: problem._id, updatedAt: new Date(now - 5 * MIN) });
    await insertRow({ problemId: problem._id, status: "Success" });
    expect(await reapStuckSubmissions({ now })).toEqual({ requeued: 0, failed: 0 });
    expect(publishSubmissionMessage).not.toHaveBeenCalled();
  });

  it("does not re-queue while the judge has a backlog or the depth is unknown", async () => {
    const id = await insertRow({ problemId: problem._id });
    fake.depths = { bulk: 400, bulkRetry: 0 };
    expect(await reapStuckSubmissions({ now })).toMatchObject({ requeued: 0, skipped: "backlog of 400" });
    fake.depths = { bulk: null, bulkRetry: 0 };
    expect(await reapStuckSubmissions({ now })).toMatchObject({ requeued: 0, skipped: "queue depth unknown" });
    expect(publishSubmissionMessage).not.toHaveBeenCalled();
    expect((await Submission.findById(id).lean()).status).toBe("Pending");
  });

  it("marks ad-hoc rows and rows whose problem is gone as Error without publishing", async () => {
    const adhoc = await insertRow({ kind: "adhoc" });
    const orphan = await insertRow({ problemId: new mongoose.Types.ObjectId() });
    expect(await reapStuckSubmissions({ now })).toMatchObject({ requeued: 0, failed: 2 });
    expect(publishSubmissionMessage).not.toHaveBeenCalled();
    expect((await Submission.findById(adhoc).lean()).status).toBe("Error");
    expect((await Submission.findById(orphan).lean()).output).toMatch(/no longer exists/);
  });

  it("marks rows older than a day as Error instead of judging them after the fact", async () => {
    const day = 24 * 60 * MIN;
    const id = await insertRow({ problemId: problem._id, updatedAt: new Date(now - 2 * day) });
    expect(await reapStuckSubmissions({ now })).toMatchObject({ requeued: 0, failed: 1 });
    expect(publishSubmissionMessage).not.toHaveBeenCalled();
    expect((await Submission.findById(id).lean()).status).toBe("Error");
  });

  it("a failed publish does not use up the one re-queue", async () => {
    const id = await insertRow({ problemId: problem._id });
    fake.publishFails = true;
    await expect(reapStuckSubmissions({ now })).rejects.toThrow("down");
    expect((await Submission.findById(id).lean())).toMatchObject({ status: "Pending", stuckRequeues: 0 });
  });

  it("handles each row once when two passes race", async () => {
    await insertRow({ problemId: problem._id });
    const [a, b] = await Promise.all([reapStuckSubmissions({ now }), reapStuckSubmissions({ now })]);
    expect(a.requeued + b.requeued).toBe(1);
    expect(publishSubmissionMessage).toHaveBeenCalledTimes(1);
  });
});
