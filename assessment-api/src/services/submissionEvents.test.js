import { describe, it, expect } from "vitest";
import { watchSubmission, notifySubmissionDone, submissionEventsState } from "./submissionEvents.service.js";

// JUDGE_FIX_PLAN T6: wait=true callers are woken by the judge's completion message.

describe("watchSubmission", () => {
  it("wakes a waiter as soon as its submission is reported done", async () => {
    const watch = watchSubmission("a1");
    const start = Date.now();
    const waited = watch.wait(10_000);
    setTimeout(() => notifySubmissionDone("a1"), 20);
    await waited;
    expect(Date.now() - start).toBeLessThan(500);
    watch.cancel();
  });

  it("does not miss a completion that lands before the wait starts", async () => {
    const watch = watchSubmission("a2");
    notifySubmissionDone("a2"); // e.g. between the caller's Mongo read and its wait
    const start = Date.now();
    await watch.wait(10_000);
    expect(Date.now() - start).toBeLessThan(50);
    watch.cancel();
  });

  it("ignores other submissions and falls back to polling", async () => {
    const watch = watchSubmission("a3");
    const start = Date.now();
    const waited = watch.wait(10_000);
    notifySubmissionDone("someone-else");
    await waited;
    // No listener in tests, so the fallback is the old 100 ms poll.
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
    watch.cancel();
  });

  it("never waits past the caller's deadline", async () => {
    const watch = watchSubmission("a4");
    const start = Date.now();
    await watch.wait(10);
    expect(Date.now() - start).toBeLessThan(80);
    watch.cancel();
  });

  it("forgets a submission once every waiter has cancelled", () => {
    const before = submissionEventsState().waiting;
    const w1 = watchSubmission("a5");
    const w2 = watchSubmission("a5");
    expect(submissionEventsState().waiting).toBe(before + 1);
    w1.cancel();
    expect(submissionEventsState().waiting).toBe(before + 1);
    w2.cancel();
    expect(submissionEventsState().waiting).toBe(before);
  });
});
