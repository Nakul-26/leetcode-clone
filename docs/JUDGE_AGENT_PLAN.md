# Fewer Docker calls per run (resident sandbox agent)

**Written:** 2026-11-06. **Status:** Phase 0 done (results below); A/B decision pending.
**Why:** with two judges the peak is ~1.7x one judge (`docs/SECOND_JUDGE.md`). Both servers run out
of CPU, and the top consumers are `dockerd`, `containerd` and `runc`, not the submissions: every run
pays for several Docker API calls and several new `runc` processes. Cutting that helps every judge,
and is the only way left to get much more out of the same hardware.

## What one run costs today

A load-test request (stdin, Python, one test, batched path), from `stdin_runner.go`,
`central_runner.go` and `pkg/executor`:

| Step | Docker work | Where |
|---|---|---|
| Upload source + inputs | 1 exec (create, start, inspect; tar on stdin) | `copyFilesToContainer` |
| Set the problem's memory limit | 0-1 `update` (skipped if unchanged, since 1a89886) | `UpdateContainerResources` |
| CPU time before | 1 `stats` (one-shot) | `ContainerCPUTime` |
| Run all tests | 1 exec | `RunInContainerStream` |
| CPU time after (and polls if the wall time runs out) | 1+ `stats` | `batchCPUWait` |
| Restore 1024 MB | 0-1 `update` | `ResetContainer` |
| Kill leftovers (root) | 1 exec | `containerKillScript` |
| Wipe `/app`, `/tmp` (judge user) | 1 exec | `containerWipeScript` |

**4 execs + 2 stats + 0-2 updates ≈ 14-16 Docker API calls and 4 `runc` process launches** for a
program that itself runs for ~20 ms. Measured on the servers: an empty `docker exec` costs 36 ms
(deploy2) / 51 ms (deploy4) of wall time, and a Python request spends ~290 / ~470 ms in the judge.

Compiled languages add 1 compile exec; per-test (non-batched) paths add 1 exec per test.

## Constraints (must not regress)

- **Results can't be forged by the submission.** CPU time is read from outside the sandbox today
  for this reason (`cputime.go`). Anything that moves into the container must be out of the
  submission's reach.
- **Reuse stays safe.** The reset kills every judge-user process and wipes `/app` and `/tmp`, and
  a failed reset discards the container (`ResetContainer`, `finishWithContainer`). The
  contamination, process-contamination, fd-leak and symlink tests define this.
- **The Docker guard stays tight.** Today it allows exec, stats, update, start, inspect and delete
  on containers, and the `KILL` capability only. No container attach.
- **Sandboxes keep** no network, read-only rootfs, `no-new-privileges`, pids and memory limits.

## Plan

### Phase 0: measure (half a day)

- Count Docker calls and their time per submission (a small wrapper around the executor's client
  calls, logged at debug and summed in the judge's stats endpoint).
- One load-test baseline per server with that breakdown, so each phase below has before/after
  numbers. `npm run loadtest -- full --langs=python,cpp --levels=40,80 --seconds=30`.
- A 30-minute prototype on deploy4 to size the prize before building: in a throwaway sandbox,
  time 200 runs of `python3 -c 'print(1)'` as 200 `docker exec`s vs 200 runs launched by one
  resident process inside the container.

#### Phase 0 results (2026-11-06)

**In production** (deploy4, counters from b951818, load test at x40):

| | Docker calls per job | Docker API time per job | of which |
|---|---|---|---|
| Python | 14.0 | 15 ms | 4 execs (create+start+inspect each), 2 stats, 0.01 update |
| C++ | 20.0 | 34 ms | 6 execs, 2 stats, 0.04 update |

The API calls themselves are quick (1-2 ms each); the cost is what each exec sets off behind
them: a new `runc` process, namespace entry and cgroup setup in `containerd`/`runc`, which the
call returns before. The `docker update` skip (1a89886) already removed nearly all updates.

**Prototype** (`docs/bench/exec_vs_resident.sh`, throwaway sandboxes from `judge-py-env` with the pool's restrictions,
200 Python runs, 10 at a time; host CPU per run minus the `docker` CLI's own startup, which the
judge doesn't pay):

| Host CPU per run | deploy2 (Ryzen 5 8500G) | deploy4 (i7-8700) |
|---|---|---|
| Today's shape (4 execs) | ~270 ms | ~350 ms |
| Phase 1 shape (2 execs) | ~160 ms | ~190 ms |
| Resident process, no exec per run | ~65 ms | ~90 ms |

So: Phase 1 cuts host CPU per Python run by ~40%; a resident agent by ~75% (3-4x less), which
supports the 2-3x Python throughput estimate. The resident figure includes Python's own startup
and leaves out the root kill and the 2 stats calls, which a real agent keeps (Option B) or drops
(Option A + Phase 3).

### Phase 1: merge execs within today's model (1-2 days, low risk)

No new components; same guard, same images.

1. **Upload and run in one exec.** Both run as the judge user: `tar -x` the workspace, then exec
   the runner. Saves 1 exec per run (interpreted languages; compiled ones upload then compile).
2. **Wipe at the start of the next use, in the same exec as its upload.** The root kill still runs
   when a submission ends, so nothing keeps running; the next submission's first exec runs the
   wipe (still verified: leftovers fail the exec and the container is discarded and retried) and
   then extracts its own files. Saves 1 exec per run. The files of a finished submission stay in
   an idle container that no one can run code in until that wipe.
3. **Skip the reset to 1024 MB** when the run's limit is already at least what the reset needs.

Expected: 4 → 2 execs per Python run, ~30-40% less Docker CPU per run.

### Phase 2: resident agent (1-2 weeks)

A small static Go binary, `judge-agent`, in every language image (one shared build stage),
started **once per pooled container** as a long-lived exec with stdin/stdout attached. The judge
keeps that connection open and sends jobs as length-prefixed JSON; the agent replies with results.
A run then costs **no exec at all**: write files, run commands as the judge user with the time,
output and stdin handling the runner scripts do today, kill leftovers, wipe, reply.

Per run: 0 execs, 2 stats, ~0 updates. Expected judge time for a Python request: ~290 ms →
~60-120 ms (to be confirmed by the Phase 0 prototype), i.e. roughly 2-3x Python throughput per
server. C++ gains less (compiling dominates): ~1.2-1.4x.

**The design decision: how the agent runs as root but the code as the judge user.**

- **Option A (recommended): root agent, with `SETUID` and `SETGID` added to the sandbox's
  capabilities.** The agent drops each child to the judge user itself. Submissions run unprivileged
  and with `no-new-privileges`, so they can't use those capabilities; they can't signal, ptrace or
  read the fds of a root process, so they can't touch the protocol. Needs a guard change (allow
  `SETUID`, `SETGID` besides `KILL`) and a security review of that change.
- **Option B: no new capabilities.** Two resident execs: a root keeper (kill, verify) and a
  judge-user runner that marks itself non-dumpable (`PR_SET_DUMPABLE 0`, so a same-user process
  can't open its fds or ptrace it). A submission can still kill the runner (same user), which only
  fails its own run; the keeper must spare the runner's pid when it kills. No guard change, more
  moving parts, and the runner is restarted (1 exec) whenever a submission kills it.

Either way:

- **Memory limit** stays a `docker update` (cgroup, outside the sandbox), only when it changes.
- **CPU time** stays a Docker `stats` read before and after, as now. Phase 3 can move it.
- **Fallback:** `JUDGE_AGENT_LANGS=python,javascript,...` enables it per language; if the agent
  doesn't answer its handshake, the judge uses today's exec path for that container.
- **Failure = discard.** A broken stream, a missed reply or a failed wipe discards the container,
  exactly like a failed reset today.
- **Tests:** every existing contamination / process / fd / symlink / TLE / MLE / output-limit test
  runs against both paths; plus agent-specific ones (submission kills the agent, floods stdout,
  forks to the pids limit, tries to write to the agent's fds).

### Phase 3 (optional): CPU time without Docker stats

With a root agent (Option A), the agent can read the container's own `cpu.stat` (read-only cgroup
files the submission can't change) and report it with the result. That removes the last two
Docker calls per run. Only after Phase 2 has run in production for a while.

## Rollout

1. Phase 0 numbers.
2. Phase 1 behind `JUDGE_MERGED_EXECS=true`, load test, enable on both judges.
3. Phase 2: decide A or B; build; enable for Python only on deploy4 first; load test; then all
   languages, then deploy2.
4. Each step: same `full` load test, compare per-judge rates and the Docker CPU share.

## Open questions

- Option A or B (security trade-off above).
- Whether per-test (non-batched) paths are worth moving to the agent, or only the batched ones.
- gVisor (`JUDGE_SANDBOX_RUNTIME=runsc`): the agent works there too, but exec costs differ; measure
  separately if gVisor goes to production.
