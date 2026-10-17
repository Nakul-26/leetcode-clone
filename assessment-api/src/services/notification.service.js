import { getMailTransporter, isMailConfigured } from "../config/mailer.js";
import { env } from "../config/env.js";

// Soft-fails instead of throwing when SMTP isn't configured (same convention as
// billing.service.js/stripe.js) - callers get a { sent: false, reason } back and keep
// going, since a missing mail provider must never block scheduling/pipeline actions.
export async function sendMail({ to, subject, text, html }) {
  if (!to) return { sent: false, reason: "no recipient" };
  if (!isMailConfigured()) return { sent: false, reason: "mail not configured" };

  const transporter = getMailTransporter();
  try {
    await transporter.sendMail({ from: env.SMTP_FROM || env.SMTP_USER, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    console.error("[notification.service] sendMail failed:", err.message);
    return { sent: false, reason: "send failed" };
  }
}
