# Operations Runbook

For whoever keeps the platform running. Assumes you have read [`ARCHITECTURE.md`](./ARCHITECTURE.md).

- [1. Environments and deploying](#1-environments-and-deploying)
- [2. Configuration reference](#2-configuration-reference)
- [3. Monitoring](#3-monitoring)
- [4. Capacity and tuning](#capacity-and-tuning)
- [5. Incident playbooks](#5-incident-playbooks)
- [6. Routine tasks](#6-routine-tasks)
- [7. Known risks](#known-risks)

---

## 1. Environments and deploying

| Environment | What it is |
|---|---|
| **Local** | `docker compose up -d --build` from the repo root. The judge builds from source on start (the `dev` Dockerfile stage), so editing Go code and restarting the container is enough |
| **Production: GO Judge** | The stack that serves clients. Autodeploys from `main` |
| **Production: Exam Sandbox** | A second stack built from the **same** compose file, used for exams. Also autodeploys from `main` |

Deployments are managed in Dokploy. **Only the GO Judge project is ours to change.** Other projects on the
same Dokploy instance belong to other people. Do not edit or redeploy them.

### The rules that have already cost us

1. **A push to `main` redeploys both stacks.** One compose file serves both, so any change to
   `docker-compose.prod.yml` lands on the exam stack too.
2. **Never push near an exam window.** A deploy restarts the stack. Check the exam calendar first.
3. **Work on a branch; merge deliberately.** The long-lived work branch carries large unreleased changes. Pushing
   it as is would deploy all of them. Cherry-pick or merge only what you mean to ship.
4. **Re-verify C/C++ question outputs before deploying a judge change** that alters compile flags.

### Deploy checklist

- [ ] No exam in the next few hours on either stack
- [ ] `npx vitest run` (API) and `go test . ./pkg/...` (judge) pass
- [ ] `node scripts/judge_contract_check.mjs --target shim --base http://localhost:<port>` reports `0 difference(s)`, both with and without `--key`
- [ ] New environment variables are set in Dokploy **before** the deploy, if they have no safe default
- [ ] Production secrets are present: `JWT_SECRET`, `TESTING_PLATFORM_KEY`, `ARVENTIQ_SECRET`,
      `CODEASSESS_SHIM_KEY` (the API refuses to start in production without them)
- [ ] After deploying: `GET /api/health` shows every service `connected`; run one submission end to end

### Rolling back

Redeploy the previous commit in Dokploy. The changes in this codebase are additive: new queues
(`submission_queue_fast` and its retry queue), new optional fields, new collections' fields. An older judge
or API running against newer data keeps working, so rolling back is safe. Leftover empty queues are harmless.

---

## 2. Configuration reference

### assessment-api (`src/config/env.js`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `MONGO_URI`, `MONGO_DB_NAME` | | MongoDB connection and database name |
| `REDIS_URI` | | Redis connection |
| `RABBITMQ_URI` (or `RABBITMQ_USER`/`PASS`/`HOST`/`PORT`/`VHOST`) | | Use the separate fields if the password has URL-reserved characters |
| `JWT_SECRET` | **required in production** | Signs user tokens. Shared with a hybrid client's identity provider |
| `TESTING_PLATFORM_KEY` | **required in production** | Legacy shared secret for `/integration` |
| `ARVENTIQ_SECRET` | **required in production** | Legacy shared secret for `/arventiq` |
| `CODEASSESS_SHIM_KEY` | **required in production** | Legacy shared secret for the synchronous judge API |
| `JUDGE_SERVICE_URL` | `http://judge-service-go:8081` | Where the API reaches the judge's internal HTTP |
| `COLLEGE_SUBMISSION_QUOTA` / `..._WINDOW_SECONDS` | 30 / 60 | Whole-college submission rate. **Too low for a big exam; see below** |
| `STUDENT_SUBMISSION_QUOTA` / `..._WINDOW_SECONDS` | 10 / 60 | Per-student submission rate |
| `API_CLIENT_DEFAULT_RATE_PER_MIN` | 0 (none) | Per-minute limit, in test cases, for keys with none of their own |
| `API_CLIENT_DEFAULT_MONTHLY_QUOTA` | 0 (none) | Monthly limit, in test cases, for keys with none of their own |
| `STRIPE_*`, `BILLING_*_URL` | | Optional card billing scaffolding |
| `CORS_ALLOWED_ORIGINS` | | Allowed browser origins |
| `SMTP_*`, `APP_BASE_URL` | | Email and links in email |

Per-key limits are set on the key itself (`PATCH /api/admin/api-clients/:id`) and override these defaults.

### judge-service-go

| Variable | Default | Meaning and when to change it |
|---|---|---|
| `JUDGE_WORKER_CONCURRENCY` | 24 | Bulk workers consuming `submission_queue`. They mostly wait on Docker, but each sandbox burns a full core, so 24 oversubscribes a 6-core host. **Start near 2x cores (12 on 6 cores) and measure** |
| `JUDGE_INTERACTIVE_WORKERS` | 4 | Extra workers for `submission_queue_fast` only. In addition to the above. Raise if many callers use `wait=true` at once |
| `JUDGE_INTERACTIVE_RESERVE` | 1 | Idle containers per language that bulk work will not take, so interactive work always finds one. `0` disables the reservation |
| `DEFAULT_POOL_SIZE` | 2 | Warm containers per language when autoscaling is off |
| `JUDGE_POOL_AUTOSCALE_ENABLED` | off | Grow and shrink each language's pool with demand |
| `JUDGE_POOL_MIN_<ABBR>`, `JUDGE_POOL_MAX_<ABBR>` | per language | Pool bounds. `<ABBR>` is `PY JS TS JAVA C CPP CS GO RS RB PHP KT` |
| `JUDGE_POOL_GLOBAL_CAP` | 60 | Most containers across all languages. **The real ceiling is CPU, not this** |
| `JUDGE_POOL_AUTOSCALE_INTERVAL`, `..._SCALE_UP/DOWN_THRESHOLD_MS`, `..._COOLDOWN` | 15 s, 150/20 ms, 20/180 s | Autoscaler tuning |
| `MAX_EXECUTIONS_PER_CONTAINER` | 100 | A container is replaced after this many runs, to limit drift |
| `JUDGE_BATCH_THRESHOLD_{PY,JS,JAVA,CPP}` | 20 | Stored **function-mode** problems with at least this many tests run them in one batched execution. Does not affect the stdin or public-API path |
| `JUDGE_CENTRAL_COMPARE_{PY,JS,JAVA,CPP,C}` | | Toggles for moving result comparison into the judge for a language |
| `SUBMISSION_QUEUE` | `submission_queue` | Name of the bulk queue (the fast queue is `<name>_fast`) |
| `MONGO_URI`, `MONGO_DB_NAME`, `REDIS_URI`, `RABBITMQ_*` | | Same services as the API. `MONGO_DB_NAME` must match the API's or the judge reads the wrong database |
| `HEALTH_PORT` | 8081 | Internal HTTP (`/health`, `/stats`, `/raw-run`). **Never expose publicly** |
| `LOG_LEVEL` | | `debug`, `info`, ... |

The judge's HTTP port has **no authentication**; the network boundary is the only control. Keep it off the public internet.

---

## 3. Monitoring

| What | Where | Look for |
|---|---|---|
| Overall health | `GET /api/health` | `mongodb`, `redis`, `rabbitmq`, `judge` all `connected` |
| Queue depth, dead letters, per-client monthly usage | `GET /api/admin/queue-stats` (superadmin) | `queues.bulk`/`interactive` climbing; `deadLetters` above 0; `saturation` approaching 1 (publishing fails at 5000) |
| One client's standing | `GET /api/admin/api-clients/:id/usage` | `usedThisMonth` vs `monthlyQuota` |
| Tenant stats | `GET /api/admin/system-stats` (admin: own college; superadmin: all) | |
| Judge pool and acquire-wait metrics | `GET :8081/stats` on the judge, internal only | Rising acquire wait is the scale-up signal |
| Queues directly | RabbitMQ management UI (port 15672, where exposed), or `rabbitmqctl list_queues name messages consumers` | `submission_queue` and `submission_queue_fast` should each have 1 consumer per judge |

A queue depth of `null` means "could not be read", which is **not** the same as empty. It usually means the
judge has not started and has not declared that queue yet.

### Log lines worth searching for

| Log text | Meaning |
|---|---|
| `No available containers for language, routing to retry queue` | The pool is exhausted for that language. Normal in bursts; constant means under-provisioned |
| `Submission exceeded max retries waiting for a container; marking as failed` | Overload: a submission gave up after about a minute |
| `Validation failed` | A malformed message was dead-lettered |
| `legacy shared secret used for scope=...` | A caller is still on an unmetered shared secret |
| `rejected key prefix=... reason=revoked/unknown/scope` | A bad key was presented (the prefix identifies the key without exposing it) |
| `Starting interactive workers` | Startup confirmation of the priority path |
| `stdin runtime stderr` | A student's program wrote to stderr. Not a platform fault |

---

## Capacity and tuning

### The model

The judge is **CPU-bound**. Each sandbox is allowed a full core and really uses it, so throughput is set by
host cores, not by memory, container count or worker count. Past a small number of concurrent compile-heavy
runs, adding concurrency only raises latency.

Measured on the 8-core development machine, mixed C++/Java/Python through the public API:

| Concurrent | Throughput | p50 | p95 |
|---|---|---|---|
| 1 | 0.51 /s | 2.0 s | 3.8 s |
| 4 | 0.84 /s | 4.8 s | 8.2 s |
| 8 | 0.89 /s | 7.2 s | 14.9 s |
| 16 | 0.83 /s | 12.1 s | 27.4 s |

The knee is near 4, and 16 is *worse* than 8. Earlier measurements on a small VPS: interpreted languages about 7
requests/s sustained; slow-compiling languages (C#, Kotlin, Go) 8-12 requests/min each. **Re-measure on the
production host before trusting any of these.**

### Measuring your own host

```bash
# Contract + latency; run against a local or staging stack, never production.
node scripts/judge_contract_check.mjs --target shim --base http://localhost:3100 --key <key> \
     --filter accepted --repeat 24 --concurrency 4
```

Run it at concurrency 1, 4, 8, 16 and find where throughput stops rising. That knee, times 60, is your
sustainable executions per minute `C`. Size per-client limits from it
([`CLIENT_ONBOARDING.md`](./CLIENT_ONBOARDING.md#5-choosing-limits)).

### What helps and what does not

| Change | Effect |
|---|---|
| Clients using **batch** | ~3.5x for C/C++/Java; the single biggest lever |
| More CPU cores | Raises the ceiling directly |
| Lower `JUDGE_WORKER_CONCURRENCY` toward 2x cores | Stops oversubscription; improves tail latency |
| Raising pool sizes or the global cap | Little once CPU is saturated; adds contention |
| Autoscaling on | Helps bursty load across languages; does not raise the ceiling |
| Faster compile flags / precompiled headers / JVM startup flags | Cuts per-run CPU; listed as follow-ups in the plan |

### Exam-day settings

Before a large exam, in this order:

1. Raise `COLLEGE_SUBMISSION_QUOTA` (default 30/min is far below hundreds of students). Judge capacity must
   support what you set.
2. Confirm `JUDGE_WORKER_CONCURRENCY` suits the host.
3. Warm the pool (start the judge a few minutes early).
4. Make sure no deploy is scheduled.
5. Watch `queue-stats` during the exam.

---

## 5. Incident playbooks

### Submissions stay "Pending" or "In Queue"

1. `GET /api/health`: is `judge` connected? Is `rabbitmq`?
2. `queue-stats`: is `bulk`/`interactive` growing? Is `deadLetters` above 0?
3. Is the judge consuming? `rabbitmqctl list_queues name consumers` should show consumers on both queues.
   If not, restart the judge.
4. Judge logs: repeated `No available containers` means the pool is exhausted or Docker is unhealthy.
5. Find the stuck rows:
   ```js
   db.submissions.find({ status: "Pending", createdAt: { $lt: new Date(Date.now() - 10*60*1000) } }).count()
   ```
6. Re-queue one stuck stored-problem submission with `assessment-api/scripts/requeue_one.mjs`, or use the rejudge
   endpoints (`/api/admin/rejudge/submission/:id`, `/problem/:id`, `/assessment/:id`).

Ad-hoc (public API) rows are deleted after 24 hours regardless.

### `503 Service Overloaded` or `Queue Service Unavailable`

- *Overloaded*: a queue passed 5000 messages. The judge cannot keep up. Check `queue-stats`, look for a client
  flooding (the per-client table shows who), and consider lowering that client's `rateLimitPerMin`.
- *Unavailable*: the API cannot reach RabbitMQ. Check the broker. The legacy synchronous path still works.

### A client reports `429`

1. `GET /api/admin/api-clients/:id/usage`: compare `usedThisMonth` with `monthlyQuota`, `usedThisMinute` with
   `rateLimitPerMin`.
2. Per-minute: is the client's traffic legitimately bursty? Raise `rateLimitPerMin` or tell them to batch.
3. Monthly: is it a real overage? Raise `monthlyQuota` (and invoice) or leave the stop in place. Policy is the owner's.
4. A `422` with `exceeds_rate_limit` means a single request is larger than the whole per-minute allowance; raise
   the limit or have them send fewer cases per request.

### Dead letters are growing

Messages in `submission_dead_letters` were rejected permanently (malformed, unsupported, too large). Peek with the
management UI. Common causes: a client sent a problem the judge cannot run, or a version mismatch between API and
judge. The affected submission rows stay `Pending` until deleted or re-queued.

### The judge is unhealthy or containers are not coming up

- Is Docker healthy on the host? Is `docker-socket-proxy` running? The judge talks to Docker only through it.
- Are the language images present (`judge-<lang>-env`)? A missing image means that language fails.
- Check disk space on the Docker host: images and workspaces fill disks.
- Restart the judge. It rebuilds its pool on start.

### Redis is down

Quotas **fail open** (everything is admitted) and the result cache is skipped; a judge that is already running
keeps working. When Redis returns, per-client monthly counters re-seed themselves from `usageevents`. Per-minute
counters restart empty. Expect a noisy client to go unlimited for the duration.

**Caveat: the judge connects to MongoDB, Redis and RabbitMQ at startup and exits if any is unreachable.** So a
judge restarted *while* one of them is down will not come back until it returns. Bring dependencies up first,
then the judge.

### A client's key may have leaked

1. `DELETE /api/admin/api-clients/:id` (instant; their calls get `401`).
2. Issue a new key, hand it over securely.
3. Check their usage for the exposure window: unusual spikes show in `usage` and `queue-stats`.

### Latency for `wait=true` callers is high

- Check the interactive queue depth. If it is large, `JUDGE_INTERACTIVE_WORKERS` is too low for the demand.
- If it is empty but latency is high, containers may be exhausted: all of a language's containers busy. Raise that
  language's pool max or add CPU.
- Remember the floor: interactive work waits for about one in-flight submission at worst, because nothing
  interrupts a running container.

---

## 6. Routine tasks

| Task | How |
|---|---|
| Issue a key | `POST /api/admin/api-clients` (see [`CLIENT_ONBOARDING.md`](./CLIENT_ONBOARDING.md)) |
| Change limits | `PATCH /api/admin/api-clients/:id` |
| Revoke | `DELETE /api/admin/api-clients/:id` |
| Rotate a key | Issue new, switch the client, revoke old |
| Monthly usage for invoicing | `GET /api/admin/api-clients/:id/usage`, or aggregate `usageevents` summing `testCount` (missing means 1) |
| Backup / restore | Superadmin `GET /api/admin/backup`, `POST /api/admin/restore`; restore-test before first real exam (Admin Guide) |
| Find clients still on legacy secrets | Search judge/API logs for `legacy shared secret used` |
| Retire a legacy secret | Only when logs show it unused for a full billing cycle |

---

## Known risks

Things that are true today and that an operator should keep in mind. None are emergencies; each is a decision or a
fix waiting for its turn.

| Risk | Detail | What to do |
|---|---|---|
| **IP rate limits may be global behind a proxy** | The API never sets `trust proxy`. If production sits behind a reverse proxy, every request appears to come from the proxy's IP, so the per-IP limiters (login: 100 per 15 min) apply to **all users combined**. Audit-log IPs would also all be the proxy's | Verify with a request from two different networks. If confirmed, set Express `trust proxy` to the proxy's hop count. Not changed yet because it alters live behaviour |
| **Legacy shared secrets are unmetered** | A client on one has no identity: no usage, no quota, no revocation without rotating for everyone | Issue every client a real key; then retire the secrets |
| **Unescape step corrupts some stored-problem code** | Live today for function-mode Python/JS/TS/Ruby/PHP/C# and all stored stdin problems. See [`FRIEND_PORTAL_CHANGES.md`](./FRIEND_PORTAL_CHANGES.md#7-a-separate-issue-worth-deciding-on-source-unescaping-already-on-production) | Run the two queries there on production, then decide |
| **Fixed-window limits allow up to 2x across a boundary** | Accepted: the aim is to stop a runaway client, not meter exactly | Billing reads the exact `usageevents` record |
| **No per-client fairness inside a queue** | Each queue is a single FIFO. A rate limit bounds how much one client can enqueue, which is the protection | Future work if one client's burst starts hurting another's latency |
| **One judge host** | No redundancy; Docker access needs the host's own daemon | Horizontal scale-out is plan Phase 5 |
| **`usageevents` is kept forever** | Contains tenant, user and client identifiers | Set a retention policy (an owner decision) |
| **Stuck rows if the judge dead-letters a message** | The row stays `Pending`/`In Queue` | Watch `deadLetters`; ad-hoc rows expire in 24 h |
| **Idempotency** | No idempotency keys: a retried `POST` after a timeout can run and be counted twice | Documented for clients |
