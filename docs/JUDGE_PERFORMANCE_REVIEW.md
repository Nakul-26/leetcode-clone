# Judge Performance Review

How a submission moves through the judge, what limits throughput, what has been fixed, and what is left. First
written 2026-10-17 after the live load test; updated the same day with the fixes. **Verified** means measured or
reproduced, not inferred from the code.

Deployments: `coding2` / `assess.fortifyhub.net` is the **testing** stack; the exam portal (same compose file) is
**production**. Both currently share one server.

## 1. The path of one submission

1. The API validates the request, admits it against the client's quota, writes a `submissions` row and publishes to
   RabbitMQ (`submission_queue_fast` for interactive work, `submission_queue` for bulk).
2. A judge worker borrows an idle container of that language from the pool. Each container has **1 CPU, 1 GB of
   memory**, no network, a read-only root, and memory-backed scratch areas `/app` and `/tmp` (512 MB each).
3. The source is written into `/app/sub-<id>/` inside the container.
4. Compiled languages compile once; then each test case runs in its own `docker exec`.
5. The result is saved, a usage event is recorded, and the container is **reset** and returned to the pool. After
   500 submissions it is replaced.
6. The API answers `wait=true` callers by checking the database every 100 ms.

## 2. What limits throughput

The 2026-10-17 load test reached **~1,700 Python/min** and **~510 C++/min**, then flattened. The likely cap is
concurrency settings, not hardware:

- The public API sends single submissions to the **interactive** queue, whose worker count
  (`JUDGE_INTERACTIVE_WORKERS`) defaulted to **4**: at most four public-API runs execute at once, across all
  languages.
- The testing stack keeps `JUDGE_POOL_SIZE=4` containers per language (the code default is 2), with autoscaling
  off at the time.

An earlier version of this section said 2 containers per language; the testing stack's environment sets 4.
Section 4 raises the worker count and enables autoscaling; re-running the load test will confirm which limit
applied and where the CPU ceiling is.

## 3. Fixes made (2026-10-17)

| # | Problem | Fix | Result |
|---|---|---|---|
| 1 | **Earlier submissions were readable by later ones (verified).** Each submission's folder in `/app` was never deleted inside the container and is world-readable; hidden files in `/tmp` survived the per-run `/tmp/*` cleanup (the glob skips dot-files). A later submission in the same container could read earlier students' source code, and `/app` (memory-backed) kept growing inside the 1 GB limit: ~2.3 MB per Go submission, ~20 KB per C++. | The container is **reset before every reuse**: submission folders removed, `/tmp` emptied including hidden files (except the Go build cache), leftover processes killed, memory limit restored. If the reset fails, the container is discarded instead. | A planted file and folder were visible to a later submission before (control run), and **not after**. 0 leftover files across 49 containers after the full contract suite. |
| 2 | Recycling every 100 runs was compensating for item 1. | Limit raised to **500** (`JUDGE_MAX_EXECS`); kept as a safety net. | Fewer container rebuilds. |
| 3 | Replacing a recycled container blocked the worker that recycled it. | Replacement is created in the background. | Worker returns to the queue immediately. |
| 4 | `/run` and `/raw-run` never counted executions, so those containers were never recycled. | They count like the queue path. | |
| 5 | **A new container's first Go submission took ~16 s (verified):** its build cache starts empty. (The cache itself survives between runs; an earlier version of this review wrongly said it was wiped.) | The Go image ships a pre-built cache; a new container copies it in at creation (`judge-warmup` hook, which any image can provide). | First Go submission on a fresh container: **16-17 s to 1-2.4 s**. Warm runs: ~0.8 s. |
| 6 | Per test case: two `docker update` calls (set/reset memory limit), plus a source upload for interpreted languages. | Memory limit set once per submission; interpreted source uploaded once. | ~5 Docker calls per test to 2 (a 10-test Python problem: ~50 to ~24). |

Contract suite after all changes: 21/21 identical on both public API paths.

## 4. Settings to use the cores (testing stack first)

Set these in the **testing** stack's Dokploy environment, redeploy, and re-run the load test. Check the server's
core count first; the numbers below assume about 6 cores.

```
JUDGE_POOL_AUTOSCALE_ENABLED=true
JUDGE_POOL_MAX_PY=6
JUDGE_POOL_MAX_CPP=6
JUDGE_POOL_MAX_JAVA=6
JUDGE_INTERACTIVE_WORKERS=8
```

- `JUDGE_POOL_SIZE`: the warm minimum per language (the testing stack uses 4). Write env lines without spaces around `=`.
- Leave `JUDGE_POOL_GLOBAL_CAP` at 60. It must stay above the sum of the minimums (2 x 12 languages = 24) or the
  judge refuses to start; the CPU limit comes from the per-language maximums and the worker counts.
- Use the **Submissions by language** card to pick which languages get a higher maximum.
- Expected: up to ~3x for one busy language on 6 cores. Past full CPU, more containers only add latency.
- While both stacks share the server, a load test on the testing stack takes CPU from production. Run tests when
  the exam portal is idle, or after the move in section 6.

## 5. Still open

| Change | Expected gain | Notes |
|---|---|---|
| C/C++ precompiled header for `bits/stdc++.h` | Typical competitive C++ compile ~2 s to ~0.5 s | Must be built with the same flags as submissions (-O2, standard). Safe: GCC ignores a mismatched header |
| Java: faster JVM start (`-XX:TieredStopAtLevel=1`, class-data sharing) | Lower per-test time | Measure first |
| Kotlin, C#: warm compiler (daemon / `csc`) | ~10 s compiles to ~1-2 s | Larger change |
| Run all test cases in one `docker exec` (runner script) | A 10-test problem from ~24 Docker calls to ~4 | Function problems already have a batch mode |
| Second judge server on the same queues (plan Phase 5) | Linear capacity | Once one server's CPU is full |

## 6. Moving the production exam portal to its own server

Both stacks on one machine compete for CPU: a busy testing stack (or a load test) slows production exams. Dokploy can
deploy to another machine from the same dashboard (**Remote Servers**), which keeps the workflow the same.

1. Get a second VPS (size it on the load numbers: CPU cores matter, RAM ~4 GB is enough today).
2. In Dokploy, **Remote Servers**, add it (Dokploy installs its agent over SSH).
3. In a quiet window, back up production's MongoDB (`scripts/backup_db.sh`, see the Admin Guide). Redis and
   RabbitMQ hold no data that needs moving (queues should be drained first).
4. Create the production compose service on the new server with the same environment variables, deploy it,
   and restore the backup there (`scripts/restore_db.sh`).
5. Smoke test the new stack on a temporary hostname, then point production's hostname at it (Cloudflare tunnel
   route or DNS), and stop the old production stack.
6. Keep the old stack stopped, not deleted, for a few days as a fallback.

This touches production data and the exam portal's hostname, so its owner should run (or approve) each step.

## 7. How to measure each change

Re-run the same ramp (Python and C++, 1 to 40 concurrent, 60 s per step), plus a realistic mix: `bits/stdc++.h`
C++, Java and Python with ~10 test cases. Compare per-minute throughput at saturation, p95 latency, and server CPU.

| Language (trivial program) | Ceiling | Saturates at | p95 at saturation |
|---|---|---|---|
| Python | ~1,700/min | ~20 concurrent | 0.9 s |
| C++ (-O2) | ~510/min | ~10 concurrent | 1.5 s |

Load tests show up in the language statistics; note when you ran one.
