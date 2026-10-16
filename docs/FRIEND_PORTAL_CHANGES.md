# Changes the exam portal may need for GO Judge

**Written:** 2026-10-16. **Status:** none of this is deployed. Everything below is built and tested
locally, on branch `phase-cd-wip`. Nothing should reach the live stacks until after the current exam
window; see "Rollout" at the end.

**Audience:** whoever maintains the exam portal's judge client (`runOnJudge()` in
`exam-platform/workers/student-workerjs/src/judge.js`). That file is not in this repo, so each item
below is written from the contract the portal is known to depend on, and marked **VERIFY** where only
the portal's code can confirm whether a change is needed.

The portal currently authenticates with the shared secret (`x-rapidapi-key`, equal to our
`CODEASSESS_SHIM_KEY`). **That path keeps working unchanged** and still takes the old synchronous
route, so almost everything here is opt-in: it only applies once the portal is issued its own key.

---

## 1. Changes that affect the portal even if it changes nothing

These apply to the existing shared-secret path as soon as the new judge is deployed.

| # | Change | Why it matters | Action |
|---|---|---|---|
| 1.1 | **A crashing submission now returns status `11`, not `13`.** | Previously every student crash was reported as `13` ("the judge broke") because the judge set an internal error for any non-zero exit. A crash is an ordinary judging outcome, so it is now `11` (Runtime Error / NZEC) with the exit code and stderr filled in. | **VERIFY** how `judge.js` treats `13`. If it retries or alerts on 13 as an infrastructure failure, behaviour improves (fewer false alarms). If it grades 13 and 11 differently, a crash will now be graded as a runtime error, which is correct. |
| 1.2 | **C and C++ now compile with `-O2`** (previously the default `-O0` on this path). | Programs run several times faster. But optimisation can change the behaviour of code with undefined behaviour: uninitialised variables, out-of-bounds reads, signed overflow. A program that happened to print the expected answer at `-O0` can print something else at `-O2`. | Re-run the reference solutions and expected outputs for every C/C++ question against the new judge before the next exam. `scripts/judge_contract_check.mjs` is the tool; see section 6. |
| 1.3 | **Java and Go run commands are shared with the queue path.** | One definition now serves both paths so they cannot drift. Java keeps `-Xmx256m`; Go keeps its offline build flags. | No action. Listed so a behaviour difference is not a surprise. |
| 1.4 | **Seven more languages are supported through the shared definition** (Java, C#, TypeScript, Rust, Ruby, PHP, Kotlin were already supported by `/raw-run`; they are now also supported on the queue path). | Needed so moving to the queue does not drop them. | No action. |
| 1.5 | **Product name.** The public API is now called **GO Judge** in our code and docs. | We do not want it mistaken for a wrapper around another product. | The portal's own variable `JUDGE0_API_KEY` is not ours to rename and nothing on our side reads it. If you rename it, keep the *value* identical to `CODEASSESS_SHIM_KEY`. |

---

## 2. Authentication: moving from the shared secret to a per-client key

A key identifies the caller, which is what makes per-client usage, billing and quotas possible. The
header is the same, so **no code change is needed** to start using one.

1. An admin issues a key: `POST /api/admin/api-clients` with `{ "name": "...", "scopes": ["codeassess"] }`.
   The response contains the plaintext key **once** and it cannot be recovered afterwards.
2. Put that key in the portal's existing secret (the value sent in `x-rapidapi-key`).
3. Revoke with `DELETE /api/admin/api-clients/:id`. A revoked key gets `401 {"error":"Unauthorized"}`,
   the same body as any bad key.

A key is tied to one college. A key that has the wrong scope is rejected exactly like an unknown key.

**Rollback:** put the old shared secret back. It keeps authenticating until we delete the fallback,
which we will not do without telling you first.

---

## 3. What changes in responses once the portal uses a key

The request format is identical. The response differs in these ways, all additive or more faithful to
the standard API shape.

| Field | Shared secret (today) | Keyed (queue-backed) |
|---|---|---|
| `token` | `sync-<timestamp>`, not usable for anything | The real submission id. Usable with `GET /submissions/:token`. |
| `GET /submissions/:token` | Always `404` | Returns the real result. Another client's token returns `404`. |
| `status` | `{ "id": 3 }` | `{ "id": 3, "description": "Accepted" }` (superset) |
| Still running | Cannot happen | `status.id` is `1` (In Queue) or `2` (Processing), and `stdout`, `stderr`, `compile_output`, `time`, `memory`, `exit_code` are all `null` |
| `wait` not set | Always waits | Returns `201 { "token": "..." }` immediately |
| Compile error `exit_code` | `-1` | `-1` (matched on purpose) |

**VERIFY on the portal side:**

- **3.1 Null fields.** If `judge.js` base64-decodes `stdout`/`stderr` without a null check, a response
  with status `1` or `2` will throw. This is the most likely thing to break. Only relevant when a run
  takes longer than the wait cap (3.3).
- **3.2 The poll loop.** The portal is understood to have a defensive poll loop that never runs
  today because the shared-secret path is always synchronous. Once keyed, it can run. Check that it
  (a) treats `1` and `2` as "keep polling", (b) sends the same key on `GET`, (c) has a bounded number
  of attempts, and (d) does not treat the old `404` as a permanent failure for a real token.
- **3.3 The wait cap is 25 seconds.** After that, a `wait=true` request returns with status `1` or
  `2` and the caller is expected to poll. The portal's own HTTP timeout must be longer than 25s plus
  margin, or it will abandon requests we are still serving.
- **3.4 Failures look different.** If the judge cannot get a container, the submission is retried for
  roughly a minute (longer than the 25s wait cap), so the original request returns status `1`/`2` and
  the failure only appears when polling, as status `13` with an explanatory `stderr`. Today the same
  situation is an immediate HTTP 5xx. A queue outage still returns a 5xx. Make sure both are handled.

---

## 4. Language-specific rules (unchanged, but now enforced uniformly)

- **Java:** the class must be `public class Main`.
- **Kotlin:** a single file with a top-level `fun main()`.
- **C#:** the program's entry point is the only entry point in `Program.cs`.
- Source is compiled and run **as written**. Nothing escapes or rewrites the source.

---

## 5. Batch endpoint (new, optional, keyed clients only)

`POST /api/codeAssess/submissions/batch?base64_encoded=true` with
`{ "submissions": [{ "language_id", "source_code", "stdin", "cpu_time_limit", ... }, ...] }`
(up to 20 items) answers `201` with one `{ "token" }` or `{ "error" }` per item, **in request order**.
Poll with `GET /api/codeAssess/submissions/batch?tokens=a,b,c`, which answers `{ "submissions": [...] }`
in the same order (an unknown token is `null`). It uses the same `x-rapidapi-key` header.

**Why adopt it:** a problem with six test cases currently costs six requests and, for C/C++ and
Java, six compiles. Sent as one batch with the same source, it compiles once. Measured locally:
**3.6x faster for C++, 3.4x for Java**, outputs identical; Python gains little (1.2x) because it has
no compile step. This is the largest single capacity gain available to the portal.

Things to check on the portal side:

- **5.1** Match results to inputs **by position**, not by token contents. Tokens of a coalesced group
  look like `<id>.0`, `<id>.1`; treat them as opaque strings.
- **5.2** A batch does not wait. There is no `wait=true` for it; poll until every item's
  `status.id` is neither `1` nor `2`.
- **5.3** A bad item gets `{ "error": "..." }` in its own position and does not reject the batch.
  An empty batch or more than 20 items is `422`.
- **5.4** A shared-secret caller gets `403` on batch. This is the reason to move to a key first.
- **5.5** For a group, a compile error is reported on **every** item in it (status `6` with the
  same `compile_output`), since they share one source. A timeout or crash is reported only on the
  case that caused it.
- **5.6** Usage is billed per test case, not per request.

## 5b. Planned, not yet built

| Planned | What the portal should do |
|---|---|
| Per-client quotas (plan Phase 4) | Handle `429` with a `Retry-After` header by waiting and retrying, not by failing the student's submission. |

---

## 6. How to verify before an exam

Local stack only (the script refuses non-local hosts without `--allow-remote`):

```
node scripts/judge_contract_check.mjs --target shim --base http://localhost:3000            # shared secret
node scripts/judge_contract_check.mjs --target shim --base http://localhost:3000 --key ak_...  # keyed
```

Both should report `21 fixtures, 0 difference(s)` against `scripts/tests/judge-contract-baseline.shim.json`.
To check the exam's own questions, add their reference solutions and expected outputs as fixtures.

---

## 7. A separate issue worth deciding on

Stored-problem **stdin** submissions (the `/integration` and `/arventiq` routes, not the Judge API above)
pass the source through an "unescape" step before compiling. It turns every `\n` inside a string
literal into a real newline, so `cout << "x\n"` fails to compile and Python's `rstrip("\n")` becomes a
syntax error. We found this while testing the new path and fixed it for ad-hoc submissions only,
because the unescape exists for a reason we cannot see (code that arrives double-encoded from some
client). **Decision needed:** does any client actually send escaped source? If not, the step should be
removed for stored-problem stdin submissions too. We have not changed it.

---

## 8. Rollout

Both deployed stacks (GO Judge and Exam Sandbox) autodeploy from `main`, so a push restarts both.

1. **Not during an exam window.** A push to `main` restarts the sandbox stack.
2. New RabbitMQ queues (`submission_queue_fast` and its retry queue) are created by the judge on
   startup. This is additive: an old judge against the new broker, or the reverse, keeps working.
3. Deploy order does not matter for the shared-secret path, which does not use the new queue. For a
   keyed client it matters briefly: if the API is up before the judge, a keyed `wait=true` request
   times out at 25s instead of completing. Do not issue a key until both are running.
4. New optional environment variables (defaults are sensible):
   `JUDGE_INTERACTIVE_WORKERS` (default 4), `JUDGE_INTERACTIVE_RESERVE` (default 1).
5. Re-verify C/C++ question outputs (item 1.2) **before** deploying, not after.
