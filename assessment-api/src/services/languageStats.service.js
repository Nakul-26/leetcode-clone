import UsageEvent from "../../models/UsageEvent.mjs";

// Per-language volume and run time across every execution path, so judge optimisation can
// follow real traffic: if C++ and Java dominate, that is where compile caching, warmer pools
// or JVM tuning pays off. Reads usageevents, which the judge writes for queued submissions
// (source "queue", and events from before the field existed), the synchronous /run used by
// "Run" buttons ("run"), and the legacy public-API path ("raw-run"). Ad-hoc submission rows
// expire after a day, so the submissions collection cannot answer this; usageevents can.

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 365;

function clampDays(days) {
  const n = Math.floor(Number(days));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

// Exact percentile by rank: sort by run time and read one document. Mongo 6 (production) has
// no $percentile operator; one indexed lookup per language is cheap at this scale.
async function percentileMs(match, count, p) {
  if (count === 0) return null;
  const rank = Math.min(count - 1, Math.floor(p * (count - 1)));
  const [doc] = await UsageEvent.find(match, { elapsedMs: 1, _id: 0 })
    .sort({ elapsedMs: 1 })
    .skip(rank)
    .limit(1)
    .lean();
  return doc ? doc.elapsedMs : null;
}

export async function getLanguageStats({ days, now = new Date() } = {}) {
  const windowDays = clampDays(days);
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const match = { createdAt: { $gte: since }, language: { $exists: true, $ne: null } };

  const [totals, byStatus, bySource] = await Promise.all([
    UsageEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$language",
          submissions: { $sum: 1 },
          // Events written before testCount existed represent one execution each.
          testCases: { $sum: { $ifNull: ["$testCount", 1] } },
          totalComputeMs: { $sum: { $ifNull: ["$elapsedMs", 0] } },
          avgElapsedMs: { $avg: "$elapsedMs" },
          maxElapsedMs: { $max: "$elapsedMs" },
          timed: { $sum: { $cond: [{ $gt: ["$elapsedMs", null] }, 1, 0] } }
        }
      }
    ]),
    UsageEvent.aggregate([
      { $match: match },
      { $group: { _id: { language: "$language", status: "$status" }, n: { $sum: 1 } } }
    ]),
    UsageEvent.aggregate([
      { $match: match },
      // Events from before the source field existed all came from the queue path.
      { $group: { _id: { language: "$language", source: { $ifNull: ["$source", "queue"] } }, n: { $sum: 1 } } }
    ])
  ]);

  const grandSubmissions = totals.reduce((a, t) => a + t.submissions, 0);
  const grandCompute = totals.reduce((a, t) => a + t.totalComputeMs, 0);

  const languages = await Promise.all(
    totals.map(async (t) => {
      const timedMatch = { ...match, language: t._id, elapsedMs: { $exists: true, $ne: null } };
      const [p50, p95] = await Promise.all([
        percentileMs(timedMatch, t.timed, 0.5),
        percentileMs(timedMatch, t.timed, 0.95)
      ]);
      const statuses = {};
      for (const s of byStatus) if (s._id.language === t._id) statuses[s._id.status || "unknown"] = s.n;
      const sources = {};
      for (const s of bySource) if (s._id.language === t._id) sources[s._id.source] = s.n;
      return {
        language: t._id,
        submissions: t.submissions,
        testCases: t.testCases,
        perDay: Math.round((t.submissions / windowDays) * 10) / 10,
        share: grandSubmissions ? Math.round((t.submissions / grandSubmissions) * 1000) / 10 : 0,
        avgElapsedMs: t.avgElapsedMs == null ? null : Math.round(t.avgElapsedMs),
        p50ElapsedMs: p50,
        p95ElapsedMs: p95,
        maxElapsedMs: t.maxElapsedMs ?? null,
        // Volume x run time: the judge's total time on this language. The best single number
        // for "where would optimisation save the most".
        totalComputeMs: t.totalComputeMs,
        computeShare: grandCompute ? Math.round((t.totalComputeMs / grandCompute) * 1000) / 10 : 0,
        statuses,
        sources
      };
    })
  );

  languages.sort((a, b) => b.totalComputeMs - a.totalComputeMs || b.submissions - a.submissions);

  return {
    windowDays,
    since: since.toISOString(),
    totalSubmissions: grandSubmissions,
    totalPerDay: Math.round((grandSubmissions / windowDays) * 10) / 10,
    languages
  };
}
