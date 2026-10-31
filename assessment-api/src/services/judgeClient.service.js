import { randomUUID } from "crypto";
import { env } from "../config/env.js";
import { initRabbit, getConnection } from "../config/rabbit.js";

// Synchronous judge calls (/run, /raw-run) over RabbitMQ request/reply (JUDGE_FIX_PLAN M1).
//
// Over HTTP they went to the one judge that JUDGE_SERVICE_URL names, so they could not spread
// across judge servers. On the queue any judge that is consuming it takes the request: the
// judge runs it through the same handler as the HTTP endpoint and replies on RabbitMQ's
// direct reply-to queue. The result is the same, status and body included.
//
// HTTP stays as the fallback, so either side can be deployed first: when no judge is
// consuming the queue (an older judge), when RabbitMQ is unreachable, or when JUDGE_RPC=off.
// judgeFetch returns a fetch-like object (ok, status, text(), json()) so callers keep their
// error handling.

export const JUDGE_RPC_QUEUE = "judge_rpc";
const REPLY_TO = "amq.rabbitmq.reply-to";
const DEFAULT_TIMEOUT_MS = 150000;
// How long a "a judge is consuming the queue" answer is trusted before asking the broker again.
const CONSUMER_CHECK_MS = 10000;

let rpcChannel = null;
let opening = null;
const pending = new Map();
let consumersCheckedAt = 0;
let consumersPresent = false;

function failPending(reason) {
  for (const [, waiter] of pending) waiter.reject(new Error(reason));
  pending.clear();
}

async function openRpcChannel() {
  await initRabbit();
  const conn = getConnection();
  if (!conn) throw new Error("RabbitMQ connection unavailable");
  const ch = await conn.createChannel();
  ch.on("error", (err) => console.error("Judge RPC channel error:", err.message));
  ch.on("close", () => {
    if (rpcChannel === ch) {
      rpcChannel = null;
      consumersCheckedAt = 0;
      failPending("RabbitMQ channel closed before the judge replied");
    }
  });
  // Same declaration as the judge's (durable, no arguments), so either side may create it.
  await ch.assertQueue(JUDGE_RPC_QUEUE, { durable: true });
  await ch.consume(
    REPLY_TO,
    (msg) => {
      if (!msg) return;
      const waiter = pending.get(msg.properties.correlationId);
      if (!waiter) return; // the caller gave up already
      pending.delete(msg.properties.correlationId);
      waiter.resolve(msg.content.toString("utf8"));
    },
    { noAck: true }
  );
  rpcChannel = ch;
  return ch;
}

async function getRpcChannel() {
  if (rpcChannel) return rpcChannel;
  if (!opening) {
    opening = openRpcChannel().finally(() => {
      opening = null;
    });
  }
  return opening;
}

async function judgeConsumesQueue(ch) {
  if (Date.now() - consumersCheckedAt < CONSUMER_CHECK_MS) return consumersPresent;
  const info = await ch.assertQueue(JUDGE_RPC_QUEUE, { durable: true });
  consumersPresent = info.consumerCount > 0;
  consumersCheckedAt = Date.now();
  return consumersPresent;
}

function responseFrom(status, bodyText) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
    json: async () => JSON.parse(bodyText),
  };
}

async function viaQueue(ch, path, body, timeoutMs) {
  const correlationId = randomUUID();
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(correlationId);
      reject(new Error(`The judge did not answer ${path} within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    pending.set(correlationId, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
  });
  // The expiration drops a request no judge picked up before the caller stopped waiting.
  ch.sendToQueue(JUDGE_RPC_QUEUE, Buffer.from(JSON.stringify({ path, body })), {
    correlationId,
    replyTo: REPLY_TO,
    contentType: "application/json",
    expiration: String(timeoutMs),
  });
  const raw = await reply;
  const { status, body: replyBody } = JSON.parse(raw);
  return responseFrom(status, replyBody ?? "");
}

/**
 * POST a JSON body to a judge endpoint ("/run" or "/raw-run"), over the queue when a judge
 * consumes it, else over HTTP. `body` is the JSON string the HTTP request would carry.
 */
export async function judgeFetch(path, { body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (String(process.env.JUDGE_RPC || "").toLowerCase() !== "off") {
    let ch = null;
    try {
      ch = await getRpcChannel();
      if (!(await judgeConsumesQueue(ch))) ch = null;
    } catch (err) {
      console.warn("Judge RPC unavailable, using HTTP:", err.message);
      ch = null;
    }
    if (ch) {
      const res = await viaQueue(ch, path, body, timeoutMs);
      // 503: that judge had no free container. Another judge, or the HTTP one, may.
      if (res.status !== 503) return res;
    }
  }
  return fetch(`${env.JUDGE_SERVICE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

// For tests.
export function _resetJudgeClient() {
  rpcChannel = null;
  opening = null;
  consumersCheckedAt = 0;
  consumersPresent = false;
  failPending("reset");
}
