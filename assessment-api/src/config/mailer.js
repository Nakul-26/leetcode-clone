import nodemailer from "nodemailer";
import { env } from "./env.js";

let transporterSingleton = null;

export function isMailConfigured() {
  return !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

// Lazy on purpose, same rationale as getStripeClient() in stripe.js: no live SMTP
// credentials yet, so this must not throw at module-load/boot time.
export function getMailTransporter() {
  if (!isMailConfigured()) return null;
  if (!transporterSingleton) {
    transporterSingleton = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
    });
  }
  return transporterSingleton;
}
