# Architecture

How the platform fits together, and why. Read this first if you are going to change anything.

For *operating* it see [`OPERATIONS_RUNBOOK.md`](./OPERATIONS_RUNBOOK.md); for *working on the code* see
[`DEVELOPER_GUIDE.md`](./DEVELOPER_GUIDE.md); for *the judge's public API* see
[`GO_JUDGE_API.md`](./GO_JUDGE_API.md).

- [1. What this is](#1-what-this-is)
- [2. Components](#2-components)
- [3. The three ways code gets run](#3-the-three-ways-code-gets-run)
- [4. Inside the judge](#4-inside-the-judge)
- [5. Identity, tenancy and quotas](#5-identity-tenancy-and-quotas)
- [6. Data model](#6-data-model)
- [7. Invariants (do not break these)](#7-invariants-do-not-break-these)
- [8. What fails open, and what fails closed](#8-what-fails-open-and-what-fails-closed)
- [9. Decision log](#9-decision-log)
- [10. Where things live](#10-where-things-live)

---

## 1. What this is

Two products share one codebase and one deployment:

1. **The assessment platform.** A multi-tenant web application for colleges: students, faculty and admins,
   problem banks, timed assessments, proctoring events, placement drives and interviews.
2. **GO Judge.** The code-execution service underneath it, also sold on its own through a public API for
   platforms that have their own students and only need code run safely.

The judge is the shared, scarce resource. Everything else is ordinary CRUD around it. Most design effort
in this repository goes into one question: *how do we run a lot of untrusted student code, quickly,
fairly, and accountably, on a few CPU cores?*

---

## 2. Components

```
                    +---------------------------+
   students ------> |  frontend (React / Vite)  |
                    +-------------+-------------+
                                  | HTTPS, JWT (cookie or Bearer)
   partner platforms              v
   (API key / secret) ---> +-------------------+      +----------+     +-----------+
                           |   assessment-api  | ---> |  MongoDB | <-- |           |
                           |   (Node/Express)  | ---> |  Redis   |     |           |
                           +---------+---------+      +----------+     |           |
                                     | publish                          |           |
                                     v                                  |           |
                           +-------------------+   consume   +----------------------+
                           |     RabbitMQ      | ----------> |   judge-service-go   |
                           | submission_queue  |             |   (Go)               |
                           | submission_queue  |             |  worker pool, runner |
                           |   _fast  (+retry) |             +----------+-----------+
                           +-------------------+                        | Docker API
                                                              (via docker-socket-proxy)
                                                                         v
                                                    +----------------------------------------+
                                                    | pooled sandbox containers, one image   |
                                                    | per language, no network, CPU/mem caps |
                                                    +----------------------------------------+
```

| Component | Tech | Responsibility |
|---|---|---|
| `assessment-api` | Node 18+, Express, Mongoose | All HTTP APIs, auth, tenancy, quotas, billing, publishing submissions |
| `judge-service-go` | Go | Consumes the queues, owns the container pool, runs and (for stored problems) judges code, writes results |
| `frontend` | React, Vite | Student/faculty/admin UI |
| MongoDB | | Source of truth: users, problems, submissions, usage |
| Redis | | Quota counters, caches, submission result cache. **Not** a source of truth |
| RabbitMQ | | Durable work queues between the API and the judge |
| `docker-socket-proxy` | | Restricts what the judge may ask the Docker daemon to do |
| Language images | One per language (12) | The sandboxes: `judge-<lang>-env` |
| `coturn` | Prod only | TURN relay for WebRTC interview video |

The API never executes code. It validates, attributes and enqueues; the judge executes. They share only
the queue and the database, so they scale and fail independently.

---

## 3. The three ways code gets run

All three end at the same judge, but they differ in who is asking and what the judge is told.

### 3.1 Stored-problem submissions (frontend, `/integration`, `/arventiq`)

```
client -> POST /submissions            (or /integration/submissions, /arventiq/submissions)
          -> submitSolution()           assessment-api/src/services/submissions.service.js
               checks: student quota, college quota, plan limit, API-client quota
               creates Submission {status: Pending, problemId, ...}
               publishes message -> submission_queue
judge:     consumes, loads the Problem from Mongo, runs every test case, compares, writes
           Submission {status, testResult} + a usage event
client  <- polls GET /submissions/:id   (or reads Redis-cached result)
```

A problem is either **function-mode** (LeetCode style: a named function with typed parameters; the judge
generates a wrapper that calls it) or **stdin-mode** (a whole program reading stdin, compared as text).
The judge picks the `ExecutionStrategy` from the problem's type (`strategy.go`).

### 3.2 GO Judge public API: keyed clients (queue-backed)

```
client -> POST /api/codeAssess/submissions[/batch]      x-rapidapi-key: ak_...
          -> apiClientAuth             resolves the ApiClient, scope "codeassess"
          -> admitApiClient()          per-minute / per-month quota, in TEST CASES
          -> enqueueGroup()            creates an AD-HOC Submission (kind: "adhoc", no problemId)
                                       publishes -> submission_queue_fast
judge:     builds the Problem IN MEMORY from the message, runs it like any stdin problem
           with no expected output ("run and report, do not judge")
client  <- wait=true: the API polls Mongo for up to 25 s and answers;  else 201 {token}
        <- GET /submissions/:token   or   GET /submissions/batch?tokens=...
```

Items in a batch that share a language, source and limits are **coalesced** into one ad-hoc submission with
one test case each, so the source compiles once. Each item still gets its own token (`<id>.<index>`).

### 3.3 GO Judge public API: legacy shared-secret callers (synchronous)

```
client -> POST /api/codeAssess/submissions             x-rapidapi-key: <CODEASSESS_SHIM_KEY>
          -> runRawCodeAssess() -> judge-service-go POST /raw-run   (direct HTTP, no queue)
client <- the result, synchronously
```

This is the **original** path, kept exactly as it was so the existing exam portal is unaffected. It has no
queue, no retry, no persistence and no metering, because it has no identity to attribute anything to. Its
only way out is for the caller to be issued a real key. **Identity is the rollout flag**: giving a client a
key is what moves it onto 3.2.

`/raw-run` and the queue's stdin path now share one definition of how to build and run each language
(`pkg/central/adapters/stdin_adapter.go`), so the two cannot drift apart again.

---

## 4. Inside the judge

```
RabbitMQ                    workers                    pool                      sandbox
submission_queue      ---> N bulk workers  ----+
  (+ _retry, 5 s TTL)                          +--> Acquire/AcquireBulk --> container (per language)
submission_queue_fast ---> M interactive   ----+                              compile once, run per test
  (+ _fast_retry)            workers
```

- **Two queues, two worker groups.** Interactive work (a caller waiting on `wait=true`) has its own queue
  and its own workers (`JUDGE_INTERACTIVE_WORKERS`) so it is never stuck behind bulk work.
- **A reserve of containers.** Bulk work uses `AcquireBulk`, which leaves `JUDGE_INTERACTIVE_RESERVE`
  idle containers per language for interactive callers. Without both of these the priority queue is
  priority in name only (see the decision log).
- **Pool.** Containers are pre-warmed per language, reused, and discarded after
  `MAX_EXECUTIONS_PER_CONTAINER` or if a run leaves them suspect. An optional autoscaler grows and shrinks
  each language between a min and a max, within a global cap.
- **Retry.** If no container is free, the message goes to a TTL'd retry queue (5 s) and comes back, up to
  12 times (each attempt first waits up to 30 s for a container, so about 7 minutes), then the submission is marked failed. Permanent failures (bad message) go to
  `submission_dead_letters`.
- **Persistence.** For every submission the judge updates the `Submission` row, bumps problem counters (for
  stored problems), caches the result in Redis for an hour, and inserts a `usageevent`.

### Compile once, run many

For compiled languages (C, C++, Java, Kotlin, Rust, Go, C#) the stdin runner compiles the source once and
then runs the binary once per test case. This is why batching helps compiled languages ~3.5x and
interpreted ones hardly at all. Java still starts a JVM per test case; only `javac` is shared.

### Where results come from

A stdin test with no expected output is **not judged**: it passes if it ran to completion. A test with an
expected output is compared with `comparator.CompareText`. The public API always sends no expected output.

---

## 5. Identity, tenancy and quotas

### Who can call what

| Caller | Credential | Resolved to | Used for |
|---|---|---|---|
| Person | JWT (cookie or `Authorization: Bearer`) | `User` with a role and a `collegeId` | The web app |
| Partner (keyed) | `ak_<8 hex>_<token>` | `ApiClient` | `/integration`, `/arventiq`, `/codeAssess` |
| Partner (legacy) | A shared secret from the environment | nothing | Same routes; **unattributable, unmetered** |

`apiClientAuth` (`middleware/apiClient.mjs`) is the single authenticator for all keyed callers. Each
surface supplies its own header and keeps its own 401 body, because those are part of a contract with
callers we do not control. A key has **scopes** (`integration`, `arventiq`, `codeassess`); a wrong-scope,
revoked or unknown key all produce the *same* 401, so a probe learns nothing.

Keys are random, shown once, and stored only as a sha256 hash (safe because they are high-entropy, unlike
passwords). They are looked up by hash with one indexed query.

### Tenancy

The tenant is a **college**. Every user, problem, assessment, API client and usage event carries a
`collegeId`, taken from the authenticated principal, **never from the request body**. A non-superadmin
who names another college is ignored. A request for another college's resource returns **404**, not 403:
a 403 would confirm the id exists.

### Quotas, from the outside in

| Layer | Scope | Unit | Window | Where |
|---|---|---|---|---|
| Express IP limiters | per IP | requests | 15 min / 1 min | `app.js` |
| Student quota | per user | submissions | 60 s | `quota.service.js` |
| College quota | per college | submissions | 60 s | `quota.service.js` |
| Plan limit | per college | submissions | month | `billing.service.js` |
| **API client quota** | per `ApiClient` | **test cases** | 1 min and calendar month | `apiClientQuota.service.js` |

The API-client quota counts **test cases**, not requests, because a batch of twenty is twenty executions;
counting requests would let a client dodge both its limit and its bill.

Admission is **reserve, then refund**: units are taken before enqueueing and given back if the request is
refused later or the enqueue fails. The monthly counter lives in Redis for speed but is **seeded from the
durable `usageevents` record** whenever its key is missing, so a Redis restart cannot hand a client a fresh
month. Billing reads `usageevents`, never Redis.

---

## 6. Data model

| Collection | Notable fields | Notes |
|---|---|---|
| `colleges` | name, slug, `planId` | The tenant |
| `users` | role, `collegeId` | Roles: student, faculty, admin, superadmin |
| `problems` | `problemType` (function / stdin / mcq / subjective), testCases | Per college |
| `assessments`, `assessmentattempts` | | Timed exams and a student's attempt at one |
| `submissions` | `problemId` (absent when ad-hoc), `kind`, `apiClientId`, `expiresAt`, `status`, `testResult` | Ad-hoc rows expire after 24 h via a TTL index |
| `usageevents` | `apiClientId`, `collegeId`, `userId`, `language`, `status`, `elapsedMs`, **`testCount`** | Written by the **judge**, directly. The durable billing record. No source or output |
| `apiclients` | `keyPrefix`, `keyHash`, `collegeId`, `serviceUserId`, `scopes`, `rateLimitPerMin`, `monthlyQuota`, `active` | Revoked = `active:false`, never deleted |
| `drives`, `drivecandidates`, `interviewslots` | | Placement workflow |
| `auditlogs`, `systemsettings` | | |

The judge writes `submissions` and `usageevents` with the raw Mongo driver, **bypassing Mongoose**. The
Mongoose models exist so the API can query and index them; they do not gate the judge's writes. Add a field
to both sides.

A `submission` row's `userId` is required, so each `ApiClient` owns a **service user** that its ad-hoc
submissions belong to.

---

## 7. Invariants (do not break these)

1. **Tenant id comes from the principal, never from the request body.** Every list/get/update is scoped, and
   a miss is a 404.
2. **A key is shown once and stored hashed.** Never log it, return it twice, or store it.
3. **A 401 reveals nothing.** Unknown, revoked and wrong-scope keys are indistinguishable.
4. **Each surface keeps its own error shape.** Changing a public 401/4xx body breaks callers we cannot see.
5. **Quota units are test cases, and every reservation has a matching refund path.** A client must never be
   charged for work that did not run.
6. **Billing reads `usageevents`.** Redis counters are an optimisation and may be lost.
7. **`testCount` is the unit of usage.** Anything counting "submissions" for billing must read it (a missing
   value means 1, for rows written before it existed).
8. **Ad-hoc is explicit.** `kind: "adhoc"` is a marker, not inferred from a missing `problemId`; a bug that
   dropped `problemId` must never silently turn a real submission into an unjudged "Accepted".
9. **Source is run as written on the public path.** No unescaping, no rewriting.
10. **The judge never trusts caller-supplied limits.** They are clamped (60 s, 2 GB) on the ad-hoc path as
    they always were on `/raw-run`.
11. **The legacy synchronous path stays byte-for-byte compatible** until every caller has a key. The contract
    harness is the test (see the developer guide).
12. **Adding a queue argument to an existing queue breaks publishing.** RabbitMQ refuses to redeclare a queue
    with different arguments (`PRECONDITION_FAILED`). Add new queues instead.

---

## 8. What fails open, and what fails closed

| If this is down... | ...then |
|---|---|
| Redis | Quotas **fail open** (everything is admitted); submission result cache is skipped. The judge keeps working. Counters re-seed from Mongo on recovery |
| RabbitMQ | Publishing fails: `503 Queue Service Unavailable`, the row that was created for it is marked `Error` (not left `Pending`), and quota units are refunded. The legacy synchronous path is unaffected |
| MongoDB | Everything that needs state fails. The legacy synchronous path's own logic needs no database, but keyed callers cannot be authenticated and nothing is persisted |
| The judge | Submissions queue up and are processed when it returns (or dead-letter after retries). The API stays up |
| Docker / the pool | Submissions retry for about 7 minutes (12 attempts of a 30 s container wait plus 5 s), then fail with an explanatory error |
| Queue depth over 5000 | Publishing is refused with `503` and a retry hint |

A key principle: **a failure of the *fairness* machinery must not stop the *work***. That is why quotas fail
open. The cost is that during a Redis outage a noisy client is not limited.

---

## 9. Decision log

Each entry records a decision a future maintainer is likely to want to revisit, and the reason.

| Decision | Why |
|---|---|
| **Test cases, not requests, are the unit of quota and usage** | A batch of 20 is 20 executions. Counting requests lets a client dodge limits and billing by batching |
| **A second queue (`_fast`) instead of RabbitMQ priority** | Adding `x-max-priority` to the existing queue fails with `PRECONDITION_FAILED` and takes publishing down on both deployed stacks until someone deletes the queue by hand. A new queue is additive in both directions |
| **Dedicated interactive workers *and* a container reserve** | The first design (check the fast queue first) did not work: a 60-job bulk backlog left a waiting request "In Queue" past its 25 s cap, because every worker was blocked waiting for a container and Go wakes blocked receivers in FIFO order. Measured after the fix: 3.1-3.4 s vs 1.8 s idle |
| **Keyed callers go through the queue; legacy callers stay synchronous** | Moving the existing exam portal mid-term risks an exam. A key is also the only way to attribute usage. Identity doubles as the rollout switch |
| **Coalesce by (language, source, limits)** | Only identical programs can share a compile. Anything looser would change observable behaviour |
| **Group size capped by worst-case run time** | The judge gives one submission a fixed 120 s budget including compile; ten cases that each time out at 10 s would starve the rest |
| **Monthly counter seeded from `usageevents`** | A Redis restart must not give a client a free month |
| **A request larger than the per-minute limit is a 422, not a 429** | Retrying can never succeed, and a client that retries a 429 forever would spin |
| **Revoke deactivates, never deletes** | Historical usage must stay attributable for invoicing |
| **404, not 403, across tenants** | A 403 confirms the id exists |
| **Outputs always base64 in responses** | The original synchronous path did this; changing it would break existing callers |
| **`expected_output` is ignored** | The original path ignored it; callers compare themselves |
| **Ad-hoc source is not unescaped** | The unescape step corrupts any string literal containing a backslash escape. See the portal-changes doc, section 7 |
| **Ad-hoc rows expire after 24 h** | Keeps the submissions collection from growing with every "Run" click. `usageevents` is the durable record |
| **Per-client fairness inside the queue is not implemented** | Each queue is a single FIFO. A client's rate limit bounds how much it can enqueue, which is the protection today. True per-client queues are future work |

---

## 10. Where things live

```
assessment-api/
  models/                     Mongoose models (ApiClient, Submission, UsageEvent, ...)
  src/app.js                  middleware stack, IP limiters, route mounting (/api and /api/v1)
  src/routes/*.routes.js      HTTP routing; admin.routes.js holds /api-clients and /queue-stats
  src/controllers/            request/response handling
    codeAssessShim.controller.js   the public judge API (single, batch, GET)
  src/services/               business logic
    submissions.service.js         submitSolution (shared by all stored-problem surfaces)
    adhocExecution.service.js      ad-hoc enqueue, coalescing, tokens, result shaping
    apiClientQuota.service.js      admission control (reserve / refund)
    apiClients.service.js          key issuing, update, revoke, usage
    queueStats.service.js          queue depth + per-client usage table
    codeAssessShim.service.js      the legacy synchronous path and the language-id map
    evaluation.service.js          publishing to RabbitMQ
  src/middleware/apiClient.mjs     the single keyed authenticator
  src/config/env.js                every API setting, with defaults

judge-service-go/
  main.go                     startup, queues, workers, processSubmission, /raw-run, /stats
  strategy.go                 ExecutionStrategy (function vs stdin)
  stdin_runner.go             stdin execution: compile once, run per test case
  central_runner.go           function-mode execution
  pkg/central/adapters/       per-language wrappers (function) and stdin_adapter.go (one def for all 12)
  pkg/pool/                   container pool, AcquireBulk, autoscaler
  pkg/executor/               talks to Docker: copy, compile, run, limits
  pkg/models/                 SubmissionMessage, Problem, results
  environments/<lang>/        Dockerfile for each language's sandbox image

scripts/judge_contract_check.mjs     the contract harness
scripts/tests/*.json                 recorded baseline
docs/                                you are here
```
