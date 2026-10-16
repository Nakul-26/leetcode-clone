import crypto from "crypto";

// API key handling for ApiClient (plan Phase 1).
//
// Format: ak_<prefix>_<secret>
//   prefix  8 hex chars, stored in clear as a non-secret handle so a key can be
//           identified, listed and revoked in the admin UI without the secret.
//   secret  32 random bytes, base64url — ~256 bits of entropy.
//
// The full key is hashed with a single sha256 pass. That is deliberate and is NOT
// the same mistake as hashing a password with sha256: the input here is
// high-entropy random material we generated, not a human-chosen secret, so there
// is no dictionary or brute-force surface for a slow KDF to defend against. A
// fast hash is what lets authentication be one indexed lookup (O(1)) instead of
// loading every client and bcrypt-comparing each one, which would be a DoS vector
// on a hot auth path.
const KEY_PREFIX_BYTES = 4; // -> 8 hex chars
const KEY_SECRET_BYTES = 32;

export function hashApiKey(key) {
  return crypto.createHash("sha256").update(String(key), "utf8").digest("hex");
}

export function generateApiKey() {
  const keyPrefix = crypto.randomBytes(KEY_PREFIX_BYTES).toString("hex");
  const secret = crypto.randomBytes(KEY_SECRET_BYTES).toString("base64url");
  const key = `ak_${keyPrefix}_${secret}`;
  return { key, keyPrefix, keyHash: hashApiKey(key) };
}

// Pull the non-secret prefix out of a presented key, for logging a failed auth
// attempt without ever writing the secret to a log. Returns null when the key is
// not in our format (e.g. a legacy env shared secret).
export function extractKeyPrefix(key) {
  if (typeof key !== "string") return null;
  const m = /^ak_([0-9a-f]{8})_/.exec(key);
  return m ? m[1] : null;
}

export function looksLikeApiKey(key) {
  return typeof key === "string" && /^ak_[0-9a-f]{8}_[A-Za-z0-9_-]{16,}$/.test(key);
}
