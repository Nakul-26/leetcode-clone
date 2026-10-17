# Judge Performance Review

How a submission moves through the judge today, what actually limits throughput, and what to change, in order of
payoff. Written 2026-10-17 after the live load test (see [Operations Runbook](./OPERATIONS_RUNBOOK.md) and the
capacity numbers below). Everything marked **verified** was measured or reproduced; the rest is reasoning from the
code and should be confirmed by re-running the load test after each change.

## 1. The path of one submission

1. The API validates the request, admits it against the client's quota, writes a `submissions` row and publishes a
   message to RabbitMQ (`submission_queue_fast` for interactive work, `submission_queue` for bulk).
2. A judge worker takes the message and borrows an idle container of that language from the pool. Each container
   has **1 CPU, 1 GB of memory**, no network, a read-only root, and two memory-backed scratch areas (`/app` and
   `/tmp`, 512 MB each).
3. The source is written into `/app/sub-<id>/` inside the container (a `docker exec` that untars it).
4. Compiled languages compile once. Then, **for every test case**: set the memory limit (`docker update`), run
   the program (`docker exec`), reset the memory limit (`docker update`), and clean up (`docker exec` that empties
   `/tmp` and kills leftover processes). Interpreted languages also re-upload the source before every test.
5. The result is written to Mongo, a usage event is recorded, and the container goes back to the pool. After 100
   submissions a container is deleted and a new one created in its place.
6. The API answers `wait=true` callers by checking the database every 100 ms.

## 2. What limits throughput today (verified)

The load test reached **~1,700 Python/min (~28/s)** and **~510 C++/min (~8.5/s)**, then flattened. Production runs
**2 containers per language with autoscaling off** (`JUDGE_POOL_SIZE` default 2,
`JUDGE_POOL_AUTOSCALE_ENABLED` default false). 28 Python/s over 2 containers is ~70 ms per run; 8.5 C++/s is ~235
ms per run. So the ceiling we measured is **two containers' worth of work, not the server's CPU**: at most 2 cores
per language were busy.

What this means in an exam: only **two submissions of any one language can execute at the same time**. A Java-heavy
exam is limited to two concurrent JVMs no matter how many cores are idle.

## 3. Findings and fixes, by payoff

### P0. Use the cores you have (configuration only, no code)

| Setting | Today | Suggested start (6-core server; adjust to the real core count) |
|---|---|---|
| `JUDGE_POOL_AUTOSCALE_ENABLED` | false | `true` |
| `JUDGE_POOL_SIZE` (min per language) | 2 | keep `2` (warm floor) |
| `JUDGE_POOL_MAX_<ABBR>` for the busiest languages | 8 (Java, C++), others = min | `6` for CPP, JAVA, PY (use the language statistics to choose) |
| `JUDGE_POOL_GLOBAL_CAP` | 60 | about `2 x cores` (12) so CPU-bound jobs do not thrash each other |
| `JUDGE_INTERACTIVE_WORKERS` | 4 | `8` (this caps how many interactive runs can execute at once, across all languages) |

Expected: up to ~3x throughput on a 6-core box for a single busy language (2 cores busy today, 6 possible), less for
mixed traffic that already spreads across languages. **Verify with the same load test before and after.** Watch
CPU on the server: past full CPU, more containers only add latency (the July finding still holds).

The exam-portal stack runs on the same machine. Whatever headroom this uses is taken from it during load.

### P1. Clean up after every submission (bug, verified)

Each submission's directory in `/app` is **never deleted inside the container**: only the host-side copy and
`/tmp` are cleaned. `/app` lives in memory, so it accumulates inside the container's 1 GB limit until the
100-run recycle discards the container. Measured leftovers per submission: C++ ~20 KB, Kotlin ~12 KB, **Go ~2.3
MB** (100 runs = ~230 MB of the 1 GB a Go program is allowed). Late in a container's life a large Go program can
be reported as Memory Limit Exceeded when it would have fit.

Fix: remove `/app/sub-<id>` in the cleanup step that already runs after each submission (no extra Docker call).
After that, the 100-run recycle is no longer covering a leak and can be raised (for example to 500) as a safety net
for things we cannot predict (zombie processes, fragmented memory).

**Is recycling itself OK?** Yes, as a safety net. Removal is a forced `docker rm` plus deleting the host
workspace, so nothing is left behind, and a periodic job removes any stray exited judge containers. Two things
to improve: see P1c.

### P1b. Go throws away its build cache on every run (verified)

The Go image sets `GOCACHE=/tmp/.cache/go-build`, and the cleanup after each run empties `/tmp`. So every Go
submission recompiles the standard library it uses from scratch. This is the likely cause of the ~15 s Go compiles
measured in July.

Fix: keep the cache across runs (move `GOCACHE` under `/app/.gocache`, which is not wiped, or exclude it from the
`/tmp` cleanup), and pre-build the standard library into the image so even a fresh container starts warm.
Expected: Go compiles drop from seconds to well under a second after the first run in a container.

### P1c. Recycling happens on the worker's critical path

When a container hits its limit, the worker that just used it deletes it and creates the replacement before it
takes more work, and the pool is one container short meanwhile (with 2 containers per language that is half the
capacity for that language, for about a second). The result is already saved, so users do not wait, but
throughput dips. Fix: hand the replacement to the background reconciler (or create it before removing the old one).
Also, `/run` and `/raw-run` never count executions, so their containers never recycle; count them too.

### P1d. Too many Docker calls per test case

Per test case: 2 `docker update` + 2 `docker exec` (+1 upload for interpreted languages), through the
socket proxy. A 10-test Python problem makes ~50 Docker API calls. Fixes, in increasing effort:

- Set the run-phase memory limit once per submission, not twice per test.
- Upload interpreted source once per submission, not once per test.
- Kill leftover processes between tests, but empty `/tmp` once per submission.
- Larger change: run all test cases inside one `docker exec` with a small runner script that applies the
  per-test time limit and separates outputs. Cuts a 10-test problem from ~50 calls to ~4.

### P2. Compile-time wins per language

| Language | Today | Change | Expected |
|---|---|---|---|
| C/C++ | `bits/stdc++.h` takes seconds to compile, every time | Precompiled header for `bits/stdc++.h` in the image | Typical competitive C++ compile from ~2 s to ~0.5 s |
| Java | `javac` + a fresh JVM per test | `-XX:TieredStopAtLevel=1` and a class-data-sharing archive (`-Xshare`) for faster JVM start | Noticeably faster startup per test |
| Kotlin | `kotlinc` is a slow JVM program (~10 s) | Keep a warm compiler (daemon) or compile with a long-lived service | Compile from ~10 s to ~1-2 s |
| C# | `dotnet` build (~10 s) | Compile with `csc` directly / a warm Roslyn server | Large compile reduction |

Use the new **Submissions by language** card (judge time column) to decide which of these matter for your traffic.

### P3. Scale beyond one machine

- Run more judge hosts consuming the same queues (plan Phase 5). This is the long-term lever once one server's
  CPU is full.
- Move the exam-portal stack off this machine, so the two do not compete for CPU during exams.
- The API's `wait=true` polls Mongo every 100 ms per waiting request (40 waiters = 400 reads/s). Fine today; at
  much higher load, notify through Redis instead.

## 4. How to measure each change

Re-run the same ramp (Python and C++, 1 to 40 concurrent, 60 s per step) after each change, plus a realistic mix:
`bits/stdc++.h` C++, Java and Python programs with ~10 test cases. Compare per-minute throughput at saturation, p95
latency, and server CPU. The 2026-10-17 baseline:

| Language | Ceiling | Saturates at | p95 at saturation |
|---|---|---|---|
| Python (trivial program) | ~1,700/min | ~20 concurrent | 0.9 s |
| C++ (trivial program, -O2) | ~510/min | ~10 concurrent | 1.5 s |

Load tests appear in the language statistics; note when you run one.
