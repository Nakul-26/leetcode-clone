import { describe, it, expect, vi, beforeEach } from "vitest";

// The depth reader must use the object that can open channels, and must never touch the shared
// publishing channel: checkQueue on a missing queue closes whatever channel it ran on. A fake
// broker lets this be tested for real; the shared test broker cannot be inspected, which is how
// an earlier version passed its test while returning null for every queue in production.
const { fake } = vi.hoisted(() => ({
  fake: { depths: {}, opened: [], connection: null }
}));

vi.mock("../config/rabbit.js", () => ({
  getConnection: () => fake.connection,
  getChannel: () => ({ sendToQueue: vi.fn() }),
  getRabbitConnectionTarget: () => "amqp://fake",
  initRabbit: vi.fn()
}));

import { getQueueDepths } from "./queueStats.service.js";

function fakeConnection() {
  return {
    async createChannel() {
      const ch = {
        closed: false,
        on() {},
        async checkQueue(name) {
          if (!(name in fake.depths)) {
            ch.closed = true; // what a real broker does to the channel for a missing queue
            throw new Error(`NOT_FOUND - no queue '${name}'`);
          }
          return { queue: name, messageCount: fake.depths[name] };
        },
        async close() {
          if (ch.closed) throw new Error("Channel closed");
          ch.closed = true;
        }
      };
      fake.opened.push(ch);
      return ch;
    }
  };
}

describe("getQueueDepths", () => {
  beforeEach(() => {
    fake.depths = {};
    fake.opened = [];
    fake.connection = fakeConnection();
  });

  it("reads the depth of every queue that exists", async () => {
    fake.depths = {
      submission_queue: 12,
      submission_queue_fast: 3,
      submission_queue_retry: 0,
      submission_queue_fast_retry: 0,
      submission_dead_letters: 2
    };
    expect(await getQueueDepths()).toEqual({
      bulk: 12, interactive: 3, bulkRetry: 0, interactiveRetry: 0, deadLetters: 2
    });
  });

  it("reports a queue that does not exist yet as unknown (null), not as empty (0)", async () => {
    fake.depths = { submission_queue: 5 }; // the judge has not declared the others
    const d = await getQueueDepths();
    expect(d.bulk).toBe(5);
    expect(d.interactive).toBeNull();
    expect(d.deadLetters).toBeNull();
  });

  it("uses a separate channel per queue, so one missing queue cannot break the reads after it", async () => {
    fake.depths = { submission_queue_retry: 7 }; // earlier queues are missing, a later one is not
    const d = await getQueueDepths();
    expect(d.bulkRetry).toBe(7);
    expect(fake.opened.length).toBe(5);
  });

  it("returns all-null rather than throwing when there is no broker connection", async () => {
    fake.connection = null;
    const d = await getQueueDepths();
    expect(Object.values(d).every((v) => v === null)).toBe(true);
  });
});
