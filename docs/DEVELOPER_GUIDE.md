# Developer Guide

How to work on this codebase without breaking it. Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) first.

- [1. Setup](#1-setup)
- [2. Running the stack locally](#2-running-the-stack-locally)
- [3. Tests](#3-tests)
- [4. The contract harness](#4-the-contract-harness)
- [5. Conventions](#5-conventions)
- [6. Recipes](#6-recipes)
- [7. Pitfalls we have already hit](#7-pitfalls-we-have-already-hit)
- [8. Git and releasing](#8-git-and-releasing)
- [9. Keeping the docs true](#9-keeping-the-docs-true)

---

## 1. Setup

You need:

| Tool | Version | For |
|---|---|---|
| Node.js | 18+ (uses the global `fetch`) | `assessment-api`, scripts |
| Go | 1.25+ (`judge-service-go/go.mod`) | `judge-service-go` |
| Docker | with Compose v2 | the local stack and the sandboxes |

```bash
cd assessment-api && npm install
cd ../frontend && npm install
```

The Go module needs no separate install; `go build` fetches dependencies.

---

## 2. Running the stack locally

```bash
docker compose up -d --build          # from the repo root
curl localhost:3000/api/health        # wait for "status":"healthy" (can take a minute on first start)
```

| Service | Host port | Notes |
|---|---|---|
| API | 3000 | override with `API_HOST_PORT` |
| Frontend (Vite) | 5173 | |
| MongoDB | 27017 | |
| Redis | 6379 | override with `REDIS_HOST_PORT` |
| RabbitMQ | 5672, 15672 (management UI) | |
| Judge | none | internal only (`judge-service-go:8081`); reach it through the API |

**If other projects on your machine already use 3000 or 6379** (it happens) compose fails with
`port is already allocated`. Do not stop the other project; override instead:

```bash
export API_HOST_PORT=3100 REDIS_HOST_PORT=6380
docker compose up -d --build
```

Then use `http://localhost:3100`.

> **Check you are talking to *your* service.** A script that waits for "any HTTP response" on a port
> can succeed against some other app that owns the port. Wait for `"status":"healthy"` from
> `/api/health`, not for a 200 on its own.

### Rebuilding after a change

```bash
docker compose up -d --build assessment-api judge-service-go
```

The judge uses the `dev` stage of its Dockerfile locally: it compiles from source **every time the container
starts**, so a restart is enough for Go changes. It is *not* hot-reloading, and it never runs the production
`runtime` stage. The language sandbox images (`judge-<lang>-env`) are built once.

### Getting a key to try the public API

On a **local** stack only:

```bash
# 1. a college and its admin
curl -s -X POST localhost:3000/api/auth/signup -H 'content-type: application/json' \
  -d '{"collegeName":"Dev College","name":"Dev","email":"dev@local.test","password":"<choose one>"}'
# 2. use the returned token to issue a key
curl -s -X POST localhost:3000/api/admin/api-clients -H "Authorization: Bearer <token>" \
  -H 'content-type: application/json' -d '{"name":"dev","scopes":["codeassess"]}'
```

The key is printed once. Never use real credentials for local accounts, and never commit keys.

---

## 3. Tests

### API (`assessment-api`)

```bash
cd assessment-api
npx vitest run                          # everything (~1 minute)
npx vitest run src/routes/apiClientQuota.test.js   # one file
npx eslint src models                   # lint
```

Tests run against an in-memory MongoDB (`mongodb-memory-server`), a mocked Redis and a mocked RabbitMQ
(`src/test/setup.js`, `src/test/mocks.js`). No Docker is needed.

### Judge (`judge-service-go`)

```bash
cd judge-service-go
go vet .
go test . ./pkg/... -count=1           # unit tests
go test -tags integration -count=1 ./...   # needs the sandbox images built; slow
```

- **Always pass `-count=1`.** Go caches test results; an environment-variable change does not bust the cache,
  so a run can report `ok (cached)` for code that has since broken.
- On Windows, two tests in `pkg/workspace` fail with "A required privilege is not held by the client". They
  create symlinks, which needs elevation. They are unrelated to your change; run them in Docker or WSL if you
  touch that package.

### Patterns used here

- **A counter-capable fake Redis, hoisted.** The shared Redis mock only has `get`/`set`, so every `incr` throws
  and quotas fail open, which means it cannot test enforcement. See `apiClientQuota.test.js`: the fake is built
  with `vi.hoisted` because `vi.mock` factories run before the rest of the file.
- **Mock the publisher, not the broker.** Tests that assert what was queued mock
  `../services/evaluation.service.js` and inspect `publishSubmissionMessage.mock.calls`.
- **Simulate the judge** by updating the `Submission` row after the publish, as the real judge does.
- **A fake that can be read.** `queueStats.test.js` uses a fake broker connection. An earlier version of that
  test passed against the shared mock, which *cannot* be inspected, while returning `null` for every queue in
  reality. A test that can only pass is worthless: make sure the fake can also fail.
- **Mutation-check what matters.** After writing tests for important behaviour (enforcement, refunds, seeding),
  break the code on purpose and confirm a test fails. Three mutations were applied to the quota service and all
  three were caught; do the same for anything that guards money or tenant isolation.
- **Test the negative tenancy cases.** Every scoped endpoint needs a test that another college gets `404`, and
  one that a body-supplied `collegeId` is ignored.

---

## 4. The contract harness

`scripts/judge_contract_check.mjs` pins the **observable behaviour** of the public judge API, so a change
cannot silently alter what an integrating platform sees. It sends 21 fixtures (C++, Java, Python; accepted,
multiline, empty input, compile error, runtime error, timeout) and compares normalised results with
`scripts/tests/judge-contract-baseline.shim.json`.

```bash
# the legacy synchronous path (shared secret)
node scripts/judge_contract_check.mjs --target shim --base http://localhost:3000
# the queue-backed path (an ak_ key)
node scripts/judge_contract_check.mjs --target shim --base http://localhost:3000 --key ak_...
# the judge's internal /raw-run
node scripts/judge_contract_check.mjs --target raw
```

`--base` is the host and port **without** `/api/codeAssess`; the script adds that itself.

Both paths must report `21 fixtures, 0 difference(s)`. This is the check that found, on the first real run, that
the queue path was corrupting any string literal containing `\n`, which no unit test had caught.

Other modes:

| Flags | Use |
|---|---|
| `--filter accepted --repeat 24 --concurrency 4` | Latency and throughput |
| `--record` | **Re-record the baseline.** Only when you intend the observable behaviour to change, and say so in the commit |
| `--allow-remote` | Required for any non-local host. Never point load mode at production |

If a diff appears, it is either a regression to fix or an intended change to record deliberately. Never
re-record to make a diff go away without understanding it.

---

## 5. Conventions

### Tenancy (the rules that have been broken before)

1. The `collegeId` always comes from the authenticated principal, **never the request body**. Superadmin is the
   only role that may name a college.
2. Reading or changing another college's resource returns **404, not 403**.
3. Queries are scoped at the database level (`{ collegeId }` in the filter), not filtered afterwards.

The same bug has been fixed in several route files. When you add an endpoint, copy the scoping pattern from
`apiClients.service.js` (`collegeScopeFor`, `findScoped`) and write the cross-tenant test first.

### Errors

- Throw `HttpError(status, message, body)`; the error handler renders it.
- Each public surface keeps its **own** error shape. Do not "tidy" a 401 body on `/api/codeAssess` or
  `/api/integration`: callers we cannot see depend on it.
- For a `429`, set `err.retryAfter` (seconds) and the handler sends `Retry-After`.

### Comments

Comment **why**, not what. The codebase's useful comments record a constraint or a past failure ("this exists
because..."). Keep that habit: the next person cannot see the incident.

### Secrets and logs

Never log a key, token or password. Identify a key by its 8-character `keyPrefix`.

### Line endings

The repository is a mixture of CRLF and LF files (Windows checkouts with `core.autocrlf=true`; shell scripts
are forced to LF by `.gitattributes`). Git prints `LF will be replaced by CRLF` warnings; they are expected.
When a script edits a file, **read it and preserve its endings**. Do not measure them with
`grep -c $'\r'` in Git Bash, which expands to an empty pattern and matches every line. Use Python:
`open(f,'rb').read().count(b'\r\n')`.

---

## 6. Recipes

### Add a language

1. `judge-service-go/environments/<lang>/Dockerfile` and a service in both compose files (image `judge-<lang>-env`).
2. `pkg/languages/languages.go`: add the entry (compile and run commands for function mode).
3. `pkg/central/adapters/<lang>.go`: the function-mode wrapper adapter, if the language should support stored
   function problems.
4. `pkg/central/adapters/stdin_adapter.go`: **one entry in `StdinAdapterRegistry`**. This is what the public API,
   `/raw-run` and stdin problems all use. A test (`TestEveryLanguageHasAStdinAdapter`) fails if you forget.
5. `assessment-api/src/services/codeAssessShim.service.js`: add the id to `LANGUAGE_ID_MAP`.
6. Pool abbreviation in `langPoolAbbrev` and a default max in `langPoolMaxDefault` (`main.go`).
7. Update the languages table in [`GO_JUDGE_API.md`](./GO_JUDGE_API.md) and add contract fixtures.

### Add a field the judge writes

The judge inserts into `usageevents` and updates `submissions` with the **raw Mongo driver**, bypassing
Mongoose. Add the field in `main.go` *and* to the Mongoose model so the API can read and index it. Mongoose
will not do it for you.

### Change what a public endpoint returns

1. Decide if it is additive (new field: fine) or a change to an existing field (breaks callers).
2. Run the contract harness before and after.
3. Record a new baseline only for an intended change, and update [`GO_JUDGE_API.md`](./GO_JUDGE_API.md) and
   [`FRIEND_PORTAL_CHANGES.md`](./FRIEND_PORTAL_CHANGES.md).

### Add a quota dimension

Follow `apiClientQuota.service.js`: reserve before the work, **refund on every path where the work does not
happen**, fail open on Redis errors, and seed durable counters from `usageevents` if the limit is something a
customer pays for. Write tests for the refund paths; they are the ones that are forgotten.

### Add a keyed scope

Add the scope to the `enum` in `models/ApiClient.mjs`, to `VALID_SCOPES` in `apiClients.service.js`, and build
the surface's authenticator with `apiClientAuth({ scope, extractKey, legacySecret, unauthorizedBody })`.

### Add a judge setting

Read it with `getIntEnv`, give it a default that preserves current behaviour, log its effective value at
startup, and add a row to the table in [`OPERATIONS_RUNBOOK.md`](./OPERATIONS_RUNBOOK.md).

---

## 7. Pitfalls we have already hit

Each of these cost real time. They are listed so you do not repeat them.

| Pitfall | What happened | How to avoid it |
|---|---|---|
| **Redeclaring a RabbitMQ queue with new arguments** | Adding `x-max-priority` to the existing queue fails with `PRECONDITION_FAILED` and stops publishing | Add a new queue |
| **`channel.connection` in amqplib** | It is the low-level protocol connection and has **no** `createChannel`. Queue-depth reads returned `null` | Use the object returned by `amqp.connect()` (`getConnection()`) |
| **`checkQueue` on a missing queue** | The broker closes the channel it ran on | Use a throwaway channel, never the shared publishing channel |
| **Reading the priority queue first** | Did nothing: workers were all blocked waiting for a container, and Go wakes blocked receivers in FIFO order | Dedicated interactive workers and a container reserve |
| **`UnescapeCode` on raw source** | Rewrote `\n` inside string literals, so valid programs stopped compiling | Public path never unescapes; see the portal-changes doc |
| **Exec-form `ENTRYPOINT` + compose `command:`** | `command:` became *arguments* to the entrypoint, so the dev judge was never rebuilt from source | The `dev` Dockerfile stage has no entrypoint |
| **Go test cache** | `ok (cached)` hid a broken change after an env var changed | `-count=1` |
| **Port collisions with other local projects** | A wait-for-port loop succeeded against someone else's app | Wait for `/api/health` to say `healthy`; override host ports |
| **`process.exit()` during fetch teardown on Windows** | libuv assertion, exit code 127 | Set `process.exitCode` and let the process end |
| **Shell and heredoc escaping** | `\\n` in a heredoc or `printf` was collapsed, silently changing a program's source | Write files with an editor, or use a quoted heredoc (`<<'EOF'`) and verify with `od -c` |
| **Mongoose vs the judge's raw writes** | A field the judge writes is invisible to the API until it is in the schema | Update both |
| **`vi.mock` factory referencing a top-level variable** | `Cannot access 'x' before initialization` | `vi.hoisted` |
| **A test that cannot fail** | The queue-depth test passed against an unreadable mock | Make sure the fake can also produce the failure |
| **Counting requests instead of test cases** | A batch of 20 would dodge both limits and billing | Always `testCount` |
| **Charging for work that did not run** | A failed enqueue left quota consumed | Every reservation needs a refund path |
| **Orphan `Pending` rows** | A failed publish left a submission spinning forever | Mark it `Error` in the failure path |
| **Import path casing** | `HttpError.js` imported a file named `httpError.js`. Windows ignores case, so every test passed; the Linux image crashed on startup | `src/importCase.test.js` now fails on it. Still, after adding a file, check the name you import matches exactly |
| **Lockfiles regenerated on Windows** | `npm uninstall` / `npm audit fix` dropped an optional dependency, so `npm ci` on Linux failed with `Missing: yaml@2.9.1 from lock file` and broke CI, the Docker build and E2E | After touching `package-lock.json`, regenerate it in Linux: `docker run --rm -v <dir>:/w node:20-alpine sh -c "cd /w && npm install --package-lock-only --ignore-scripts"`, then confirm `npm ci` works there |
| **Bare service names on Dokploy** | A service with a domain also sits on a network shared by all projects, so `redis` reached another project's Redis and the API never started | Reach dependencies through the `go-judge-*` aliases (see the Operations Runbook) |
| **Same-site POSTs still send `Origin`** | The API rejected the web frontend with `Not allowed by CORS` (shown as a generic 500) because its allow-list was empty | List every frontend hostname in `CORS_ALLOWED_ORIGINS` |
| **CI audits dev dependencies too** | `braces` (via `nodemon`) has no patched release, so the audit stayed red | Prefer built-ins (`node --watch`) over dev tools that pull in unpatched chains |
| **`rm -rf /tmp/*` skips hidden files** | The per-run cleanup left dot-files (and the Go cache) behind, so a later submission could read what an earlier one planted | Clean with `find /tmp -mindepth 1 -maxdepth 1 ...` (see `containerResetScript`) |
| **Pooled containers are shared between students** | Submission folders in `/app` were never removed inside the container and were world-readable, so a later student's program could read earlier solutions | Every container is reset before reuse (`ResetContainer` in `finishWithContainer`); the privacy check in the Performance Review shows how to test it |

---

## 8. Git and releasing

- **Never push to `main` casually.** It autodeploys **two** production stacks. Read the runbook's deploy rules.
- Work on a branch. The long-lived working branch carries a large unreleased snapshot; before pushing, check
  `git log origin/main..HEAD` and decide what is really meant to ship, and cherry-pick if not.
- One logical change per commit. Commit messages explain **why** and record what was measured, not just what changed.
- Do not commit: keys, `.env`, local result dumps, personal spreadsheets.
- Run the API tests, the Go tests and the contract harness (both paths) before committing a change to the judge
  or the public API.

---

## 9. Keeping the docs true

A document that is wrong is worse than none. When you change the system, update the document that describes it:

| If you change... | Update |
|---|---|
| A public endpoint, field, status, limit or error | [`GO_JUDGE_API.md`](./GO_JUDGE_API.md) **and** [`FRIEND_PORTAL_CHANGES.md`](./FRIEND_PORTAL_CHANGES.md) |
| An environment variable | The table in [`OPERATIONS_RUNBOOK.md`](./OPERATIONS_RUNBOOK.md) |
| A request flow, data model field or invariant | [`ARCHITECTURE.md`](./ARCHITECTURE.md) |
| How a client is set up or limited | [`CLIENT_ONBOARDING.md`](./CLIENT_ONBOARDING.md) |
| A non-obvious decision | The decision log in `ARCHITECTURE.md` |
| A new way things go wrong | The playbooks or known risks in the runbook |

Examples in the API reference are **tested**: they were run, verbatim, against a live stack. Do the same when
you change them.
