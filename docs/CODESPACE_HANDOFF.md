# Codespace / Docker environment handoff

## Session update — 2026-08-09

Short pointer, not a rewrite — full detail lives in `docs/USER_ACTION_ITEMS.md`, which is
now the more current running log:

- **#12 (CI gates) is fully resolved**, superseding the "mostly done, one inconclusive
  result" note below — a real push confirmed every CI job green on GitHub's hosted
  runners, including the previously-inconclusive `judge-certification` job and, in a
  follow-up push, `Playwright E2E Tests` passing end-to-end for the first time ever.
- **New work not tracked anywhere in this doc**: closed a real judge/problem-coverage gap
  — Kotlin and Rust couldn't handle `tree`/`linkedlist`/`graph` problems (~1/4 of the
  certification set), and Kotlin/Rust/Ruby/PHP were fully built in `judge-service-go` but
  invisible in the frontend's language pickers. Both fixed and verified. Also found two
  independent real bugs along the way: `CompileInContainer` had no compile-time memory
  floor (Kotlin submissions were silently OOM-killed regardless of data structures), and
  `judge-service-go`'s Dockerfile `ENTRYPOINT` means `docker compose restart` never
  actually applies Go source changes — only `docker compose build` does. See
  `docs/USER_ACTION_ITEMS.md` §4a for the full writeup.

## Session update — 2026-08-08

Worked through the full Priority 1/2 checklist below in this Codespace. Summary (details
inline at each numbered item):

- **Priority 1 (#1-8): all done.** Verified in an earlier pass this session (Go
  toolchain, `backup_db.sh`, H4 usage metering, H8 cookie auth, H10 exceljs exports,
  draft-conflict banner, `problemDifficultyStats`, harness login) — no real bugs found,
  only the pre-existing non-blocking `getMyAnalytics` N+1 query noted previously.
- **#9 (docker-socket-proxy): done, not deployed.** Implemented and verified against the
  local dev stack (`docker-compose.yml`), then the identical change was ported to
  `docker-compose.prod.yml`. Both are uncommitted working-tree changes — see
  `docs/USER_ACTION_ITEMS.md` for what's left for you to commit/deploy.
- **#10 (H11 restore drill): done.** Full backup → simulated data loss → restore →
  verify cycle run against the dev Mongo — see the item below for the result.
- **#11 (H12 scale-out): not started.** Large infra/design work, wasn't in your
  requested scope — flagged in `docs/USER_ACTION_ITEMS.md` for a scoping decision.
- **#12 (CI gates smoke test): mostly done, one inconclusive result.** Simulated every
  CI job locally (lint, unit tests, `npm audit`/`audit-ci`, gitleaks secret scan) —
  found and fixed two real high-severity dependency vulnerabilities that would have
  failed the `security-audit` job. The Docker-heavy integration/certification Go suite
  timed out under this Codespace's resource contention (65 containers on 4 CPUs) —
  inconclusive locally; needs a real push to confirm on GitHub's dedicated runners. Full
  detail at the item below.
- **#13 (`backfill_college_id.mjs` against prod): untouched, as you asked** — this
  needs real prod DB access this Codespace doesn't have.

## ✅ INCIDENT RESOLVED AND CONFIRMED LIVE ON PROD

**Deployed and verified against `coding.fortifyhub.net`** — `/api/health` reports mongodb/redis/
rabbitmq/judge all connected, and live test submissions pass for both interpreted (Python) and
compiled (Java, C++) languages with correct stdout and `status.id: 3` (ACCEPTED). The root-cause
writeup below is kept for history/context; steps 1-3 of the old "Next steps" list were superseded
during the fix, as noted inline.

One extra issue surfaced only at deploy time, after the code fixes below: `docker-compose.prod.yml`'s
`assessment-api` service never wired `ARVENTIQ_SECRET` through to the container (a separate,
never-before-provisioned shared secret for the `/api/arventiq/*` integration, distinct from the
judge0 shim's `JUDGE0_SHIM_KEY`) — `env.js` fatal-crashes without it in production. Fixed by adding
`ARVENTIQ_SECRET: ${ARVENTIQ_SECRET:?ARVENTIQ_SECRET is required}` to that service's `environment:`
block (matching `JWT_SECRET`/`TESTING_PLATFORM_KEY`/`JUDGE0_SHIM_KEY`), generating a new secret
value, and setting it in Dokploy. That compose edit itself briefly caused a false start — it was
made but not committed/pushed for a round of "still broken" reports before that was caught.

### Root cause #1 (the original 404) — Docker's archive-copy API silently breaks under `ReadonlyRootfs`

The 404 (`failed to upload files to container: API error (404): Could not find the file
/app/sub-... in container ...`) was **never a code bug in the mkdir fix (`713bf50`)** — that fix
was correct and did run (verified: rebuilding the image and confirming the binary + logs matched
the new source). The real cause is a **Docker Engine limitation**: `UploadToContainer`
(`docker cp` / `PutContainerArchive`) does not work against a container created with
`ReadonlyRootfs: true` (the C6 non-root hardening flag, `pool.go`'s `createContainer`) —
**even onto an explicitly writable tmpfs mount like `/app`**. Confirmed by hand on a live sandbox
container in this Codespace:
- `docker exec ... mkdir -p /app/sub-test123 && ls -la /app/` → directory demonstrably exists.
- `docker cp` a file into that exact, just-verified directory → still 404s with "Could not find
  the file ... in container".
- `docker cp` straight to the `/app` mount point itself → a *different*, more honest error:
  `"container rootfs is marked read-only"`.

So no amount of `mkdir -p` in application code could ever fix this — the daemon's own
archive-copy path is what's broken for `ReadonlyRootfs` containers, independent of whether the
target directory exists. This is also why the prior session's "rebuild + redeploy, still same
404, no change in error shape" observation made sense: the mkdir fix was genuinely running, and
still couldn't have worked.

**Fix** (`judge-service-go/pkg/executor/executor.go`, `copyFilesToContainer`): stopped using
`UploadToContainer` entirely. Instead, the tar archive (already built for the upload) is piped
over stdin into a `docker exec` running `sh -c 'mkdir -p "$1" && tar -xf - -C "$1"'` inside the
target container — a normal process write to the live tmpfs, not subject to the archive-copy
limitation. Verified `tar` is present in every language sandbox image
(`judge-c/cpp/csharp/go/java/js/kotlin/php/ruby/rust-env`).

### Root cause #2 (found while verifying the fix above) — `/app` tmpfs was silently `noexec`

Fixing root cause #1 unblocked file upload, but compiled-language submissions then failed a
different way: `OCI runtime exec failed: ... exec: "/app/sub-.../main": permission denied` (exit
126) — this happened even for a **freshly compiled, `judge`-owned, `0755` binary**, immediately
after compiling it, in the same shell. `mount`/`/proc/mounts` inside the container showed
`/app` mounted `noexec` — even though `pool.go`'s `Tmpfs` option string for `/app` never said
`noexec` (`"rw,nosuid,nodev,size=512m"`). This Docker Engine version (28.5.1) defaults a tmpfs
mount to `noexec` unless `exec` is named **explicitly** in the options string — the comment
directly above that line ("Unlike /tmp, this must stay executable") stated the intent correctly,
but the mount options never actually delivered it.

**Fix** (`judge-service-go/pkg/pool/pool.go`, `createContainer`): `/app`'s `Tmpfs` entry is now
`"rw,exec,nosuid,nodev,size=512m"`.

### A third, smaller fix needed to make #1 actually work end-to-end

Once file upload worked (root cause #1's fix), Java compilation still failed
(`error while writing Main: .../Main.class`) — the `mkdir -p` + `tar -x` in the exec both run as
`root` (needed, since the container's main process/exec defaults require root for this), but
compilation/execution runs as the unprivileged `judge` user (`getJudgeUser()`). A root-owned,
default-mode (`0755`) directory isn't writable by `judge`. Before the tmpfs migration this was a
non-issue because the host-side staging dir was explicitly `chmod 0777`'d
(`workspace.NewSubmissionWorkspace`) and bind-mounted straight through. Re-applied the same
world-writable approach on the container side: the exec is now
`mkdir -p "$1" && tar -xf - -C "$1" && chmod -R 0777 "$1"`.

### Verification performed (all in this Codespace, local dev stack)

Used the same curl recipe as below against `http://localhost:3000` (this Codespace's
`assessment-api`, dev shim key `judge0_shim_secret` — see `assessment-api/src/config/env.js`)
with `wait=true`:
- Python (`language_id: 71`, interpreted): `status.id: 3` (ACCEPTED), correct stdout.
- Java (`language_id: 62`, compiled): `status.id: 3`, correct stdout — exercises compile step.
- C++ (`language_id: 54`, compiled): `status.id: 3`, correct stdout.
- Go (`language_id: 60`, compiled): `status.id: 3`, correct stdout.

`copyFilesToContainer` is shared by `RunRawWithStdin` (the shim path tested above),
`CompileInContainer`, and `RunInContainerStream` (the real exam-grading path) — so this fixes
all three, not just the raw-run shim.

`go build ./...` and `go vet ./...` are clean. `go test ./...` has two **pre-existing** failures
in `judge-service-go/main_test.go` (`TestIsCentralCompareEnabled_DefaultsAndOverrides` sub-test
`unsupported_language_stays_legacy`, and `TestAppendBatchedResultsParsesJSONLines`) — confirmed
via `git stash` that both fail identically without this session's changes, so they're unrelated
and pre-date this fix. Not investigated further here; folds into Priority 1 item #1 below (the
"Go toolchain sanity check" that was already on the to-do list before this incident).

### What's left

1. **Not yet committed/pushed** — the two file diffs (`executor.go`, `pool.go`) are sitting in
   this Codespace's working tree. User handles `git commit`/push/Dokploy redeploy themselves per
   the constraints below.
2. **Not yet verified against `coding.fortifyhub.net`** — everything above was tested against
   this Codespace's local dev stack, not prod. Re-run the same curl test against prod after
   deploying, per the "How to test" section just below.
3. Root cause #2 (`noexec` tmpfs) is specific to this Docker Engine version's default behavior —
   worth double-checking prod's Docker Engine version behaves the same way (likely does, but
   confirm the fix actually changes prod's `mount` output for `/app` post-deploy the same way it
   did here, rather than assuming).

### How to test

**Route renamed** — `/api/judge0/*` is now `/api/codeAssess/*` (branding: avoid exposing that
this shim speaks GO Judge's wire format). The header name (`x-rapidapi-key`) is unchanged — it's
hardcoded in the exam-platform's own `judge.js`, not something this repo controls.

```
curl -s -w '\nHTTP_STATUS:%{http_code}\n' -X POST \
  'https://coding.fortifyhub.net/api/codeAssess/submissions?base64_encoded=true&wait=true' \
  -H 'Content-Type: application/json' \
  -H 'x-rapidapi-key: <JUDGE0_API_KEY from .env>' \
  -d '{"language_id":71,"source_code":"'"$(printf 'print(1)' | base64 -w0)"'","stdin":""}'
```
`language_id: 71` = python (see `LANGUAGE_ID_MAP` in `codeAssessShim.service.js` for others).
`stdout`/`stderr`/`compile_output` in the response are base64 — decode to read them. A passing
run looks like `status.id: 3` (ACCEPTED) with the program's real stdout.

### Regressions found and fixed so far (all committed to `main`)

The whole chain started from the C6 non-root-hardening change (judge-service-go now runs as a
non-root `app` user instead of root) plus a `/app` tmpfs migration (`e38d1f3`, multi-tenancy
commit) — three independent regressions surfaced sequentially as each was fixed and the next
error appeared:

1. **Workspace dir permission-denied** (`mkdir /tmp/judge-workspaces/judge-XXXX: permission
   denied`) — a host dir left root-owned from before the non-root switch. **Fixed** (commit
   `27676d2`): renamed `RootDir` in `judge-service-go/pkg/workspace/manager.go` from
   `/tmp/judge-workspaces` to `/tmp/judge-exec-workspaces` so the non-root user creates (and
   owns) a fresh dir instead of needing host access to chown the old one. **Confirmed fixed** —
   error stopped appearing in logs after this deployed.

2. **Docker socket permission-denied** (`dial unix /var/run/docker.sock: connect: permission
   denied`) — `DOCKER_GROUP_GID` in `docker-compose.prod.yml`'s `group_add` defaulted to `999`,
   didn't match the host's real Docker group GID. **Fixed**: user ran
   `stat -c '%g' /var/run/docker.sock` inside the judge-service-go container terminal (via
   Dokploy's UI — no host/SSH terminal access exists, only container terminals), got `992`, set
   `DOCKER_GROUP_GID=992` as a Dokploy env var and redeployed. **Confirmed fixed** — no more
   "no available containers" 503s.

3. **File upload to container 404s** (`failed to upload files to container: API error (404):
   Could not find the file /app/sub-raw-... in container ...`) — **RESOLVED, see the "🟢 INCIDENT
   RESOLVED" section at the top of this doc for the actual root cause and fix** (it was a Docker
   Engine limitation, not the mkdir-based theory below — the mkdir fix was necessary but not
   sufficient, and the "Next steps" list right after this section is superseded/moot). Kept below
   for the historical debugging trail. Commit `e38d1f3`
   switched the sandbox containers' `/app` from a host bind-mount to a tmpfs mount (deliberate —
   stops a submission from filling host disk), but nothing accounted for the fact that the
   per-submission subdirectory (`/app/sub-<id>`, created by `workspace.NewSubmissionWorkspace`
   via `os.MkdirTemp` on the HOST staging dir) used to auto-exist inside the container via the
   bind mount and now doesn't exist in the tmpfs at all until something creates it there.
   Docker's `PutContainerArchive`/`UploadToContainer` requires the destination directory to
   already exist, hence the 404. **This affects every submission path**, not just the raw-run
   shim — `RunInContainerStream`/`CompileInContainer` (the real exam-grading path) share the
   same `copyFilesToContainer` function.

   **Fix applied** (commit `713bf50`, `judge-service-go/pkg/executor/executor.go`):
   `copyFilesToContainer` now execs `mkdir -p <containerWorkDir>` as root inside the target
   container before uploading the tar (same pattern as the existing root-exec `/tmp` cleanup
   step in `RunRawWithStdin`). Also see commit `b379135` (`judge0Shim.service.js`) — a
   *separate*, already-confirmed-working fix that surfaces `raw.error` into the `stderr` field
   of the shim's response, since previously an internal judge-service-go error came back to the
   client as empty `stdout`/`stderr` with no indication anything was wrong — that's what made
   this diagnosable via curl at all.

   **Why this isn't confirmed fixed yet**: after what was reported as a full rebuild + redeploy
   (container IDs in the error response were cross-checked against the freshest pool-warmup log
   and do match the newest process), the live test **still returns the exact same 404** with no
   change in error shape (no "failed to create workspace dir" wrapper message, which the new
   mkdir-failure path would produce — meaning either the mkdir exec is succeeding but the
   upload still can't see the directory, or commit `713bf50`'s code still isn't the binary
   actually running). This was not resolved before handing off to Codespace.

### Next steps (superseded — kept for history; step 3 below is what turned out to be right)

**This whole numbered list is moot now** — item 3's "does UploadToContainer have some quirk with
tmpfs-mounted destinations" guess was correct, confirmed and fixed; see the top of this doc.
There's no need to work through steps 1-2 (binary/mkdir verification) again.

1. **Confirm the running binary actually matches `713bf50`.** Don't trust "a rebuild was done"
   at face value again — from a real Docker-capable terminal, rebuild judge-service-go
   explicitly (`docker compose -f docker-compose.prod.yml build --no-cache judge-service-go` or
   equivalent) and confirm the build step actually recompiles (watch for real `go build` output,
   not a cache hit), before redeploying.
2. If the binary is confirmed current and the 404 still happens, **exec into a live sandbox
   container directly** (`docker exec -it <containerId> sh`) while judge-service-go is idle and
   manually run `mkdir -p /app/sub-test && ls -la /app/` to check: does the mkdir actually
   succeed as root under this tmpfs mount (`rw,nosuid,nodev,size=512m`, see `pool.go`'s
   `createContainer`)? Does the directory persist / is it visible via a fresh `docker exec`?
   This isolates "mkdir doesn't actually work under this tmpfs for some reason" from "the new
   code isn't running."
3. Also worth checking directly: does `fsouza/go-dockerclient`'s `UploadToContainer` (calls
   Docker's `PUT /containers/{id}/archive`) have some quirk with tmpfs-mounted destinations
   specifically vs regular overlay filesystem paths — e.g. try uploading to a non-tmpfs path in
   the same container (there isn't an obvious one here, but worth a literature check) or add a
   temporary debug log right before/after the mkdir exec call in `copyFilesToContainer`
   (`judge-service-go/pkg/executor/executor.go`, ~line 178) printing the mkdir's own stdout/
   stderr/exit code, since right now a mkdir failure would be silent unless it hits the wrapped
   error return.
4. Once fixed and confirmed via the curl test above returning `status.id: 3`, also smoke-test at
   least one **compiled** language (e.g. `language_id: 62` for Java, or `54` for C++) since
   compilation exercises the same workspace path but with an extra exec step — the interpreted
   Python-only testing so far hasn't covered that.

### Constraints to remember

- **No host/VPS terminal access at all** — only container terminals via Dokploy's UI. Any fix
  must be deployable through code + Dokploy env vars/redeploy, never a host-level command.
- User handles all `git commit`/`push`/Dokploy redeploy actions themselves — report fixes as
  ready, don't ask permission to commit/deploy, and don't attempt it directly.
- Live secrets for testing (`JUDGE0_API_KEY`, etc.) are in the repo's `.env` file (gitignored,
  already present on this machine).

---

This file exists because the work below was planned and partly implemented from a Windows
machine with **no Docker, no Go toolchain, and no browser automation** — so a lot of it is
"implemented but unverified" or "deliberately not attempted because it needs Docker." That
prior session's chat history and its local memory system do **not** carry over to a fresh
`claude` terminal session in GitHub Codespace — this doc is the handoff artifact so nothing
gets lost. Read this first, then `docs/PLATFORM_AUDIT_AND_SAAS_ROADMAP.md` (full findings +
roadmap) and `docs/LOCAL_TESTING_NOTES.md` (per-item verification recipes) for full detail —
both are already up to date as of this handoff.

Repo state at handoff: everything below is **already committed to `main`** (nothing
uncommitted, nothing waiting on `git add`). This is a to-do list for the next session, not a
list of pending diffs.

---

## Priority 1 — Verify things that are already implemented (fast, do these first)

Nothing here is expected to fail — these are fixes made without the tooling to confirm them.
Treat any failure as a real bug to fix, not a false alarm.

1. **Go toolchain sanity check** (`judge-service-go/`, no Go available outside Docker/Codespace):
   ```
   go build ./...
   go vet ./...
   go test ./...
   ```
   Covers several unverified changes at once: `strconv.Atoi` env parsing, the Go
   `CompileCmd` dedup (`languages.go`/`GoAdapter`/`main.go` raw-run switch all now share one
   source), the `wrapper.GenerateWrapper` dead Java-template branch removal, and the C7
   executor timeout fix. Pay particular attention to `go_integration_test.go` and, if
   `JUDGE_CENTRAL_COMPARE_JAVA=false` is ever actually exercised in that env,
   `java_integration_test.go` with it set.

2. **`scripts/backup_db.sh`** (H11's concrete bug fix):
   ```
   docker compose up -d mongo   # dev stack — container_name: codespace_mongo
   ./scripts/backup_db.sh       # should auto-detect codespace_mongo
   ```
   Then simulate the prod case (no explicit `container_name`, e.g. run against
   `docker-compose.prod.yml`'s mongo service or a manually-renamed container) and confirm it
   still finds the right container via `docker ps --filter name=mongo` without needing
   `MONGO_CONTAINER_NAME`. Also stop all mongo containers and confirm the script exits with
   "No running mongo container found" instead of silently writing an empty backup.

3. **H4 usage metering** — confirm `usageevents` is actually being populated:
   ```js
   db.usageevents.find().sort({ createdAt: -1 }).limit(5)
   ```
   after running a submission end-to-end. Confirm `collegeId` is populated for a normal user
   and `elapsedMs` is a sane positive number.

4. **H8 cookie auth + CSRF check** — needs a running frontend + browser:
   - Log in, open DevTools → Application → Cookies: confirm a `token` cookie exists, is
     `HttpOnly`, and does **not** show up in `document.cookie`.
   - Confirm subsequent API calls succeed with no `Authorization` header (Network tab).
   - Log out, confirm the cookie clears and a subsequent protected-route call 401s.
   - Confirm `/api/integration/*` and `/api/codeAssess/*` (external partners, Bearer-header/shared
     -secret only, never send cookies) still work unaffected —
     `assessment-api/src/middleware/auth.mjs`'s `extractToken` checks the cookie first but
     falls back to the `Authorization` header.

5. **H10 `exceljs` migration** — needs a browser:
   - `/admin/users` bulk-import: upload a real student-roster `.xlsx`, confirm rows parse.
   - Download the sample template, credentials export, all-users export, and the
     assessment-results export (`/admin/assessments/:id/results`) — open each in a real
     spreadsheet app (Excel/LibreOffice) to confirm they're valid files, not just that the
     download fires.

6. **Draft-conflict banner** (`AssessmentWorkspace.jsx`): start an attempt in one tab, let the
   draft autosave, then in DevTools hand-edit `localStorage`'s
   `assessment-draft:<attemptId>`'s `savedAt` to an old timestamp (e.g. `1`) and reload —
   should show a dismissible "Draft conflict" warning banner.

7. **`problemDifficultyStats` analytics fix** (`submissions.service.js`'s `getMyAnalytics`) —
   no test coverage yet: seed a student with a mix of Easy/Medium/Hard solved submissions
   where `problemId` arrives pre-populated (normal `findByUserId` path), call
   `GET /api/v1/submissions/my/analytics`, confirm the average-difficulty figure reflects the
   seeded mix instead of defaulting to "Medium".

8. **`scripts/test_submission.js` harness login 401** — unresolved investigation, not a fix:
   ```
   HARNESS_LANGUAGES=python node scripts/test_submission.js
   ```
   against a local stack. Against the live site this got a `401 {"message":"No token"}` on
   `POST /api/auth/login` for the harness account, which is suspicious since `/auth/login` has
   no `verifyToken` middleware in front of it. A direct `curl` with wrong credentials
   correctly returned `{"message":"Invalid credentials"}`, so the route itself isn't broken —
   likely the harness account doesn't exist on that DB, or `registerOrLogin()`'s fallback to
   `/auth/register` fails because that route is now `superadmin`-only post-multi-tenancy. May
   need a seeded harness user/college, or an updated harness that can bootstrap one.

---

## Priority 2 — Real implementation work that needs Docker (not just verification)

9. **C6 remainder — scope the Docker socket via `docker-socket-proxy`**. Currently
   judge-service-go runs non-root but still has the raw `/var/run/docker.sock` bind-mounted
   with full, unscoped Docker API access. Stand up `docker-compose.prod.yml` locally, add a
   `docker-socket-proxy` (e.g. Tecnativa's) allow-listing only the endpoints actually used
   (grep `judge-service-go/pkg/pool/pool.go` and `pkg/executor/executor.go` for the exact
   Docker client calls — container create/start/stop/remove, exec create/start/attach,
   copy-to-container, container update for the resource-limit reset), point judge-service-go's
   Docker client at the proxy via `DOCKER_HOST`, and run the full `go test ./...` (includes
   real container-spawning tests) against it **before** this ever touches
   `coding.fortifyhub.net`. Getting the allow-list wrong silently breaks code execution for
   every tenant — this is the reason it was deferred rather than guessed at blind.

    **✅ Done 2026-08-08 — implemented, not deployed.** Added a `tecnativa/docker-socket-proxy`
    service to both `docker-compose.yml` and `docker-compose.prod.yml`, allow-listing exactly
    `CONTAINERS/POST/DELETE/EXEC/IMAGES` (matches the exact call surface in `pool.go`/
    `executor.go` — no networks/volumes/build/swarm/secrets calls exist). `judge-service-go`
    no longer bind-mounts `docker.sock` or needs `group_add`/`DOCKER_GROUP_GID`; it talks to
    the proxy via `DOCKER_HOST=tcp://docker-socket-proxy:2375` (zero Go code changes needed —
    `docker.NewClientFromEnv()` already respects `DOCKER_HOST`). Verified live against the
    local dev stack: pool warm-up, orphan-container cleanup, and real Python/Java submissions
    (interpreted + compiled, exercising exec + container-update calls) all work through the
    proxy; `GET /networks` and `GET /volumes` correctly 403. `docker-compose.prod.yml` edit is
    validated via `docker compose config` (with dummy secrets) but **not committed/deployed** —
    see `docs/USER_ACTION_ITEMS.md`.

10. **H11 remainder — real replication + tested restore path** for Mongo/Redis/RabbitMQ. The
    backup script itself is fixed (see Priority 1 #2); there is still no replication/clustering
    and no one has ever actually run a *restore* from one of these backups. Worth doing a full
    backup → simulate data loss → restore → verify drill before calling this closed.

    **✅ Done 2026-08-08 (dev DB only)** — ran the full drill against this Codespace's dev
    Mongo: inserted a marker doc, `./scripts/backup_db.sh`, `db.dropDatabase()` (simulated total
    loss), `mongorestore --archive --gzip` from the backup. All 245 documents across all 10
    collections restored with 0 failures, all indexes (including unique constraints) rebuilt
    correctly, marker doc round-tripped intact, and `/api/health` reported all services
    connected immediately after. The *replication/clustering* half of this item (no
    multi-node Mongo/Redis/RabbitMQ setup exists) is still open — that's a bigger infra change,
    not attempted here.

11. **H12 / Phase 3 — horizontal scale-out**. judge-service-go is bound to a single host's
    Docker socket with sandbox images built locally, no shared registry. Motivated by the
    already-measured CPU-bound ceiling on the current VPS (~7 req/s interpreted languages,
    ~8-12 req/min slow-compile languages — see the `capacity_vps_limits` context, or just
    re-measure). Real work: get sandbox images into a registry, decouple judge-service-go from
    one host (Docker-in-Docker or Kubernetes Jobs-based executor pool).

    **🔲 Not started** — large infra/design decision, out of this session's scope. See
    `docs/USER_ACTION_ITEMS.md`.

12. **CI gates smoke test**. `.github/workflows/ci.yml` now has `security-audit` (npm audit /
    audit-ci), `secret-scan` (gitleaks), and blocking lint on both `assessment-api` and
    `frontend`. These have not been watched run green on an actual push from this repo yet —
    push a trivial branch/PR (or trigger via `gh workflow run` / `act` locally if available) and
    confirm all jobs pass, especially `assessment-api`'s lint (recently flipped from
    non-blocking to blocking) and the `frontend` `audit-ci` allowlist for its one
    documented-unfixable `react-router` advisory.

    **⚠️ Simulated locally 2026-08-08, one job inconclusive** (`act`/GitHub CLI not available in
    this Codespace, so ran each job's actual commands by hand instead of the workflow runner
    itself):
    - `judge-unit` (`go build ./...`, `go test ./...`): clean.
    - `backend-unit` / `frontend-unit` (`npm test`, `npm run lint`): clean in both repos.
    - `secret-scan`: ran gitleaks (`zricethezav/gitleaks:latest` container) against the full
      182-commit history — no leaks found.
    - `security-audit`: **found 2 real high-severity vulnerabilities that would have failed
      this job** — `nanoid <3.3.17` (transitive via `postcss`←`vite`, both repos) and
      `ip-address <=10.3.0` (transitive via `express-rate-limit`, `assessment-api` only).
      Fixed with `npm audit fix` in both repos (transitive patch/minor bumps only, no
      manifest/major changes — `package-lock.json` updated in both, `package.json`
      untouched). Re-verified clean: `npm audit --audit-level=high` → 0 vulnerabilities,
      `npm run audit:ci` (frontend, respecting the documented `react-router` allowlist) →
      passed, and both repos' tests + lint re-run clean after the bump.
      **Follow-up 2026-08-08:** the `npm audit fix` run left `assessment-api/package-lock.json`
      internally inconsistent (stray/duplicate `@emnapi/*` entries, one version mismatch) —
      `npm install` tolerated it silently but `npm ci` (what CI and
      `assessment-api/Dockerfile` both use) rejected it with `EUSAGE`, which broke
      `docker compose up --build`. Fixed by deleting `node_modules`/`package-lock.json` and
      regenerating clean via `npm install` from `package.json`. Re-verified: `npm ci` clean,
      `npm audit --audit-level=high` → 0 vulnerabilities, `npm test` → 79/79, and a full
      `docker compose up --build -d` now brings up every container with `/api/health`
      reporting all of mongodb/redis/rabbitmq/judge `connected`. `frontend/package-lock.json`
      never had this problem.
    - `judge-certification` (`go test -tags=integration ./...`, spawns real containers):
      **inconclusive** — timed out (10 min) mid-run. Root cause traced to this Codespace's
      resource contention, not a code/proxy regression: the dev stack's own warm pool was
      already running (48 containers) when the suite added ~17 more on top, on only 4 CPUs
      (load average hit 4.43). `DOCKER_HOST` was unset in the host shell for this run, so it
      exercised the raw socket, not the new proxy — ruling out the proxy migration as the
      cause. Needs a real run on GitHub's dedicated runners (or a Codespace with the dev stack
      stopped first) to get a clean signal — flagged in `docs/USER_ACTION_ITEMS.md` rather than
      guessed at further here.
    - `e2e` (Playwright): not exercised — only runs on push to `main`/`master`, and is heavy
      (fresh `docker-compose up`, browser install); out of scope for a same-session smoke test
      given the integration-suite contention already observed.

13. **`scripts/backfill_college_id.mjs`** — still needs to be run against the real production
    database before/at any second-customer cutover (per the C2 tenant-scoping fix). Confirm
    it's idempotent-safe to run again if it's ever unclear whether it already ran, then run it
    for real once there's DB access to prod (or its staging equivalent).

    **🔲 Deliberately untouched** — per your explicit instruction, left entirely for you/whoever
    has prod DB access. This Codespace has no prod credentials.

---

## Priority 3 — Known-open items that don't strictly need Docker, but need either a browser or a bigger design call (lower priority, do after 1-2)

- **H3** — integration `/results/:_id` auth is weaker than other integration routes (service-key
  only, no per-assessment scoping). Deliberately left as-is: the documented partner contract
  (`docs/INTEGRATION_GUIDE.md:86`) says service-key-only is the intended auth for this route,
  and there's no `externalId`/`createdBy` marker to scope by yet. Real fix needs a per-partner
  key + `externalId` design, not a quick patch — see the H3 entry in the roadmap doc for the
  full reasoning before touching this.
- **IDE/run/submit logic dedup** between `AssessmentWorkspace.jsx` (1250 lines) and
  `ProblemPage.jsx` (539 lines) into a shared hook. Needs a browser to verify a refactor of the
  live code-run/submit path (used in both graded exams and practice mode) doesn't regress
  either flow.
- **Other language adapters' `CompileCommand`/`RunCommand` dedup** (only Go's was unified —
  the others append per-language wrapper-protocol args, so it's a bigger, untested refactor of
  the sandbox execution path). Needs Docker + each language's toolchain to verify safely.
- **Secrets rotation** — no mechanism exists for `TESTING_PLATFORM_KEY`/`CODEASSESS_SHIM_KEY`
  (static shared secrets for the two external integrations).
- **Console-only, unstructured logging** throughout `assessment-api` — no structured
  logger/log aggregation.
- **No in-repo frontend prod deployment/health config** (`docker-compose.prod.yml` explicitly
  excludes the frontend today — there's no deployed frontend at all yet).
- **Phase 4** (the old aspirational multi-model `ProblemType`/`ExecutionStrategy` plan) is
  fully unstarted and intentionally deprioritized until Phases 1-3 are solid — don't pick this
  up early even if it looks appealing; see §0 and §3 of the roadmap doc for why.

---

## Where to look for more detail

- `docs/PLATFORM_AUDIT_AND_SAAS_ROADMAP.md` — the full findings table (every item above has a
  fuller writeup there, searchable by its ID: C6, H3, H11, H12, etc.) and the phased roadmap.
- `docs/LOCAL_TESTING_NOTES.md` — per-item "what to run, what to expect" recipes for most of
  the Priority 1 items above (this doc's §1-§7 map onto Priority 1 #2-#7 here).
- `docs/INTEGRATION_GUIDE.md` — the documented contract for `/api/integration/*`, relevant to
  H3.
