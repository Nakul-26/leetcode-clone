# Changelog

> This file was last kept up to date in 2026-08. Later changes are recorded in the git history and, for the
> judge, in the dated rows of [`docs/judge/JUDGE_FIX_PLAN.md`](./docs/judge/JUDGE_FIX_PLAN.md) and
> [`docs/judge/JUDGE_AGENT_PLAN.md`](./docs/judge/JUDGE_AGENT_PLAN.md).

## Unreleased

### Added
- `POST /api/arventiq/run` — ephemeral "Run" (LeetCode-style Run vs. Submit), execution against caller-supplied input with no `Submission` doc, no RabbitMQ, and no effect on score/history. Calls the Go judge's synchronous `/run` HTTP endpoint directly, the same ephemeral path `problems.service.js::runProblem` already used for the platform's own practice-mode Run.

### Fixed
- `problems.service.js::runProblem` (pre-existing, unrelated to Arventiq) always sent `functionName` and never sent `problemType` to the Go judge — harmless until a `stdin`-type `Problem` existed, which it now does. Made `problemType`-aware.
- The new Run endpoint's `errorType` field was leaking the Go comparator's `wrong_answer` classification even for correct output — Run sends an empty `expected` (no notion of correctness), so the comparator flags any non-empty stdout as a mismatch. Filtered to only surface real execution failures.

## v1.0.1 — 2026-07-24

### Fixed
- `assessment-api/Dockerfile`: `npm install` failed with `EACCES` on `package-lock.json` on a truly clean build (no cached layers to mask it). `COPY` runs as root regardless of the active `USER` directive unless `--chown` is given; added `--chown=node:node` to both `COPY` steps. Found via a from-scratch fresh-clone verification of `multimodel-mvp`.

## multimodel-mvp — 2026-07-24

The coding platform's judge evolved from a single execution model (named-function submissions only) into a multi-model execution engine, and that new `stdin` model was proven end-to-end through a new Arventiq integration layer. Full design history in `docs/arventiq-integration/`.

### Added — Go judge (`judge-service-go`)
- `ExecutionStrategy` interface + registry (`strategy.go`), dispatched by `Problem.problemType`, mirroring the existing `LanguageAdapter`/`AdapterRegistry` pattern used for languages. The existing named-function execution path was extracted behind it as `FunctionExecutionStrategy` — a behavior-preserving refactor, not a rewrite.
- `stdin` problem model: a full stdin/stdout program instead of a named function with typed parameters. New `RunInContainerWithStdin` (executor), `StdinExecutionStrategy` + `stdin_runner.go`, an exact-text `Comparator` (`pkg/comparator/text.go`), and stdin-mode language adapters for python/javascript/cpp/c/go (`pkg/central/adapters/stdin_adapter.go`).
- `ProblemType` (`function` | `stdin`) on both `Problem` and `SubmissionMessage`; `functionName`/`returnType`/`parameters` are now required only for `function`-type problems, on both the Go and Node sides.

### Added — Node API (`assessment-api`)
- New `/api/arventiq/*` surface, authenticated by a shared secret (`ARVENTIQ_SECRET`) rather than per-candidate JWT — separate from the existing `/api/integration/*` layer, which is unaffected.
  - `POST /api/arventiq/problems` — Problem Sync: upserts a `Problem` by `externalId` from Arventiq's native `questions`/`test_cases` schema.
  - `POST /api/arventiq/submissions` — Submission Translator: resolves `externalId` → internal `Problem`, maps `code_language` via a config table, and submits through the existing submission pipeline.
  - `GET /api/arventiq/submissions/:_id` — Response Mapper: maps the internal `Submission`/`testResult` to Arventiq's expected verdict shape (`verdict`/`score`/`passed_count`/`total_count`/`cases[]`).
- `Problem.problemType`, `Problem.externalId` (sync key), `Problem.inputFormat`/`outputFormat`.
- `Submission.externalStudentId`/`externalAssessmentId` — opaque traceability metadata for Arventiq-originated submissions, not used for auth or ownership.
- `submissions.service.js`'s message-envelope construction (previously duplicated across `submitSolution` and three `rejudge*` functions) is now a single shared, `problemType`-aware helper.

### Changed
- None of the above changes existing behavior for `function`-mode problems: `problemType` defaults to `"function"` wherever it's unset (Go and Node), so every problem that predates this release keeps working unmodified. Verified live, not just by unit test.

### Migration notes
- No action required for existing problems — `problemType` defaults to `function`.
- To create a `stdin` problem directly (outside the Arventiq sync flow), set `Problem.problemType = "stdin"`; `testCases[].inputs` becomes a single-element array holding the raw stdin text, and `testCases[].expected` becomes the raw expected stdout text (both strings), instead of typed parameter values.
- `Problem.externalId` must be unique across synced problems; it's how `POST /api/arventiq/problems` decides whether to upsert an existing problem or create a new one.

### Known limitations (deferred, see `docs/arventiq-integration/TASKS.md`)
- Per-test-case correlation back to Arventiq's original `test_cases` rows is positional (array order), not by their own row id.
- `memory_kb` is always `null` in the Arventiq response mapper (the Go judge doesn't populate per-test memory usage yet).
- Output normalization (whitespace/newline/case/float-tolerance), weighted scoring/subtasks, and custom checkers are explicitly out of scope for this release — see `docs/arventiq-integration/PLAN.md` §5 for the phased roadmap.

### Verified
- Full non-Docker Go test suite and full Node vitest suite: no regressions attributable to this work (two pre-existing, unrelated Go test failures and one MongoMemoryServer resource-contention flake, both confirmed pre-existing).
- Live, against the real Docker-composed stack: stdin execution (Accepted / Wrong Answer / Time Limit Exceeded / unsupported-language), the full Arventiq flow (sync → submit → poll → verdict), and a regression check of an existing function-mode problem (3Sum) submitted end-to-end.
- A from-scratch fresh-clone bootstrap: `go build`/`go vet`, `docker compose build` (all images), `docker compose up`, and the full Arventiq flow, all from a clean checkout with no pre-existing state.
