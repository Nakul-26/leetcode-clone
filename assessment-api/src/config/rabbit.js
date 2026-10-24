import amqp from "amqplib";
import { env } from "./env.js";

let connection = null;
let channel = null;
let opening = null;

// Passwords with reserved URL characters (%, $, ^, @, ...) break naive
// "amqp://user:pass@host" string URIs (URIError: URI malformed). When
// RABBITMQ_PASS is set, pass credentials as separate fields so amqplib
// never has to URL-parse the raw password.
export function getRabbitConnectionTarget() {
  return process.env.RABBITMQ_PASS
    ? {
        protocol: "amqp",
        hostname: process.env.RABBITMQ_HOST || "rabbitmq",
        port: parseInt(process.env.RABBITMQ_PORT || "5672", 10),
        username: process.env.RABBITMQ_USER || "user",
        password: process.env.RABBITMQ_PASS,
        vhost: process.env.RABBITMQ_VHOST || "/"
      }
    : env.RABBITMQ_URI;
}

async function openConnection() {
  const conn = await amqp.connect(getRabbitConnectionTarget());
  // Without an "error" listener a broker restart throws out of the event emitter and
  // crashes the API. With one, the close below clears the state and the next caller reconnects.
  conn.on("error", (err) => console.error("RabbitMQ connection error:", err.message));
  conn.on("close", () => {
    if (connection === conn) {
      connection = null;
      channel = null;
      console.warn("RabbitMQ connection closed; will reconnect on next use");
    }
  });
  connection = conn;
  return conn;
}

async function openChannel(conn) {
  // A confirm channel, so a publish only counts once the broker has the message
  // (JUDGE_FIX_PLAN R7). A channel-level error (e.g. checkQueue on a missing queue) closes
  // only the channel; clearing it here lets the next caller open a fresh one.
  const ch = await conn.createConfirmChannel();
  ch.on("error", (err) => console.error("RabbitMQ channel error:", err.message));
  ch.on("close", () => {
    if (channel === ch) channel = null;
  });
  channel = ch;
  return ch;
}

// Returns the shared confirm channel, connecting or reopening it if it was lost.
// Concurrent callers share one attempt.
export async function initRabbit() {
  if (channel) return channel;
  if (!opening) {
    opening = (async () => {
      const conn = connection || (await openConnection());
      const ch = await openChannel(conn);
      console.log("✅ RabbitMQ connected");
      return ch;
    })().finally(() => {
      opening = null;
    });
  }
  return opening;
}

export function getChannel() {
  return channel;
}

// The amqplib connection object (the thing that can open further channels). Deliberately not
// `channel.connection`, which is the low-level protocol connection and has no createChannel.
export function getConnection() {
  return connection;
}
