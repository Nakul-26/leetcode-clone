# Arventiq Integration & Multi-Model Execution — Docs

**Start here:** [`PLAN.md`](./PLAN.md) — the current, living plan. Edit it in place as decisions change.

**Convention:** this folder holds exactly one live plan document (`PLAN.md`) plus a `history/` folder of numbered, dated-by-order snapshots of how we got here. When a decision changes, update `PLAN.md` directly — don't create `PLAN_V3.md` or a new loose file at the repo root. If a change is significant enough to want a preserved snapshot of the old state, copy the current `PLAN.md` into `history/` with the next number before editing it.

`history/` is read-only, in chronological order:

| File | What it captures |
|---|---|
| [`01-original-plan-raw.md`](./history/01-original-plan-raw.md) | First rough plan — assumed a GO Judge-mimicry adapter |
| [`02-coding-platform-draft-notes.md`](./history/02-coding-platform-draft-notes.md) | Reframed as "coding platform = execution engine"; doc-split proposed |
| [`03-plan-review-discussion.md`](./history/03-plan-review-discussion.md) | Codebase-grounded gap review; surfaced the problem-model question |
| [`04-arventiq-real-schema-and-payload.md`](./history/04-arventiq-real-schema-and-payload.md) | Real Arventiq schema + sample payload — confirmed stdin/stdout, not function-signature |
| [`05-initial-gap-analysis-report.md`](./history/05-initial-gap-analysis-report.md) | First codebase gap analysis (existing `/api/integration/*`, submission pipeline, Go judge) |
| [`06-plan-v1-grounded-in-codebase.md`](./history/06-plan-v1-grounded-in-codebase.md) | V1 — corrected against the actual codebase, open decisions enumerated |
| [`07-plan-v2-execution-strategy.md`](./history/07-plan-v2-execution-strategy.md) | V2 — introduced `ExecutionStrategy`/`LanguageAdapter` split, `RunInContainerWithStdin`, phased roadmap |
| [`08-plan-v3-strategy-single-run.md`](./history/08-plan-v3-strategy-single-run.md) | V3 snapshot (pre-edit) — captured before reconciling §3.3/§3.4 with what Milestone 2 actually shipped (single `Run` method, package-level map registry) |

Related standing docs elsewhere in the repo (not part of this history, kept where they are because they're broader than this integration):
- [`judge-service-go/ANALYSIS.md`](../../judge-service-go/ANALYSIS.md) — Go judge deep-dive
- [`docs/INTEGRATION_GUIDE.md`](../INTEGRATION_GUIDE.md) — the existing, separate `/api/integration/*` layer
