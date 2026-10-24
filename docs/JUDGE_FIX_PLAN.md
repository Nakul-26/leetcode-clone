# Judge Fix Plan

**Created:** 2026-10-23 · **Last updated:** 2026-10-24 (R1-R7, R9, F1, C1-C3 done)

The single list of everything found in the 2026-10-23 judge review, plus the open items already recorded in
[`JUDGE_PERFORMANCE_REVIEW.md`](./JUDGE_PERFORMANCE_REVIEW.md) §5,
[`JUDGE_UNIFICATION_AND_SCALING_PLAN.md`](./JUDGE_UNIFICATION_AND_SCALING_PLAN.md) §6 and
[`FRIEND_PORTAL_CHANGES.md`](./FRIEND_PORTAL_CHANGES.md) §7. We work through it one item at a time. When an item
changes state, update its row (status + date + commit) and the "Last updated" date above, so nothing is missed.

Status: `todo` · `in progress` · `done` · `blocked` (needs a decision or access from the owner) · `wontfix`

Line numbers are as of commit `8a24162` and will drift.

---

## Phase 1 — Reliability: never lose or stall work (small, do first)

| # | Problem | Fix | Size | Status | Date / commit |
|---|---|---|---|---|---|
| R1 | No RabbitMQ reconnect: when the connection drops, every worker loop ends, the process stays up and judges nothing (`main.go` consumer setup) | Watch `NotifyClose` on the connection and channel; on loss, exit with a non-zero code so the container restarts (`restart: unless-stopped`) and redelivers unacked work. Later, in-process reconnect if needed | S | done | 2026-10-23 · `a673d13` · exits on connection/channel loss or all consumers stopping; verified live (RabbitMQ restart → exit 1 → restarted → judging) |
| R2 | `/health` always returns healthy | Report unhealthy when the AMQP connection is closed or the consumers have stopped | S | done | 2026-10-23 · `a673d13` · `/health` returns 503 while not consuming |
| R3 | Shutdown never stops consuming: `ch.Cancel("", false)` matches no consumer, so `workerWg.Wait()` hangs until SIGKILL; in-flight work is killed and re-run | Give both consumers explicit tags and cancel each by tag; add `stop_grace_period` in compose long enough for a run to finish | S | done | 2026-10-23 · `a673d13` · named consumer tags, unstarted prefetched messages returned, `stop_grace_period: 2m`; verified live (stop in 15 s, exit 0) |
| R4 | Several drop paths `Nack(false,false)` without updating the row, so the submission stays Pending forever (bad problem data, unsupported language, strategy setup error, file prep error) | Call `markSubmissionExecutionFailed` before every permanent drop where the submission id is known | S | done | 2026-10-23 · `a673d13` · `dropSubmission` on every permanent drop; verified live (unsupported language → Error) |
| R5 | A missing/deleted problem or invalid problem id is requeued immediately (`Nack(false,true)`): endless hot loop | `ErrNoDocuments` and a bad hex id are permanent: mark failed + drop. Only real DB errors are retried, and through the TTL retry queue, not an instant requeue | S | done | 2026-10-23 · `a673d13` · `errProblemNotFound` → failed; DB errors via `retryLater`; verified live (one log line, no loop) |
| R6 | Redelivered submissions write a second usage event (billing) and bump problem counters again | Upsert the usage event keyed on `submissionId` for queue submissions; only `$inc` problem counters when the submission was not already finished | S | done | 2026-10-23 · `a673d13` · `FindOneAndUpdate` returns the prior row; existing testResult = repeat, no usage event or counter bump; rejudge still counts; verified live |
| R7 | API publishes without publisher confirms; `sendToQueue` returning false is ignored | Use a confirm channel and await the confirm; on failure take the existing 503 + mark-Error + refund path | S | done | 2026-10-24 · confirm channel, publish awaits the broker ack (10 s timeout). Also: the shared channel now reconnects after a broker restart or a channel error (before, the API either crashed on the unhandled `error` event or returned 503 until restarted); `/api/health` triggers a reconnect; admin system-stats reads queue depth on a throwaway channel, not the shared one. Verified live (broker stopped → 503, broker back → same process publishes again) |
| R8 | No recovery for rows stuck Pending (lost message, crash). Also the rejudge loops (`rejudgeProblemSubmissions`, `rejudgeAssessmentSubmissions`) set rows Pending before publishing, so a publish failure mid-loop leaves the rest Pending | Periodic reaper in the API: Pending older than N minutes is re-published once, then marked Error | M | todo | |
| R9 | DB writes in `processAndStoreResults` use `context.Background()` with no timeout: a Mongo stall blocks a worker forever | Bounded context (e.g. 15 s) for the result writes | S | done | 2026-10-23 · `a673d13` · 15 s bound on result writes and `markSubmissionExecutionFailed` |

## Phase 2 — Throughput (biggest capacity wins)

| # | Problem | Fix | Size | Status | Date / commit |
|---|---|---|---|---|---|
| T1 | Every test case always runs, even after a failure. Scoring is all-or-nothing, so a TLE on test 1 of 10 wastes ~9x the limit | Stop at the first failed test for graded submissions (remaining tests marked "not run"); keep full runs for Run/sample tests and ad-hoc API calls. Check the UI copes with "x of y" when stopped early | M | todo | |
| T2 | Containers are discarded after every TLE/MLE, every runtime error on `/raw-run`, and any non-zero exit in function mode | Trust the per-submission reset (kills processes, wipes `/app` + `/tmp`); discard only if the reset fails or Docker reports the container unhealthy | S | todo | |
| T3 | Function mode labels any non-zero exit (e.g. a student's segfault) as a judge "wrapper" error (`central_runner.go` runtime-error branch) | Treat a non-zero exit of the user's program as Runtime Error; keep InternalError only for unparseable wrapper output | S | todo | |
| T4 | Bulk workers are shared across languages and each blocks up to 30 s waiting for a container: a burst in one language starves the others | Per-language admission: a worker only takes on a message when that language has capacity, otherwise send it straight to the retry queue (or per-language queues) | M | todo | |
| T5 | ~6 Docker API calls per test case (exec create/start/inspect + a cleanup exec after every test) | Run the cleanup once per submission (the reset already does it); later, one exec for all tests via an in-container runner [known, perf review §5] | M | todo | |
| T6 | `wait=true` callers poll Mongo every 100 ms each | Redis pub/sub (or a short-lived key) notifying completion; poll as fallback only | M | todo | |
| T7 | [known] C/C++ precompiled `bits/stdc++.h` not built | Build the PCH in `judge-cpp-env` with the exact submission flags; verify it is used (`-H`/`-Winvalid-pch`) | S | todo | |
| T8 | [known] Java: no startup tuning | `-XX:TieredStopAtLevel=1 -XX:+UseSerialGC -Xshare:auto` + AppCDS archive in `judge-java-env`; measure before/after | M | todo | |
| T9 | [known] Kotlin and C# compile slowly (~10 s) | Warm compiler daemon / `csc` direct | L | todo | |
| T10 | The exam portal's legacy synchronous path compiles once per test case | Issue it an API key and move it to the batch endpoint (owner action, see `FRIEND_PORTAL_CHANGES.md`) | S (code) | deferred (owner decision 2026-10-24: later) | |

## Phase 3 — Fairness and correctness

| # | Problem | Fix | Size | Status | Date / commit |
|---|---|---|---|---|---|
| F1 | [known] Stored-problem code is "unescaped": `print("a\nb")` becomes a SyntaxError, `cout << "x\n"` does not compile | Run the two read-only queries in `FRIEND_PORTAL_CHANGES.md` §7 on production; if the first is ~0, remove `UnescapeCode` from the adapters and stdin runner | S | done | 2026-10-24 · prod query returned 0; `UnescapeCode` deleted from all six adapters and the stdin runner. Verified live (Python `print("a
b")` and C++ `cout << "x
"` both Accepted) |
| F2 | [known] Function-mode C/C++ compile at `-O0` while stdin mode uses `-O2` | `-O2` in `cpp.go` / `c.go` (same flags as the PCH, T7) | S | todo | |
| F3 | [known] Function-mode Java has no heap cap | Add `-Xmx` to `adapters/java.go` run commands | S | todo | |
| F4 | Java stdin uses `-Xmx256m` while the default problem memory limit is 256 MB: heap + JVM overhead exceeds the cgroup, reported as MLE | Derive `-Xmx` from the problem limit (e.g. limit minus ~64 MB), or give JVM languages a memory allowance | S | todo | |
| F5 | Time limits are wall-clock around `docker exec`: they include exec overhead, JVM start and CPU contention, so verdicts depend on server load | Measure CPU time (cgroup `cpu.stat` / `/usr/bin/time` in the runner) and judge on that, with wall-clock as a 2-3x safety cap; keep busy containers <= physical cores | L | todo | |
| F6 | Batch mode (>= 20 tests) only has a whole-run timeout, so per-test TLE is not enforced; per-test times are ~0 ms | Per-test timing and limit inside the batch wrappers | M | todo | |

## Phase 4 — Security hardening (before selling the API widely)

| # | Problem | Fix | Size | Status | Date / commit |
|---|---|---|---|---|---|
| S1 | Go build cache in `/tmp/.cache` survives between submissions and is writable by the sandbox user: cross-submission cache poisoning is possible in principle | Make the seeded cache root-owned read-only and give each submission a fresh writable GOCACHE layered on it (or wipe it in the reset and accept the cost) | M | todo | |
| S2 | docker-socket-proxy grants CONTAINERS + POST + EXEC: a compromised judge is effectively root on the host | Accept and document, or move to a narrower runtime API; at minimum keep the judge unexposed | M | todo | |
| S3 | Sandboxes share the host kernel | Evaluate gVisor (`runsc`) as the sandbox runtime; measure the overhead | L | todo | |

## Phase 5 — Multiple servers

| # | Problem | Fix | Size | Status | Date / commit |
|---|---|---|---|---|---|
| M1 | `/run` and `/raw-run` are reached by one hostname, so synchronous work cannot spread across judges | Move them onto the queue (the interactive queue already exists), or put a load balancer in front | M | todo | |
| M2 | Second judge server consuming the same queues (perf review §5 / plan Phase 5) | After R1-R6 (redelivery becomes routine with more hosts) | M | todo | |

## Phase 0 — Small cleanups (do alongside Phase 1)

| # | Problem | Fix | Size | Status | Date / commit |
|---|---|---|---|---|---|
| C1 | `/run` uses the server context, not the request's, so a disconnected client does not cancel its run | Use `r.Context()` | S | done | 2026-10-23 · `a673d13` |
| C2 | `assessment-api/src/services/judge.service.js` is dead code (wrong port, `node-fetch` is not a dependency, no callers) | Delete it | S | done | 2026-10-23 · `a673d13` |
| C3 | `MaxSubmissionRetries` comment says "~60 s"; each attempt first waits 30 s for a container, so it is ~7 min | Fix the comment and `ARCHITECTURE.md` §4 | S | done | 2026-10-23 · `a673d13` · also ARCHITECTURE.md §4/§8 and OPERATIONS_RUNBOOK.md |

---

## Change log

| Date | Change |
|---|---|
| 2026-10-23 | Plan created from the judge review; known items folded in |
| 2026-10-23 | Done: R1, R2, R3, R4, R5, R6, R9, C1, C2, C3. Verified on the local Docker stack (missing problem, unsupported language, redelivery, rejudge, graceful stop, RabbitMQ restart). Judge unit tests pass except the two symlink tests that need admin rights on Windows; API suite passes (3 files flaky only under full parallel run). Dev compose judge now has `restart: unless-stopped` |
| 2026-10-24 | Done: F1 (owner ran the prod query: 0 pre-escaped submissions) and R7 (confirmed publish + API reconnect). T10 deferred by the owner. API suite 241/241; judge tests pass except the Windows symlink pair |
