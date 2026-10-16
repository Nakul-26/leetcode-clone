import ApiClient from "../../models/ApiClient.mjs";
import { hashApiKey, looksLikeApiKey, extractKeyPrefix } from "../utils/apiKey.js";
import { safeCompare } from "../utils/safeCompare.js";

// Authenticates a machine caller against the ApiClient collection (plan Phase 1).
//
// Each external surface presents its key in a different header, and those header
// names are part of a contract we do not control — exam-platform's judge.js sends
// `x-rapidapi-key` because it was written against a Judge0/RapidAPI-shaped
// service — so the extraction is passed in rather than assumed here.
//
// Legacy fallback: until every caller has been issued a real key, the original
// global env secret still authenticates. That keeps existing integrations working
// through the transition instead of breaking them on deploy. Those requests are
// logged so you can see when the fallback stops being used and delete it; they
// carry no ApiClient, so they remain unattributable and unmeterable — which is
// the whole reason this model exists.

// Updating lastUsedAt on every request would add a write to a hot auth path for
// almost no information. One write per minute per client is plenty to answer "is
// this key still in use / safe to revoke".
const LAST_USED_THROTTLE_MS = 60_000;
const lastUsedWrites = new Map();

function touchLastUsed(clientId) {
  const now = Date.now();
  const prev = lastUsedWrites.get(String(clientId)) || 0;
  if (now - prev < LAST_USED_THROTTLE_MS) return;
  lastUsedWrites.set(String(clientId), now);
  // Deliberately not awaited: this is bookkeeping, and a failure here must never
  // fail an otherwise-valid request.
  ApiClient.updateOne({ _id: clientId }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
}

export function apiClientAuth({ scope, extractKey, legacySecret, legacyLabel }) {
  if (!scope) throw new Error("apiClientAuth requires a scope");
  if (typeof extractKey !== "function") throw new Error("apiClientAuth requires extractKey");

  return async function apiClientAuthMiddleware(req, res, next) {
    const presented = extractKey(req);

    if (!presented) {
      return res.status(401).json({ success: false, message: "Unauthorized: missing credentials" });
    }

    try {
      if (looksLikeApiKey(presented)) {
        const client = await ApiClient.findOne({ keyHash: hashApiKey(presented) });

        // A revoked or unknown key and a wrong scope all return the same 401 with
        // the same body: distinguishing them would tell a caller probing keys
        // which ones exist.
        if (!client || !client.active || !client.scopes.includes(scope)) {
          console.warn(
            `[APIKEY][REQ:${req.id}] rejected key prefix=${extractKeyPrefix(presented)} scope=${scope} ` +
            `reason=${!client ? "unknown" : !client.active ? "revoked" : "scope"}`
          );
          return res.status(401).json({ success: false, message: "Unauthorized: invalid credentials" });
        }

        req.apiClient = client;
        req.collegeId = client.collegeId;
        touchLastUsed(client._id);
        return next();
      }

      if (legacySecret && safeCompare(presented, legacySecret)) {
        req.apiClient = null;
        req.legacyApiAuth = true;
        console.warn(
          `[APIKEY][REQ:${req.id}] legacy shared secret used for scope=${scope} (${legacyLabel || "env secret"}). ` +
          `This caller is unattributable and unmetered — issue it an ApiClient key.`
        );
        return next();
      }

      return res.status(401).json({ success: false, message: "Unauthorized: invalid credentials" });
    } catch (err) {
      return next(err);
    }
  };
}

// Exposed for tests so a suite can assert throttling behaviour deterministically
// without waiting a minute of wall clock.
export function __resetLastUsedThrottle() {
  lastUsedWrites.clear();
}
