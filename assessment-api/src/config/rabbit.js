import amqp from "amqplib";
import { env } from "./env.js";

let connection;
let channel;

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

export async function initRabbit() {
  if (channel) return channel;
  connection = await amqp.connect(getRabbitConnectionTarget());
  channel = await connection.createChannel();
  console.log("✅ RabbitMQ connected");
  return channel;
}

export function getChannel() {
  return channel;
}

// The amqplib connection object (the thing that can open further channels). Deliberately not
// `channel.connection`, which is the low-level protocol connection and has no createChannel.
export function getConnection() {
  return connection;
}
