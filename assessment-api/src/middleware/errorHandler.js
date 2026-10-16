import { safeErrorMessage } from "../utils/safeErrorMessage.js";

export function errorHandler(err, req, res, _next) {
  console.error(err);

  const status = err.status || 500;
  // A 429 is only actionable if the client is told when to come back.
  if (err.retryAfter) res.set("Retry-After", String(err.retryAfter));
  const message = safeErrorMessage(err);

  if (err.status && err.body) {
    const responseBody = typeof err.body === 'object' ? { ...err.body } : { body: err.body };
    if (!responseBody.msg) responseBody.msg = message;
    if (!responseBody.message) responseBody.message = message;
    return res.status(status).json(responseBody);
  }

  res.status(status).json({
    message: message,
    msg: message
  });
}
