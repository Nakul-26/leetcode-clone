import { initRabbit } from "../config/rabbit.js";

const QUEUE_NAME = "submission_queue";
// Latency-sensitive work (a caller waiting synchronously) goes here; the judge
// drains it ahead of the bulk queue. See judge-service-go main.go.
export const INTERACTIVE_QUEUE_NAME = "submission_queue_fast";
const DLX_NAME = "submission_dlx";
const DLQ_NAME = "submission_dead_letters";

const MAX_QUEUE_DEPTH = 5000;

// How long to wait for the broker to confirm a publish before treating it as failed.
const PUBLISH_CONFIRM_TIMEOUT_MS = 10_000;

// Channels on which the dead-letter exchange and queue are already declared.
const dlxDeclared = new WeakSet();

// Publishes on the shared confirm channel and resolves only once RabbitMQ has the message
// (JUDGE_FIX_PLAN R7). Any failure is a 503, and callers mark the row Error and refund.
export async function publishSubmissionMessage(messageBody, { queue = QUEUE_NAME } = {}) {
  try {
    const channel = await initRabbit();

    if (!dlxDeclared.has(channel)) {
      await channel.assertExchange(DLX_NAME, "direct", { durable: true });
      await channel.assertQueue(DLQ_NAME, { durable: true });
      await channel.bindQueue(DLQ_NAME, DLX_NAME, "");
      dlxDeclared.add(channel);
    }

    const q = await channel.assertQueue(queue, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": DLX_NAME
      }
    });

    // Backpressure Protection
    if (q.messageCount >= MAX_QUEUE_DEPTH) {
      const error = new Error("Service Overloaded: Too many pending submissions");
      error.status = 503;
      error.body = { msg: "System overloaded with pending submissions. Please try again in a few moments.", retryAfter: 60 };
      throw error;
    }

    await sendConfirmed(channel, queue, Buffer.from(JSON.stringify(messageBody)), { persistent: true });
  } catch (err) {
    if (err.status === 503) throw err; // Pass backpressure error through
    console.error("RabbitMQ Publish Error:", err);
    const error = new Error("Queue Service Unavailable");
    error.status = 503;
    error.body = { msg: "Submission queue is temporarily unavailable. Please try again.", retryAfter: 30 };
    throw error;
  }
}

// amqplib calls the callback when the broker acks (err null) or nacks the message, and with
// an error for outstanding publishes if the channel closes. The timeout covers a broker that
// never answers.
function sendConfirmed(channel, queue, body, options) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("RabbitMQ did not confirm the publish in time")),
      PUBLISH_CONFIRM_TIMEOUT_MS
    );
    channel.sendToQueue(queue, body, options, (err) => {
      clearTimeout(timer);
      if (err) reject(err instanceof Error ? err : new Error("RabbitMQ rejected the publish"));
      else resolve();
    });
  });
}
