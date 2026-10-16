# Judge Unification and Scaling Plan

**Status:** proposed, not started. Written 2026-10-16.
**Goal:** one execution pipeline behind every API surface, with per-client identity,
metering and burst handling, supporting both LeetCode-style (`function`) and
stdin/stdout (`stdin`) problems — so the judge can be sold as a service.

---

## 1. Where we are today

There are two execution paths, and they share almost nothing.

| | Queue path | Shim path (`/raw-run`) |
|---|---|---|
| Entry points | frontend, `/integration/submissions`, `/arventiq/submissions` | `/api/codeAssess/*` (Judge0-compatible) |
| Transport | RabbitMQ | direct synchronous HTTP |
| Problem model | yes (`function` or `stdin`) | none — raw source + one stdin |
| Test cases | N per submission, judged internally | 1 per call, **caller-driven** |
| Batching | yes (`shouldUseBatchedExecution`) | not applicable |
| Retry / DLQ | yes (`*_retry` TTL 5s, `submission_dead_letters`) | none — failure is just a 5xx |
| Persisted to Mongo | yes (`submissions`, `problems` counters) | **no** |
| `usageevents` written | yes | **no** |
| Honours `JUDGE_WORKER_CONCURRENCY` | yes | **no** |
| Honours `JUDGE_BATCH_THRESHOLD_*` | yes | **no** |
| Honours pool size / autoscaling | yes | yes (shared pool) |

### 1.1 The good news

`StrategyRegistry` (`judge-service-go/strategy.go`) already maps
`ProblemType -> ExecutionStrategy`, with `FunctionExecutionStrategy` and
`StdinExecutionStrategy` both registered. **Both problem styles already run through one
pipeline** that persists, meters, retries and dead-letters correctly.

So this plan is not "build a second queue". It is "stop bypassing the one we have".
`/raw-run` is the only thing outside the unified pipeline.

### 1.2 The blocking problem: there is no per-client identity

All three external surfaces authenticate against a **single global shared secret** read
from env (`TESTING_PLATFORM_KEY`, `ARVENTIQ_SECRET`, `CODEASSESS_SHIM_KEY`). There is no
`ApiClient` model anywhere in `assessment-api/models/`.

Consequences, all of which block selling this:

- Cannot attribute a submission to a customer, so cannot meter or invoice.
- Cannot revoke one customer without rotating the key for every customer.
- Cannot rate-limit or quota per customer — the existing
  `COLLEGE_SUBMISSION_QUOTA` / `STUDENT_SUBMISSION_QUOTA` knobs key off `collegeId`,
  which external callers do not have.
- `UsageEvent` requires `collegeId` / `userId` / `submissionId`. The shim has none of
  the three, which is *why* it writes no usage events. The missing metering is a
  symptom of the missing identity, not an independent bug.

**Identity must come first.** Everything else in this plan depends on it.

### 1.3 The efficiency problem: one compile per test case

`/raw-run` accepts a single `stdin` per call and has no concept of a test case. With the
Judge0 shim, the *caller* loops the test cases. A 6-test Java problem therefore costs:

| Path | Compiles | JVM starts |
|---|---|---|
| Shim, 6 test cases | 6 | 6 |
| Queue path, batching enabled | 1 | 1 |

That is a ~5-6x CPU difference on the two languages students actually use (C++ and
Java). No pool or concurrency tuning recovers it, because the work genuinely is being
done six times. This dwarfs every other tuning knob.

---

## 2. Target architecture

One pipeline. Every surface becomes a thin adapter in front of it.

```
  frontend          /integration/*        /arventiq/*        /codeAssess/*  (Judge0)
      |                   |                    |                   |
      +-------------------+--------------------+-------------------+
                                   |
                        assessment-api  (authN -> ApiClient/tenant,
                                         quota check, Submission doc)
                                   |
                            RabbitMQ submission_queue
                            (+ _retry TTL, + dead_letters)
                                   |
                           judge-service-go worker
                                   |
                        ResolveStrategy(problemType)
                            /                  \
             FunctionExecutionStrategy    StdinExecutionStrategy
                            \                  /
                             processAndStoreResults
                        (submissions, problem counters, usageevents)
```

Key idea: **a raw Judge0 execution is just a `stdin` problem with one test case and no
expected output.** It needs no new execution machinery — only a way to express "this
submission has inline tests and no stored problem".

---

## 3. Phased plan

### Phase 0 — config-only wins (partly done)

No code change, reversible, safe to do before any refactor.

| Setting | Value | Effect |
|---|---|---|
| `JUDGE_BATCH_THRESHOLD_JAVA` | `1` | **done** — enables batching on the queue path |
| `JUDGE_BATCH_THRESHOLD_CPP` | `1` | **done** |
| `JUDGE_POOL_AUTOSCALE_ENABLED` | `true` | **done** — helps both paths (shared pool) |
| `JUDGE_WORKER_CONCURRENCY` | `12` to start (6-core box) | **to measure** — default 24 oversubscribes |

Note the default of 24 is justified in the compose header as "I/O-bound ... Docker API
calls, not local CPU work". That reasoning holds for the Go worker but not for the host:
each sandbox is granted `CPUQuota: 100000` (one full core) and really does burn it.
On a 6-core box, 24 concurrent compile-heavy submissions contend for 6 cores.

**Measure before and after.** The existing capacity numbers (~7-7.5 req/s interpreted,
8-12 req/min compile-heavy) were taken on a smaller VPS and are stale for the current
6-core / 16GB server.

### Phase 1 — `ApiClient` identity and real metering

Prerequisite for everything commercial.

1. New `ApiClient` model: `{ name, keyHash, collegeId|tenantId, scopes[], rateLimit,
   monthlyQuota, active, createdAt, lastUsedAt }`. Store a **hash**, never the key.
2. Replace the three shared-secret middlewares with one key-lookup middleware that
   resolves a request to an `ApiClient`, attaching `req.apiClient`. Keep the existing
   env secrets working as a legacy fallback for one release so nothing breaks mid-term,
   then remove them.
3. Add `apiClientId` to `Submission` and to `UsageEvent`, and carry it on
   `SubmissionMessage` (which already has `CollegeID` — add `ApiClientID` beside it).
4. Admin endpoints + UI to issue, list, revoke and rotate keys.

**Why first:** metering, quotas, per-customer rate limits and revocation all key off
this. Doing it after the unification would mean touching every path twice.

### Phase 2 — route the shim through the queue

This is the unification itself.

1. **Ad-hoc submissions.** Allow a `Submission` with no `problemId`, carrying inline
   test cases and `problemType: "stdin"`. Mark it `kind: "adhoc"` so it is excluded
   from leaderboards, analytics and problem counters.
2. **Judge-side branch.** `processSubmission` currently always calls
   `fetchProblemData(ctx, problemsCollection, submissionMsg.ProblemID)`. Add: when
   `ProblemID` is empty, build the `Problem` in memory from the message
   (`Type: stdin`, `TestCases: submissionMsg.Tests`). `SubmissionMessage` already
   carries `Tests []TestCase`, so this is a small, contained change — roughly 15 lines
   — and everything downstream (strategy dispatch, batching, persistence, metering)
   then works unchanged.
3. **Real Judge0 tokens.** Today the shim returns a fabricated
   `` `sync-${Date.now()}` `` and its GET always 404s. Make the token the submission id,
   and make `GET /submissions/:token` return the real status mapped to Judge0's shape.
   This is *more* Judge0-compatible than today, not less.
4. **Keep `wait=true` working.** Existing callers (including the friend's platform)
   expect a synchronous response. Enqueue, then wait on the result with a bounded
   timeout (Redis pub/sub on submission completion, or poll Mongo). On timeout, return
   the token with a `Processing` status so the caller can poll — which is exactly
   Judge0's own documented behaviour.
5. **Protect interactive latency.** Adding a queue hop helps bursts but can hurt p50
   under light load. Use a RabbitMQ priority queue (or a second `submission_queue_fast`)
   so `wait=true` requests are served ahead of bulk/async work.

After this phase: the shim gets retry, DLQ, persistence, metering, batching and
concurrency control for free, because it is no longer a separate path.

### Phase 3 — Judge0 batch endpoint with same-source coalescing

This is where the 5-6x C++/Java win is actually captured.

1. Implement `POST /submissions/batch`, which real Judge0 CE already defines — so this
   is wire-compatible and callers like `judge.js` can adopt it without inventing
   anything custom.
2. **Coalesce**: group the incoming array by `(language, source_code)`. Each group
   becomes **one** ad-hoc stdin submission with N test cases, so it compiles once and
   (with Phase 0's thresholds) runs batched. Return per-item tokens in request order so
   the caller cannot tell the difference.
3. Document that a caller looping single `POST /submissions` calls per test case is the
   slow path, and that batch is strongly preferred.

This is the single highest-value change for the languages your students use.

### Phase 4 — quotas and backpressure per client

1. Extend the existing quota helpers to key off `apiClientId` as well as
   `collegeId`/`userId`.
2. Enforce at admission (before enqueue), returning `429` with `Retry-After` rather
   than letting the queue absorb unbounded load.
3. Expose queue depth and per-client usage on `/stats` so overload is visible before it
   becomes a timeout.

### Phase 5 — horizontal scale-out (existing H12)

CPU is the ceiling once the above is done. The judge is a stateless worker over
RabbitMQ + Mongo + Redis, so scaling out is mostly operational: run N judge workers on
N hosts, each with its own Docker daemon and container pool. The blocker is that each
worker needs Docker API access on its own host, which rules out most PaaS.

Do this **after** Phases 2-3, since they cut the work per submission by several times
and may remove the need entirely for current load.

---

## 4. Compatibility constraints

- **Do not break the Judge0 wire format.** The shim exists so an external platform can
  point `JUDGE_URL` at us with no code change. Request/response shapes, base64 handling
  and status codes must stay as they are. Phases 2-3 only *add* correct behaviour
  (real tokens, working GET, a batch endpoint).
- **`wait=true` must keep returning a result synchronously** for existing callers.
- **One compose file serves two deployed stacks** (GO Judge and Exam Sandbox, both
  autodeploying from `main`). Any change to `docker-compose.prod.yml` lands on both —
  see `docs/USER_ACTION_ITEMS.md` section 5b.
- **Do not deploy near an exam window.** Exams run on the sandbox stack, and a push to
  `main` restarts it.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Queue hop adds latency to synchronous shim calls | Priority queue for `wait=true`; measure p50/p95 before and after |
| Ad-hoc submissions bloat the `submissions` collection | `kind: "adhoc"` + TTL index on ad-hoc rows; keep `usageevents` as the durable billing record |
| Legacy env-secret callers break during Phase 1 | Keep env secrets as a fallback for one release, log their use, remove once no longer seen |
| Batch coalescing changes observable behaviour | Only coalesce identical `(language, source_code)`; return per-item tokens in request order |
| `-O0` C++ and un-tuned JVM remain the real per-submission cost | Tracked separately — see section 6 |

---

## 6. Related, tracked separately

Not part of the unification, but the same performance conversation:

- **C++ compiles at `-O0`** (`g++ -o /app/main /app/main.cpp`, no `-O` flag) in both
  `pkg/languages/languages.go` and `pkg/central/adapters/cpp.go`. Student solutions run
  roughly 3-10x slower than under the `-O2` every competitive judge uses, which is a
  fairness problem as much as a speed one.
- **Precompiling `<bits/stdc++.h>`** into `judge-cpp-env` typically cuts g++ wall time
  from ~1.5s to ~0.3s. Image-only change, no runtime risk, biggest single C++ win.
- **Java has no startup tuning.** `-XX:TieredStopAtLevel=1 -XX:+UseSerialGC
  -Xshare:auto`, plus an AppCDS archive baked into `judge-java-env`.
- **Java runs with no heap cap on the live path.** `languages.go` sets `-Xmx256m` but
  `adapters/java.go` — the path actually used, since central compare defaults on — omits
  it. A memory-heavy solution is OOM-killed by Docker instead of producing a clean
  `OutOfMemoryError` / MLE verdict, so the student sees an opaque failure.
- **Adapter/language-table drift is systemic.** `cpp.go` and `java.go` each hardcode
  their own compile/run commands, duplicating `languages.go`. An earlier pass fixed this
  for Go only. Any flag change must be made in both places or it silently will not apply.
  Worth collapsing to a single source before adding the flags above.
