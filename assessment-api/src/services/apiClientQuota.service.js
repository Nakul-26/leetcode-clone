import ApiClient from "../../models/ApiClient.mjs";
import UsageEvent from "../../models/UsageEvent.mjs";
import { getRedis } from "../config/redis.js";
import { env } from "../config/env.js";

// Admission control for external API clients (plan Phase 4). Runs before anything is
// enqueued, so an over-limit caller is told "429, retry in N seconds" instead of the queue
// absorbing unbounded load and every other client's latency paying for it.
//
// The unit is a TEST CASE, not a request. A batch of six is six units. Counting requests
// would let a client send twenty cases in one batch and meter, and be limited, as one: the
// same reason UsageEvent carries testCount.
//
// Two independent limits, both per client, both opt-in. A limit of 0 (the default) means
// "no limit", so nothing changes for an existing client until someone sets one:
//   rateLimitPerMin  fixed one-minute window; protects the judge from bursts
//   monthlyQuota     calendar month (UTC); the plan allowance a client has bought
//
// Fixed windows allow up to 2x the limit across a window boundary. That is accepted here for
// the same reason the existing college/student quotas accept it: the point is to stop a
// runaway client, not to meter to the unit. Billing reads usageevents, which is exact.

const MINUTE_MS = 60_000;

function resolveLimits(client) {
  return {
    ratePerMin: client.rateLimitPerMin || env.API_CLIENT_DEFAULT_RATE_PER_MIN || 0,
    monthly: client.monthlyQuota || env.API_CLIENT_DEFAULT_MONTHLY_QUOTA || 0
  };
}

function monthBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const label = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start, next, label };
}

/** Test cases this client has executed this calendar month, from the durable record. */
export async function monthlyUsageFromDb(apiClientId, now = new Date()) {
  const { start } = monthBounds(now);
  const [row] = await UsageEvent.aggregate([
    { $match: { apiClientId, createdAt: { $gte: start } } },
    // Events written before testCount existed represent one execution each.
    { $group: { _id: null, units: { $sum: { $ifNull: ["$testCount", 1] } } } }
  ]);
  return row ? row.units : 0;
}

async function ensureMonthlyCounter(redis, client, key, now) {
  if (await redis.exists(key)) return;
  // The counter is missing: first request of the month, or Redis lost its data. Seed it from
  // the durable record so a Redis restart cannot hand a client a fresh month. NX makes a
  // concurrent seeder harmless. Expiry outlives the month so a late request still finds it.
  const used = await monthlyUsageFromDb(client._id, now);
  await redis.set(key, String(used), { expiration: { type: "EX", value: 35 * 24 * 3600 }, condition: "NX" });
}

/**
 * Tries to reserve `units` for the client. Accepts an ApiClient document or its id.
 *
 * Returns { allowed: true, refund } on success. `refund()` gives the units back (or `refund(n)`
 * gives back n) and must be called if the work is then not accepted (enqueue failed), or the
 * client is charged for work that never ran.
 *
 * Returns { allowed: false, code, message, retryAfter } otherwise. `code` is one of
 *   rate_limited            retry after `retryAfter` seconds
 *   monthly_quota_exceeded  retry after the month rolls over
 *   exceeds_rate_limit      one request alone is larger than the per-minute limit; waiting
 *                           will never help, so this is not a 429
 * Fails open if Redis is down, like the other quotas: an outage of the counter must not take
 * the judge down with it.
 */
export async function admitApiClient(clientOrId, units = 1) {
  const noop = { allowed: true, refund: async () => {} };
  const redis = getRedis();
  if (!redis || units <= 0) return noop;

  const client = clientOrId && clientOrId.rateLimitPerMin !== undefined
    ? clientOrId
    : await ApiClient.findById(clientOrId?._id || clientOrId).lean();
  if (!client) return noop;

  const { ratePerMin, monthly } = resolveLimits(client);
  if (!ratePerMin && !monthly) return noop;

  if (ratePerMin && units > ratePerMin) {
    return {
      allowed: false,
      code: "exceeds_rate_limit",
      message: `A request of ${units} test cases exceeds this client's limit of ${ratePerMin} per minute and can never be accepted. Send fewer per request.`
    };
  }

  const now = new Date();
  const taken = [];
  // Gives back everything taken, or only `count` units if some of the work was refused.
  const refund = async (count) => {
    for (const entry of taken) {
      const give = count === undefined ? entry[1] : Math.min(count, entry[1]);
      if (give <= 0) continue;
      entry[1] -= give;
      try { await redis.decrBy(entry[0], give); } catch { /* best effort */ }
    }
  };

  try {
    if (monthly) {
      const { next, label } = monthBounds(now);
      const key = `apiclient_monthly:${client._id}:${label}`;
      await ensureMonthlyCounter(redis, client, key, now);
      const used = await redis.incrBy(key, units);
      taken.push([key, units]);
      if (used > monthly) {
        await refund();
        return {
          allowed: false,
          code: "monthly_quota_exceeded",
          message: `Monthly quota of ${monthly} test cases exhausted.`,
          retryAfter: Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000))
        };
      }
    }

    if (ratePerMin) {
      const windowStart = Math.floor(now.getTime() / MINUTE_MS);
      const key = `apiclient_rate:${client._id}:${windowStart}`;
      const used = await redis.incrBy(key, units);
      taken.push([key, units]);
      if (used === units) await redis.expire(key, 120);
      if (used > ratePerMin) {
        // The monthly units taken above are returned too: a rate-limited request did no work.
        await refund();
        return {
          allowed: false,
          code: "rate_limited",
          message: `Rate limit of ${ratePerMin} test cases per minute exceeded.`,
          retryAfter: Math.max(1, Math.ceil(((windowStart + 1) * MINUTE_MS - now.getTime()) / 1000))
        };
      }
    }
  } catch (err) {
    console.error("API client quota check error, failing open:", err);
    await refund();
    return noop;
  }

  return { allowed: true, refund };
}

/** Current standing for a client, for the admin usage view. Reads only; reserves nothing. */
export async function getApiClientUsage(client, now = new Date()) {
  const { ratePerMin, monthly } = resolveLimits(client);
  const { label } = monthBounds(now);
  const redis = getRedis();

  let usedThisMinute = null;
  if (redis) {
    try {
      const v = await redis.get(`apiclient_rate:${client._id}:${Math.floor(now.getTime() / MINUTE_MS)}`);
      usedThisMinute = v ? Number(v) : 0;
    } catch { /* reported as unknown */ }
  }

  // The durable record, not the Redis counter: this is what a client would be invoiced on.
  const usedThisMonth = await monthlyUsageFromDb(client._id, now);
  return {
    month: label,
    usedThisMonth,
    monthlyQuota: monthly || null,
    remainingThisMonth: monthly ? Math.max(0, monthly - usedThisMonth) : null,
    rateLimitPerMin: ratePerMin || null,
    usedThisMinute
  };
}
