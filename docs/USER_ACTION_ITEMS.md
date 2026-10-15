# Things only you can do

This is the running list of items from `docs/CODESPACE_HANDOFF.md` that need an action
only you can take — prod DB access, `git commit`/push, Dokploy redeploy, or a scoping
decision. Everything else in that checklist is done/verified in this Codespace. Update
this list as items get done or new ones come up; don't let it go stale.

## 1. Review, commit, and push the working-tree changes

**Resolved 2026-08-08.** Everything below has been committed and pushed across
`59199d7`, `7110c72`, `4949f87`, and `2186628`. The working tree is clean and in sync
with `origin/main`. Kept for history:

- `docker-compose.yml`, `docker-compose.prod.yml` — the docker-socket-proxy migration
  (item #9). Verified working against the local dev stack; `docker-compose.prod.yml` is
  validated via `docker compose config` but still **not deployed** to prod (see item #2
  below — that's the actual open action).
- `assessment-api/src/services/preview.service.js`, `judge-service-go/main_test.go`,
  `scripts/test_submission.js` — smaller fixes/test corrections from earlier this session
  (see git diff for each; already described in prior handoff context).
- `assessment-api/package-lock.json`, `frontend/package-lock.json` — dependency-only
  bumps (`npm audit fix`) that closed 2 real high-severity vulnerabilities
  (`nanoid`, `ip-address`) found while smoke-testing the CI security-audit job (item
  #12). No `package.json` changes, no major version bumps, tests/lint re-verified clean
  after. **Update 2026-08-08:** the `npm audit fix` run had left
  `assessment-api/package-lock.json` internally inconsistent (stray/duplicate
  `@emnapi/*` entries, one version mismatch) — harmless to `npm install` but fatal to
  `npm ci`, which is what `assessment-api/Dockerfile` uses, so `docker compose up
  --build` was failing on the `assessment-api` image. Fixed by deleting
  `node_modules`/`package-lock.json` and regenerating from `package.json` with a plain
  `npm install`. Re-verified: `npm ci` clean, `npm audit --audit-level=high` → 0
  vulnerabilities, `npm test` → 79/79, and a full `docker compose up --build -d` now
  brings up all containers with `/api/health` reporting mongodb/redis/rabbitmq/judge
  all `connected`. `frontend/package-lock.json` did not have this problem.
- `package.json`, `.github/workflows/ci.yml`, `assessment-api/scripts/seed_e2e_users.mjs`,
  `e2e/tests/assessment_lifecycle.spec.js`, `e2e/tests/submission.spec.js` — the E2E
  test-data seeding and Playwright spec fixes from item #3/#12 below.

## 2. Deploy the docker-socket-proxy change to prod (item #9)

`docker-compose.prod.yml` is edited and locally validated but **not deployed**. Once you
commit/push and redeploy via Dokploy:

- Make sure whatever pulls/builds images for the prod stack picks up the new
  `docker-socket-proxy` service (image: `tecnativa/docker-socket-proxy:latest` — no
  custom build, just a pull).
- You can **remove the `DOCKER_GROUP_GID` env var from Dokploy** — it's no longer read
  anywhere now that `judge-service-go` doesn't touch `docker.sock` directly.
- After redeploy, re-run the curl smoke test in `CODESPACE_HANDOFF.md`'s "How to test"
  section against `coding.fortifyhub.net` to confirm submissions still work through the
  proxy in prod, the same way it was verified locally.

## 3. Confirm the CI `judge-certification` job on a real push (item #12)

**Update 2026-08-08:** confirmed — CI actually ran on your `59199d7` push
(`gh run view 31252971891`). `Judge Certification Suite` passed cleanly (1m50s, no
contention/timeout like the earlier local simulation), along with Backend/Frontend Unit
Tests, Judge Unit Tests, Secret Scan, and Dependency Audit. The only failure was
`Playwright E2E Tests`, at its "Start services" step: `docker-compose: command not
found` (exit 127). Root cause — GitHub's `ubuntu-latest` runners dropped the legacy
Compose v1 `docker-compose` binary; only the `docker compose` v2 plugin is preinstalled
now. Fixed in `.github/workflows/ci.yml` line 124 (`docker-compose up -d` →
`docker compose up -d`) and committed/pushed as `7110c72`.

That got the E2E job one step further, exposing a second, older bug: the "Seed
problems" step failed with `Cannot find module '/usr/src/app/scripts/seed_problems_api.mjs'`.
That file was deleted back in commit `12d4020` ("Removed redundant/legacy seed and
utility scripts") and replaced by `assessment-api/scripts/seed_certification_set.mjs`,
but root `package.json`'s `seed:problems` script was never updated to match — it's been
broken since that commit, just never actually exercised in CI until now. Fixed
`package.json`'s `seed:problems` to point at `seed_certification_set.mjs`. Committed/
pushed as `4949f87`, confirmed on run `31254962938`: "Start services", "Wait for
services", and "Seed problems" all now pass, along with every other job — leaving only
the actual "Run E2E tests" step, which had genuinely never been reached before.

**Update 2026-08-08 (later):** that run exposed the real, final layer — the Playwright
suite itself. Root cause: `student@test.com`/`faculty@test.com` (hardcoded in
`e2e/tests/*.spec.js`) were never seeded anywhere in the codebase. No script ever created
them; they only ever existed in whichever dev Mongo happened to have been manually
signed-up-into by hand at some point, so the suite could only ever have passed against a
specific stale local DB, never a fresh one (never in CI, and not even for a fresh
Codespace). Fixed by adding `assessment-api/scripts/seed_e2e_users.mjs` (upserts the
student/faculty test accounts with a real bcrypt hash of `password123`, plus a
`Published` "E2E Smoke Assessment" referencing 2 already-seeded problems, matching the
shape `verify_assessment_lifecycle.mjs` uses) and wiring it in as `npm run seed:e2e`, a
new CI step right after "Seed problems".

That in turn surfaced three genuine, pre-existing test bugs — the suite had literally
never run to completion against real data before, so none of this had ever been caught:
- `submission.spec.js` blindly did `page.click('text=Two Sum')` on the unfiltered
  problem list. With the certification set now at 86 problems, `Two Sum (Certification)`
  falls off the default page-1/limit-50 result and the click hung until timeout. Fixed
  by having the test search for it first (like a real student would), and waiting for
  the filtered response before clicking, since the initial unfiltered fetch racing back
  in was intermittently detaching the card mid-click.
- `assessment_lifecycle.spec.js` expected a single native `confirm()` dialog after
  clicking "Start Assessment". The actual flow (`AssessmentDetailsPage.jsx`) is now a
  3-step anti-cheating flow: an instructions modal (checkbox + "I Understand &
  Continue"), then a fullscreen-prompt modal ("Enter Fullscreen and Start") — the
  `confirm()` call this test was written against doesn't exist anymore. Fixed the test to
  click through the real modals; confirmed headless Chromium's Fullscreen API works fine
  here (the attempt actually starts and the timer begins).
- Same test's final assertion, `expect(page.locator('.problem-card')).toBeVisible()`,
  hit a Playwright strict-mode violation — the results page reuses the `.problem-card`
  class for both the score card and a separate "Challenge/Appeal Score" card, so the
  locator matched 2 elements. Fixed with `.first()`.

**Resolved 2026-08-08.** Committed/pushed as `2186628`. CI run `31266652187` confirms
`Playwright E2E Tests` passed fully green on GitHub's hosted runners (3m54s) — the first
time that's ever happened — along with every other job (Backend/Frontend Unit, Judge
Unit, Judge Certification, Secret Scan, Dependency Audit). Only harmless annotations
(Node 20 deprecation notices, a Go module cache-miss note since there's no root
`go.sum`). Item #12 (CI E2E confirmation) is now fully closed — the whole chain of bugs
from the `docker-compose` v1 issue through missing test users and stale test assumptions
is fixed and verified in production CI, not just locally.

## 4. Scope H12 horizontal scale-out (item #11)

Paused at your instruction ("wait", then explicitly redirected to judge language/problem
coverage instead — see below). Not started — this is a real infra/design project (getting
sandbox images into a registry, decoupling judge-service-go from a single host's Docker
socket), not something to guess at. Worth a deliberate conversation about scope/timeline
before picking it up whenever you're ready to return to it.

## 4a. Judge language coverage: Kotlin/Rust data structures + exposing Ruby/PHP/Kotlin/Rust

**2026-08-09.** In place of H12, worked the judge/problem-coverage angle instead. Found two
real, separate gaps:

- **Kotlin, Rust, Ruby, and PHP were fully implemented in `judge-service-go` (images,
  wrappers, adapters) but invisible in the frontend** — `ProblemPage.jsx`,
  `AssessmentWorkspace.jsx`, `AddAssessmentPage.jsx`, and `EditAssessmentPage.jsx` all
  hardcoded the same 7-8 language list that omitted them. Students could never select
  these languages at all.
- **Kotlin and Rust couldn't handle `tree<T>`/`linkedlist<T>`/`graph<T>` problems** — every
  other language (Python/JS/TS/Java/C/C++/C#/Go/Ruby/PHP) supported these types; Kotlin and
  Rust's wrapper templates explicitly didn't (commented as intentional gaps). Checked the
  actual certification set: 10 tree, 9 linked-list, 2 graph, and 1 nested
  `array<linkedlist<number>>` problem — about a quarter of the 86-problem set — would have
  been unsolvable in these two languages.

Fixed, in order:
- Ruby and PHP exposed in all four frontend language lists, plus real starter-code
  templates added to `frontend/src/utils/buildTemplate.js` (they previously fell through to
  an unhelpful generic placeholder). Verified via direct API submissions — Two Sum and a
  linked-list problem (Add Two Numbers), both Accepted.
- Kotlin's `pkg/wrappers/kotlin_wrapper.tpl` rewritten to register Gson `TypeAdapter`s for
  `TreeNode`/`ListNode`/`Node`, mirroring the same pattern Java already used. Verified tree,
  linked-list, and graph problems all Accepted, plus a regression check (Two Sum) still
  passes.
- Rust's `pkg/wrappers/rust_wrapper.tpl` given real `TreeNode`/`ListNode`/`Node` struct
  definitions (matching LeetCode's own Rust convention: `Option<Box<ListNode>>`,
  `Option<Rc<RefCell<TreeNode>>>`) plus hand-rolled JSON conversion helpers (the wrapper has
  no external JSON crate available offline), and `pkg/wrapper/generator.go`'s
  `rustJSONHelpers` extended to wire them in for the static per-parameter codegen path.
  Verified tree, linked-list, and graph problems all Accepted, plus a Two Sum regression
  check.
- **Real, pre-existing bug found and fixed along the way**: `pkg/executor/executor.go`'s
  `CompileInContainer` (used by the central-per-test comparator's separate compile phase —
  the actual path Kotlin/Rust/Ruby/PHP submissions take) had no memory floor at all during
  compilation, unlike its sibling `RunInContainer*` functions which already floor at
  1024MB. `kotlinc` needs meaningfully more than that even for trivial code — every Kotlin
  submission through this path was silently OOM-killed during compilation before this fix,
  regardless of anything to do with tree/list/graph. Added a shared
  `compilationMemoryFloorMb()` helper (1024MB default, 2048MB when the compile command is
  `kotlinc`) and applied it at all four call sites.
- **Also found and fixed separately**: `judge-service-go/Dockerfile`'s `ENTRYPOINT` bakes in
  a binary built at image-build time; docker-compose.yml's dev-mode `command:` override
  (intended to `go build` fresh on every container start against the bind-mounted source)
  gets silently swallowed as ignored CLI args to that entrypoint rather than replacing it.
  Practical effect: `docker compose restart judge-service-go` **never actually applies Go
  source changes** — only `docker compose build judge-service-go` (or `up -d --build`) does.
  This cost real time mid-session (two restarts that silently kept running the stale
  binary before the real fix was traced). Worth fixing properly at some point — either give
  the Dockerfile a `CMD` instead of baking `command:` assumptions into compose, or drop the
  dev-mode live-rebuild pretense and just always `--build`. Not changed in this session
  since it's a deliberate infra/Dockerfile decision, not a drive-by fix.
- Type-conversion tables extended for completeness: `frontend/src/utils/typeValidator.js`
  now maps `tree`/`linkedlist`/`graph`/etc. for Kotlin and Rust too, and
  `frontend/src/pages/ProblemPage.jsx`'s language list picked up `typescript`, which had
  been missing there (present everywhere else) — a small pre-existing inconsistency fixed
  along the way.

Note: this platform's Rust convention requires `&self` as the first parameter on Solution
methods (`impl Solution { pub fn twoSum(&self, ...) }`), which differs from real
LeetCode's usual associated-function style — that's how the existing (pre-this-session)
Rust wrapper already called user code, not something introduced now. Kotlin/Ruby/PHP don't
have this quirk.

All of `judge-service-go`'s unit tests (`go test ./...`) and the frontend's unit tests
(`npm test`) and lint (`npx eslint src/`) pass clean. Everything above is uncommitted —
needs your review/commit/push. `judge-service-go`'s Docker image will need a real rebuild
wherever this deploys (see the Dockerfile/entrypoint note above) — a plain container
restart is not sufficient.

## 5. Run `scripts/backfill_college_id.mjs` against production (item #13)

Per your instruction, deliberately left untouched — this Codespace has no production DB
credentials. Needs to run before/at any second-customer cutover (see the C2 tenant-scoping
fix). Confirm it's safe to re-run if it's ever unclear whether it already ran, then run it
for real once you have DB access to prod (or its staging equivalent).

## 5a. Check whether `MONGO_DB_NAME` is set in Dokploy (bug fixed 2026-09-25)

`judge-service-go` never read `MONGO_DB_NAME` — it hardcoded `.Database("assessment_db")` at
three call sites (`problems`, `submissions`, `usageevents`), even though **both** compose files
pass the var to it (`docker-compose.prod.yml` line 295). `assessment-api` *does* honour it
(`src/config/env.js` → `src/config/db.js`). Fixed 2026-09-25: the Go service now reads the env
var with the same `assessment_db` default, so the two services agree.

**What you need to check**: if `MONGO_DB_NAME` is set to anything *other than* `assessment_db`
in your Dokploy environment, then before this fix the API and the judge were reading and
writing **two different databases**. Symptom would be submissions stuck in `pending` forever
(the API enqueues them, the judge writes results to the wrong DB, the API never sees them),
plus wrong `usageevents` metering and unincremented problem counters.

- If it is unset or set to `assessment_db` — nothing was ever broken, no data action needed.
  This fix is purely preventative.
- If it is set to something else — the judge has been writing to `assessment_db` while the API
  used your value. Check both databases for stranded `submissions`/`usageevents` documents
  before redeploying, since the fix will move the judge onto your DB and stop writing to the
  old one. Billing/metering figures from that period would be understated.

## 6. Priority 3 (lower priority, deprioritized by design)

Untouched, no action needed yet: H3 integration-route auth scoping, IDE run/submit logic
dedup between `AssessmentWorkspace.jsx`/`ProblemPage.jsx`, other language adapters'
`CompileCommand`/`RunCommand` dedup, secrets rotation mechanism, structured logging,
no in-repo frontend prod deploy config, and the aspirational Phase 4 multi-model plan.
See `docs/CODESPACE_HANDOFF.md`'s Priority 3 section and
`docs/PLATFORM_AUDIT_AND_SAAS_ROADMAP.md` for full detail on each.

## Housekeeping note

The H11 restore drill (item #10) left an extra backup file in `backups/` from testing
(`assessment_db_20260808_052619.gz`, alongside the pre-existing one). Harmless — the
backup script auto-prunes anything older than 7 days — but delete it now if you'd rather
not wait.
