import { getRedis } from "../config/redis.js";

// The judge publishes a submission's id here once its result is in Mongo
// (judge-service-go submissionDoneChannel).
export const SUBMISSION_DONE_CHANNEL = "submission:done";

// How often a waiter re-reads Mongo on its own. With the listener running this is only a
// safety net (a lost message, or a failure the judge records without publishing); without
// it, waiters poll as they always did.
const FALLBACK_POLL_MS = 1000;
const POLL_MS_WITHOUT_LISTENER = 100;

const waiters = new Map(); // submission id -> Set of watchers
let subscriber = null;
let listening = false;

// One Redis connection subscribed for the whole process, instead of every wait=true caller
// polling Mongo every 100 ms (JUDGE_FIX_PLAN T6). Best effort: if it cannot start, waiters
// keep polling.
export async function startSubmissionEvents() {
  const redis = getRedis();
  if (!redis || subscriber) return;
  try {
    subscriber = redis.duplicate();
    subscriber.on("error", (err) => {
      listening = false;
      console.log("Submission events Redis error", err.message);
    });
    // node-redis re-subscribes after a reconnect; mark the listener live again once it is back.
    subscriber.on("ready", () => {
      listening = true;
    });
    await subscriber.connect();
    await subscriber.subscribe(SUBMISSION_DONE_CHANNEL, (id) => notifySubmissionDone(id));
    listening = true;
  } catch (err) {
    console.log("Submission events disabled; wait=true callers will poll:", err.message);
    subscriber = null;
    listening = false;
  }
}

export async function stopSubmissionEvents() {
  const sub = subscriber;
  subscriber = null;
  listening = false;
  if (sub) await sub.quit().catch(() => {});
}

export function notifySubmissionDone(id) {
  const set = waiters.get(String(id));
  if (set) for (const watcher of set) watcher.signal();
}

// Registers interest in a submission. Call it before reading the submission, so a completion
// that lands between the read and the wait is not missed. wait(maxMs) resolves when the judge
// reports the submission done or after the poll interval, whichever comes first; cancel()
// must be called once the caller stops waiting.
export function watchSubmission(id) {
  const key = String(id);
  let pending = false; // signalled while nobody was waiting
  let wakeUp = null;
  const watcher = {
    signal() {
      if (wakeUp) wakeUp();
      else pending = true;
    },
  };
  if (!waiters.has(key)) waiters.set(key, new Set());
  waiters.get(key).add(watcher);

  return {
    wait(maxMs) {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      const ms = Math.max(0, Math.min(maxMs, listening ? FALLBACK_POLL_MS : POLL_MS_WITHOUT_LISTENER));
      return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
          clearTimeout(timer);
          wakeUp = null;
          resolve();
        }
        wakeUp = done;
      });
    },
    cancel() {
      wakeUp = null;
      const set = waiters.get(key);
      if (!set) return;
      set.delete(watcher);
      if (set.size === 0) waiters.delete(key);
    },
  };
}

export function submissionEventsState() {
  return { listening, waiting: waiters.size };
}
