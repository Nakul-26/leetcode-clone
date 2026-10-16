# Coding Platform → Multi-Model Execution & Arventiq Integration

**This is the living plan document. Edit it in place as decisions evolve — do not create a new `PLAN_V3.md`, `PLAN_FINAL.md`, etc.** If a change is big enough to want a snapshot, add one to `history/` (see below) and keep editing this file. This convention exists specifically to stop the file sprawl that preceded this document (`plan`, `what to do`, `what to do 2`, `3`, `..._V1.md`, `..._V2.md`).

**Status:** architecture stabilized (language × execution-strategy split, stdin/stdout confirmed as required, phased rollout agreed). Ready to move into low-level design / per-file implementation tasks.

**History:** the full discussion that produced this document is preserved, in order, in [`history/`](./history/):
1. [`01-original-plan-raw.md`](./history/01-original-plan-raw.md) — first rough plan (assumed a GO Judge-mimicry adapter)
2. [`02-coding-platform-draft-notes.md`](./history/02-coding-platform-draft-notes.md) — reframed as "coding platform = execution engine," documentation split proposed
3. [`03-plan-review-discussion.md`](./history/03-plan-review-discussion.md) — codebase-grounded gap review; identified the problem-model question as the real blocker
4. [`04-arventiq-real-schema-and-payload.md`](./history/04-arventiq-real-schema-and-payload.md) — real Arventiq `supabase_schema.sql` + sample payload; confirmed stdin/stdout, not function-signature
5. [`05-initial-gap-analysis-report.md`](./history/05-initial-gap-analysis-report.md) — first codebase gap analysis (existing `/api/integration/*` layer, submission pipeline, Go judge)
6. [`06-plan-v1-grounded-in-codebase.md`](./history/06-plan-v1-grounded-in-codebase.md) — V1: corrected against the actual codebase, open decisions enumerated
7. [`07-plan-v2-execution-strategy.md`](./history/07-plan-v2-execution-strategy.md) — V2: introduced `ExecutionStrategy` / `LanguageAdapter` split, `RunInContainerWithStdin`, phased roadmap

Related, standing (not part of this history — living reference docs elsewhere in the repo):
- [`judge-service-go/ANALYSIS.md`](../../judge-service-go/ANALYSIS.md) — Go judge deep-dive
- [`docs/INTEGRATION_GUIDE.md`](../INTEGRATION_GUIDE.md) — the *existing* generic "Testing Platform" integration layer (`/api/integration/*`) — different client, different auth model, see §6 below

---

## 1. Where this stands

**The core finding, with evidence:** Arventiq is a stdin/stdout judge (raw `input`/`expected_output` text, programs read `sys.stdin`), not a function-signature judge. Your Go judge currently hard-requires `functionName`/typed `parameters`/`returnType` (`pkg/models/submission_message.go:66`, `pkg/models/problem.go:176`). Syncing an Arventiq problem into your `Problem` collection doesn't change its shape — it's still stdin-shaped data, and nothing in the current judge can execute that.

**The decision:** build stdin/stdout execution as a first-class, second problem model in the Coding Platform — not an Arventiq-specific patch. Framed this way, Arventiq is the first consumer of a platform capability, not the reason the capability exists. This matters because stdin/stdout is the dominant competitive-programming model industry-wide; any future non-LeetCode-style integration hits the same wall.

**What does *not* change:** `Submission → RabbitMQ → Go Judge → MongoDB/Redis`. The Go judge stays client-agnostic — it never learns about Arventiq, assessment IDs, or external payload shapes. See §7 for the explicit list of what's unaffected.

---

## 2. Problem Model

The Coding Platform supports more than one way of defining "what does it mean to solve this problem."

```text
Problem Model

Currently:
  • Function   — LeetCode-style: named function, typed parameters, typed return value.
                 The judge generates a wrapper harness that calls the function and
                 compares the returned value structurally.
  • STDIN      — Competitive-programming-style: a full program reads from stdin and
                 writes to stdout. The judge runs the program as-is and compares
                 captured text output.

Future (not scoped, not designed — just acknowledged as the reason this is
generalized rather than hardcoded to two cases):
  • Interactive — judge and program exchange multiple stdin/stdout rounds
  • SQL         — query executed against a fixture database, result set compared
  • Notebook    — cell-by-cell execution, output-per-cell compared
```

Every problem has exactly one problem model. It's an attribute of the `Problem` document (`problemType`), set at creation/sync time, and it determines which `ExecutionStrategy` the judge dispatches to. A submission's language (Python/C++/Java/…) is a completely separate, orthogonal attribute — see §3.

---

## 3. Architecture

### 3.1 Two independent dimensions

```text
Dimension 1 — Language              Dimension 2 — Problem Model
  Python                              Function        (existing)
  C++                                 STDIN           (new)
  Java                                Interactive     (future)
  Go                                  SQL             (future)
  JavaScript                          Notebook        (future)
```

- **Language** → existing `LanguageAdapter` interface (`pkg/central/adapters/`), dispatched via the existing `AdapterRegistry`. Unchanged.
- **Problem Model** → new `ExecutionStrategy` interface, dispatched via a new **Strategy Registry** (§3.4) — deliberately mirroring the `AdapterRegistry` pattern that already exists for languages, so dispatch logic has one consistent shape in the codebase rather than two.

```text
Submission
    ↓
StrategyRegistry.Resolve(problem.Type)  +  LanguageAdapter
    ↓
  Prepare
    ↓
  Execute
    ↓
  ParseResult
    ↓
  Compare  ──────▶  Comparator (separate component, see §3.3)
    ↓
  Result
```

### 3.2 `ProblemType` — typed, not stringly-typed

```go
type ProblemType string

const (
    FunctionProblem ProblemType = "function"
    StdinProblem    ProblemType = "stdin"
)
```

Used everywhere a problem model needs to be referenced — the `Problem` struct, the `SubmissionMessage` envelope, the strategy registry key — instead of raw `"function"`/`"stdin"` string literals scattered through the codebase.

### 3.3 `ExecutionStrategy` — as implemented: single `Run`, not a 4-method split

**Status: implemented, deviates from the original design below.** The interface actually shipped (`judge-service-go/strategy.go`, root `main` package — not a new `pkg/central/strategy/` package as originally planned) is:

```go
type ExecutionStrategy interface {
    Run(
        ctx context.Context,
        exec *executor.Executor,
        pooledContainer *pool.PooledContainer,
        submissionMsg models.SubmissionMessage,
        problem models.Problem,
        adapter adapters.LanguageAdapter,
    ) (result *models.SubmissionResult, cleanupFailed bool, err error)
}
```

`FunctionExecutionStrategy.Run` is a pure delegation to the existing `runSubmissionCentralDetailed` — no behavior change, so the existing test suite is the correctness proof (see §3.6).

The original plan below (`Prepare`/`Execute`/`ParseResult`/`Compare` as four separate interface methods) was the intended target shape, but decomposing `central_runner.go`'s tightly-interleaved control flow (batching, streaming, per-test timeouts, TLE/MLE/RE classification) into those four seams *before* a second strategy exists to prove out where the real boundaries are would have been refactor risk on well-tested code for no behavioral payoff yet. The stage table and the `ParseResult`/`Compare` separation rationale below remain the conceptual model `StdinExecutionStrategy` was built against internally, even though they're not literal interface methods.

**Resolved, now that `StdinExecutionStrategy` (`stdin_runner.go`) exists:** it needed its own compile-once/run-per-test loop, error classification, and `TestResult` bookkeeping, hand-written to mirror `runSubmissionCentralPerTest`'s shape rather than sharing it through common `Prepare`/`Execute`/`ParseResult`/`Compare` seams. That's duplication (the two loops are structurally near-identical, differing mainly in what `Execute`/`ParseResult`/`Compare` mean per the stage table below), not a monolith — not worth blocking the MVP on. Conclusion: `Run` was sufficient. Extract the shared per-test-loop skeleton for real only if a third strategy shows up, or a bug needs fixing in both loops in lockstep more than once.

```go
type ExecutionStrategy interface {
    Prepare(problem *models.Problem, code string, workDir string) ([]string /* files */, error)
    Execute(ctx context.Context, containerID string, files []string, input TestInput) (stdout, stderr string, err error)
    ParseResult(stdout, stderr string) (actual interface{}, err error)
    Compare(actual, expected interface{}, config CompareConfig) (passed bool, details string)
}
```

`ParseResult` and `Compare` are kept separate (rather than one `Evaluate()`) because they fail differently: a parse failure means the harness/output contract broke (report as an error/crash, not a wrong answer); a compare failure means the program ran fine and produced the wrong result (a normal verdict).

**`Compare` stays thin.** It should not itself own whitespace normalization, float tolerance, or eventually custom-checker logic — that's real, growing complexity that belongs in its own component:

```text
ExecutionStrategy.ParseResult → Comparator.Compare → verdict
```

`Comparator` is a standalone component each strategy delegates to (function-mode already effectively has one: `pkg/comparator`, structural/type-aware). The stdin strategy gets its own — exact-text match in the MVP, normalization flags in Phase 2, pluggable custom-checker execution in Phase 4 — without `ExecutionStrategy` implementations absorbing that logic themselves. This keeps each strategy implementation from slowly growing into a monolith as comparison rules get more elaborate.

**Where the two current strategies actually diverge:**

| Stage | `FunctionExecutionStrategy` (existing behavior, formalized) | `StdinExecutionStrategy` (new) |
|---|---|---|
| Prepare | Generate wrapper from template, embed function name/types/test data, write wrapper + user code | Write user code as-is, no wrapper |
| Execute | `RunInContainer` — inputs passed as base64-encoded CLI arg | New `RunInContainerWithStdin` — inputs piped to process stdin |
| ParseResult | Parse JSON blob from **stderr** | Read raw text from **stdout** |
| Compare (via Comparator) | `pkg/comparator` — type-aware structural/deep compare | New text comparator — exact match (MVP) → normalization (Phase 2) → custom checker (Phase 4) |

### 3.4 Strategy Registry

**Status: implemented** (`judge-service-go/strategy.go`), as a package-level map + resolver function rather than a registry struct with a `Resolve` method:

```go
var StrategyRegistry = map[models.ProblemType]ExecutionStrategy{
    models.FunctionProblem: FunctionExecutionStrategy{},
}

func ResolveStrategy(problemType models.ProblemType) (ExecutionStrategy, bool) {
    // empty problemType defaults to FunctionProblem for pre-existing problems
}
```

`main.go` calls `ResolveStrategy(problem.EffectiveType())` in both `processSubmission` and the `/run` HTTP handler, before container acquisition — a problem type with no registered strategy is rejected early rather than silently falling through to the legacy path. Same dispatch role as originally planned (mirrors `AdapterRegistry`'s language dispatch), just a plain map instead of a wrapping struct.

### 3.5 `RunInContainerWithStdin` — additive, zero regression risk

`pkg/executor/executor.go::RunInContainer` currently has **no stdin parameter at all** (verified: zero occurrences of `Stdin` in that file — the function-wrapper model never needed it). Add a new sibling function using Docker's `ContainerExecAttach(..., AttachStdin: true)`, writing the test input to the returned connection. `RunInContainer` itself is never modified, so the function-mode path — covered by an extensive existing test suite (`central_runner_test.go`, `certification_suite_test.go`, `contamination_test.go`, per-language `*_integration_test.go`, stress/leak tests) — is provably unaffected.

### 3.6 Extracting the existing function-mode path

Formalizing `ExecutionStrategy` means the existing function-mode logic in `central_runner.go` gets **extracted** into a `FunctionExecutionStrategy` implementation — a behavior-preserving refactor, not a rewrite. Verify it against the existing test suite listed above before considering it done. The risk here isn't the new stdin code; it's inadvertently changing working, heavily-tested code during extraction.

### 3.7 The one real touch point on otherwise-untouched shared code

Both `assessment-api/src/services/submissions.service.js::validateSubmissionMessage` (Node) and `SubmissionMessage.FunctionName == ""` validation (Go, `pkg/models/submission_message.go:66`) currently treat `functionName` as unconditionally required. Both need it to become conditional on `problemType`. Small and precise, but it is a real edit to shared validation code on both sides of the queue — named explicitly here so it doesn't surprise anyone mid-implementation.

---

## 4. Node-side changes required

- `Problem` schema: add `problemType: "function" | "stdin"`; for stdin problems, `inputFormat`/`outputFormat` (present in Arventiq's schema, worth storing even if just descriptive), plus Phase 2's normalization flags (`normalizeWhitespace`, `normalizeNewlines`, `caseInsensitive`, `ignoreBlankLines`) and `floatTolerance` when that phase lands.
- Submission envelope (`messageBody` in `submissions.service.js`): add `problemType`; make `functionName` conditional on it (§3.7).
- Problem Sync API (still needed — this is what closes the "where do problems live" question from the original plan): upserts a `Problem` doc, now `problemType`-aware instead of assuming function-shape always.

---

## 5. Phased roadmap

Sequenced so the Arventiq integration ships on the MVP slice, not on full schema parity. Each phase is independently shippable and should be validated in production before the next starts.

**Phase 1 — STDIN MVP.** Compile → execute → pipe stdin → capture stdout → exact-text compare → time limit → memory limit → hidden/visible test cases. Includes: `RunInContainerWithStdin`, `StdinExecutionStrategy` + a minimal exact-match `Comparator`, `ProblemType` on both Node `Problem`/envelope and Go `SubmissionMessage`/`Problem`, conditional `functionName` validation on both sides, extraction of existing logic into `FunctionExecutionStrategy` (test-suite-verified). Explicitly out of scope: batching (one exec call per test case, same as today's per-test function mode), normalization, weighted scoring, custom checkers. Sufficient to run the sample "Two Sum" (stdin-style) problem end-to-end.

**Phase 2 — Enhanced comparison.** `normalize_whitespace`, `normalize_newlines`, `ignore_blank_lines`, `case_insensitive`, `float_tolerance`. Self-contained change to the stdin `Comparator` only.

**Phase 3 — Advanced judge features.** Weighted scoring, subtasks (`question_subtasks`, per-test `weight`/`points`), fractional score reporting. Touches `Submission`/`Problem` schema (no `weight` concept exists today) and the response mapper (Arventiq-style verdict payload with `passed_count`/`total_count`/fractional `score`/`cases[]`).

**Phase 4 — Special judge / custom checker.** `checker_language`/`checker_code` — a second sandboxed program validates the first program's output. A genuinely separate subsystem (its own sandboxing, its own execution+timeout handling); build only once Phases 1–3 are proven and a real problem needs it.

Guiding principle throughout: implement the subset required for the current integration, ship it, validate in production, then layer on advanced capabilities — not "implement everything Arventiq's schema could theoretically support."

---

## 6. Integration layer (Arventiq bridge)

- New `/api/arventiq/*` prefix — **not** the existing `/api/integration/*` (see `docs/INTEGRATION_GUIDE.md`), which was built for a different client with student-JWT-forwarding assumptions Arventiq doesn't need.
- Auth: shared secret only (`Authorization: Bearer <ARVENTIQ_SECRET>`), no per-candidate JWT. One shared service-account `User` for all Arventiq submissions (mirrors the existing `verifyService` pattern in `integration.mjs`); candidate/exam identifiers travel as opaque metadata (`externalStudentId`, `externalAssessmentId`) for traceability only, not auth.
- Problem Sync API: upserts a `problemType`-aware `Problem` doc, ahead of or alongside submission.
- Submission Translator (not "Payload Mapper" — it resolves problems, maps languages, sets `problemType`, handles limits precedence, not just reshapes JSON): stored `Problem` limits win over any request-supplied limits.
- Language-ID mapping table lives in config, not in controller code.
- Response Mapper: translates the internal `Submission`/`testResult` shape into whatever Arventiq expects; becomes `problemType`-aware once Phase 3 lands, since function-mode and stdin-mode results carry different fields.
- **Run, distinct from Submit**: Arventiq's "try it" UX (LeetCode-style Run vs. Submit) needs its own ephemeral path — no `Submission` doc, no RabbitMQ, no effect on score/history, a single execution against caller-supplied input rather than the synced test cases. This calls the Go judge's synchronous `/run` HTTP endpoint directly, the same ephemeral path `problems.service.js::runProblem` already uses for the platform's own practice-mode "Run" — not a new mechanism, just a second caller of an existing one. Fixed a latent bug in that existing function while touching it: it always sent `functionName` and never sent `problemType`, which would have broken for any `stdin`-type `Problem` (didn't exist before this integration).

### Final API surface

| Endpoint | Purpose |
|---|---|
| `POST /api/arventiq/problems` | Problem Sync — upsert by `externalId` |
| `POST /api/arventiq/run` | Run — ephemeral execution against custom input, no persistence |
| `POST /api/arventiq/submissions` | Submit — judged against the synced official test cases, produces a scored verdict |
| `GET /api/arventiq/submissions/:_id` | Poll a submission's verdict |

---

## 7. Unaffected components

Explicit, so the blast radius of this work is visible at a glance:

- ✅ RabbitMQ (queue, DLX/DLQ, retry semantics)
- ✅ Submission Service (`submissionsService.submitSolution` control flow)
- ✅ MongoDB `Submission`/`Problem` collections (extended with new fields, not restructured)
- ✅ Redis result cache
- ✅ Workspace Manager (`pkg/workspace`)
- ✅ Container Pool (`pkg/pool`) and its eviction/reconciliation logic
- ✅ `LanguageAdapter` interface and all existing adapters
- ✅ `RunInContainer` (existing function, signature untouched)
- ✅ Existing function-mode execution behavior (extracted into `FunctionExecutionStrategy`, not rewritten)
- ✅ `/api/integration/*` (existing generic integration layer — untouched, coexists with the new `/api/arventiq/*`)

---

## 8. Future direction (acknowledged, not scoped)

If more problem models or judging sophistication get added later, the natural next split is separating *how correctness is judged* from *how a verdict is produced*:

```text
LanguageAdapter → ExecutionStrategy → Comparator → VerdictGenerator
```

- **ExecutionStrategy** — "how do I run this problem?"
- **Comparator** — "how do I decide if the output is correct?"
- **VerdictGenerator** — "how do I turn raw pass/fail + timing/memory into AC/WA/TLE/MLE/Partial?"

Not needed for Phases 1–2. Worth keeping in mind once Phase 3 (weighted/partial scoring) makes "verdict" a genuinely separate computation from "did this one test pass."

---

## 9. Definition of Done (Phase 1)

- A request from Arventiq reaches `/api/arventiq/*`, authenticated via shared secret only.
- Problem is synced (or already synced) with `problemType: "stdin"` and stdin-shaped fields.
- Submission is created via the existing Submission Service, `problemType` carried through the envelope.
- RabbitMQ handles it exactly as today.
- Go Judge resolves `StdinExecutionStrategy` via the strategy registry, executes via `RunInContainerWithStdin`, compares via an exact-text `Comparator` (MVP).
- Function-mode submissions are provably unaffected — the existing certification/integration/stress test suite passes unchanged after the `FunctionExecutionStrategy` extraction.
- Result is mapped back to Arventiq's expected shape.
- No duplicate execution pipeline exists; everything in §7 is untouched.

## 10. Core philosophy

> The Submission → Queue → Judge → Results pipeline never changes. The Go Judge evolves to support multiple execution strategies — function-based and stdin-based, with room for more — as first-class capabilities of the platform. Arventiq is the first consumer of stdin support, not the reason it exists.
