import crypto from "crypto";

// A per-slot random token given to an external (no-account) interviewer, following the
// same "store a hash, compare hashes" shape as password-reset tokens rather than a
// stateless JWT - it needs to be revocable/regenerable per slot, which a Mongo-backed
// lookup gives for free.
export function generateAccessToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function hashAccessToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
