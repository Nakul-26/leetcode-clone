import amqp from "amqplib";
import { getChannel, getRabbitConnectionTarget } from "../config/rabbit.js";

const QUEUE_NAME = "submission_queue";
// Latency-sensitive work (a caller waiting synchronously) goes here; the judge
// drains it ahead of the bulk queue. See judge-service-go main.go.
export const INTERACTIVE_QUEUE_NAME = "submission_queue_fast";
const DLX_NAME = "submission_dlx";
const DLQ_NAME = "submission_dead_letters";

const MAX_QUEUE_DEPTH = 5000;

export async function publishSubmissionMessage(messageBody, { queue = QUEUE_NAME } = {}) {
  let connection;
  let channel;
  let existingChannel = getChannel();

  try {
    connection = existingChannel ? null : await amqp.connect(getRabbitConnectionTarget());
    channel = existingChannel || await connection.createChannel();

    // Setup DLQ
    await channel.assertExchange(DLX_NAME, "direct", { durable: true });
    await channel.assertQueue(DLQ_NAME, { durable: true });
    await channel.bindQueue(DLQ_NAME, DLX_NAME, "");

    const q = await channel.assertQueue(queue, { 
      durable: true,
      arguments: {
        "x-dead-letter-exchange": DLX_NAME
      }
    });

    // Backpressure Protection
    if (q.messageCount >= MAX_QUEUE_DEPTH) {
      if (!existingChannel) {
        await channel.close();
        await connection.close();
      }
      const error = new Error("Service Overloaded: Too many pending submissions");
      error.status = 503;
      error.body = { msg: "System overloaded with pending submissions. Please try again in a few moments.", retryAfter: 60 };
      throw error;
    }

    channel.sendToQueue(queue, Buffer.from(JSON.stringify(messageBody)), { persistent: true });

    if (!existingChannel) {
      await channel.close();
      await connection.close();
    }
  } catch (err) {
    if (err.status === 503) throw err; // Pass backpressure error through
    console.error("RabbitMQ Publish Error:", err);
    const error = new Error("Queue Service Unavailable");
    error.status = 503;
    error.body = { msg: "Submission queue is temporarily unavailable. Please try again.", retryAfter: 30 };
    throw error;
  }
}
