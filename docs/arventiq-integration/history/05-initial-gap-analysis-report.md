# Arventiq Integration — Gap Analysis & Revised Plan

Status: **analysis only, no code changed**
Scope: compare `/workspaces/assessment_microservice_2/plan` against the current state of this repo (assessment-api + judge-service-go) and produce an actionable, corrected plan.

---

## 1. TL;DR

You already built **half of this plan**, under a different name, for a *different* (generic) client than Arventiq:

| Plan phase | Status | Evidence |
|---|---|---|
| Phase 1 — Analyze existing APIs | ✅ Done (informally) | `judge-service-go/ANALYSIS.md` documents the Go judge in detail; this report adds the Node side |
| Phase 2 — Adapter layer (`judgeAdapter`) | ❌ Not started | No `adapters/`, no `arventiqController`, no `judgeAdapter.ts` anywhere in the repo |
| Phase 3 — Accept Arventiq's payload shape | ❌ Not started | Integration route requires **your own** payload shape (`problemId/code/language/assessmentId/attemptId`), not a Judge0-style shape |
| Phase 4 — Reuse existing submission flow | ✅ Already true | `/api/integration/submissions` calls the exact same `submissionsService.submitSolution` → RabbitMQ → Go judge → Mongo pipeline as the native frontend |
| Phase 5 — Translate response back to Arventiq's expected shape | ❌ Not started | Integration routes return your native `Submission` document shape, not Judge0-style (`status.id`, `stdout`, `stderr`, `time`, `memory`, `token`, …) |
| Phase 6 — Simple API key auth | ⚠️ Partially done, but stricter | Real implementation requires **two** credentials (`x-service-key` **and** a forwarded student JWT), not a single bearer secret |
| Phase 7 — Backward compatible, dual API surface | ✅ Already true | `/api/integration/*` is additive; nothing in the native `/api/v1/*` surface was touched |
| Phase 8 — Future refactor | N/A (deferred by design, correctly) | — |

**The core issue:** what exists today (`/api/integration/*`, documented in `docs/guides/INTEGRATION_GUIDE.md`) is a **generic "Testing Platform" passthrough**, built to your own team's data model, requiring a per-student JWT the caller must already hold. It is not a **Judge0-compatible facade**. Arventiq, per your plan, expects to talk to something that *looks like Judge0* — different endpoint shapes, different field names, different auth model, and (implicitly) no requirement that Arventiq mint or forward your JWTs.

These are two different integration contracts. Below is why that distinction matters and a concrete plan to close the gap without breaking what's already there.

---

## 2. What currently exists (Phase 1, Node side)

### 2.1 `/api/integration/*` — existing "Testing Platform" bridge
File: `assessment-api/src/routes/integration.routes.js`, guarded by `assessment-api/src/middleware/integration.mjs`, documented in `docs/guides/INTEGRATION_GUIDE.md`.

| Route | Auth | Delegates to |
|---|---|---|
| `POST /api/integration/assessments` | `x-service-key` only | `assessments.controller.createAssessment` |
| `GET /api/integration/assessments/:_id` | `x-service-key` + student JWT | `assessments.controller.getAssessmentById` |
| `POST /api/integration/assessments/:_id/start` | `x-service-key` + student JWT | `assessments.controller.startAssessment` |
| `POST /api/integration/submissions` | `x-service-key` + student JWT | `submissions.controller.submitSolution` |
| `GET /api/integration/submissions/:_id` | `x-service-key` + student JWT | `submissions.controller.getSubmissionById` |
| `GET /api/integration/results/:_id` | `x-service-key` only | `assessments.controller.listAssessmentAttempts` |

Key facts:
- **No translation happens.** These routes call your native controllers directly with your native request/response shapes. This *is* "Phase 4: reuse the existing submission flow" — correctly done — but it is not an adapter in the Phase 2/3/5 sense; there's no payload conversion at all.
- **Auth requires a student identity, not just a service secret.** `verifyIntegrationStudent` calls the same `verifyToken` used for your own frontend, meaning the *caller* (Testing Platform) must already possess a valid JWT signed with your `JWT_SECRET` for the specific student. That means the two systems must share `JWT_SECRET`, or the caller must call your `/api/v1/auth` login flow first to obtain one. This is a materially different trust model than the plan's Phase 6 ("Add a simple API key... Validate it in middleware. Done.").
- `POST /api/integration/submissions` body is `{ problemId, code, language, assessmentId, attemptId }` — your internal shape, requiring the caller to already know your Mongo ObjectIds for problem/assessment/attempt. Judge0 (and presumably Arventiq) has no concept of `assessmentId`/`attemptId` — it sends `source_code`, `language_id`, `stdin`, and expects a submission token back.
- Response for `GET /api/integration/submissions/:_id` is your native `Submission` document (`status: Pending|Running|Success|Fail|Error`, `testResult.details[]`, `score`, `output` as a JSON string) — not Judge0's `{ status: {id, description}, stdout, stderr, compile_output, time, memory, token }`.

### 2.2 Native submission pipeline (Phase 1 continued, reused by everything)
`assessment-api/src/services/submissions.service.js::submitSolution`:
1. Validates the submission is allowed (assessment lock state, attempt ownership, timing, allowed languages) — **this validation is assessment-specific and has no Judge0/Arventiq equivalent**; it needs to be bypassed or made optional for adapter-originated submissions that aren't tied to an assessment attempt.
2. Creates a `Submission` doc (`status: "Pending"`).
3. Builds a judge message: `{ schemaVersion: "v2", submissionId, problemId, language, code, tests, functionName, compareMode, requestId }`.
4. `publishSubmissionMessage(messageBody)` → RabbitMQ → consumed by the Go judge.
5. Returns the created (pending) `Submission` doc immediately — **submission is async**; the caller must poll `GET .../submissions/:id` (or the integration equivalent) for the result, same as Judge0's token/poll model. This maps cleanly onto Judge0 semantics (good news for Phase 3/5 design).

### 2.3 Go judge (`judge-service-go`) — already documented
See `judge-service-go/ANALYSIS.md` (already in your working tree, untracked) for the full breakdown. Relevant surface for the adapter:
- Consumes `SubmissionMessage{ submissionId, problemId, language, code, functionName, tests }` off `submission_queue`.
- Also exposes a **synchronous** `POST /run` HTTP endpoint (port 8080/8081 health) that accepts an ephemeral problem body (tests inline, no Mongo persistence) — this is a second possible integration point if Arventiq needs synchronous single-shot execution without your assessment/problem model at all.
- Writes results back into the `Submission` Mongo doc and a Redis cache (`submission:<id>`, 1h TTL) — the Node side already has a read path for this (`submissions.service.getSubmissionById`), so an adapter's "poll for result" endpoint can reuse it as-is.

### 2.4 Config / auth primitives already available
`assessment-api/src/config/env.js` — `TESTING_PLATFORM_KEY` (used by `verifyService`). This is the closest existing thing to the plan's `ARVENTIQ_SECRET`, but it's currently entangled with the JWT-forwarding requirement described above.

---

## 3. Where the plan and the codebase disagree

1. **"Pretend to be Judge0" vs. what exists.** The plan's whole premise is a Judge0-shaped facade. Nothing in the repo currently emulates Judge0's request/response contract (`POST /submissions` with `source_code`/`language_id`/`stdin`/`expected_output`, `GET /submissions/:token`, numeric `language_id` mapping, `status.id` enum, base64 field encoding option, etc.). This needs to be built from scratch — Phase 2/3/5 are real, non-trivial work, not "translate a couple of field names."
2. **Auth model mismatch.** Your plan's Phase 6 assumes Arventiq will hold one static secret and nothing else. The existing `/api/integration` auth requires a **student JWT** on most routes because your submission flow is fundamentally tied to `userId`/`assessmentId`/`attemptId` ownership checks (see `validateAssessmentSubmission`). If Arventiq is not going to authenticate individual students against your system (likely, if it's mimicking Judge0's stateless model), the adapter needs a decision: either (a) map every Arventiq-originated submission to a single service account user, or (b) require Arventiq to pass a student identifier you can resolve to a `userId` some other way. This is a design decision the plan doesn't address and you should make explicitly before writing code.
3. **Assessment coupling.** Your submission service assumes submissions are either informal/practice (no assessment) or tied to a real `assessmentId`+`attemptId` with timing/lock/ownership rules. Judge0-style calls from Arventiq will almost certainly *not* supply these — so the adapter must call the "no assessment" code path (`assessmentId`/`attemptId` both `null`), which `submitSolution` already supports (the check is skipped when both are falsy). Good: no service-layer change needed for this, just make sure the adapter never sends a partial pair.
4. **Naming/collision risk.** You already have an integration surface called `/api/integration`. Introducing a second one for Arventiq should live at a distinctly named path (e.g. `/api/judge0` or `/api/arventiq`) to avoid confusing the two consumers or accidentally overloading the existing `integration.routes.js`/`integration.mjs` files, which are documented and presumably already in use by whatever "Testing Platform" client exists today.
5. **Language ID mapping is undocumented in the plan but required in practice.** Judge0 identifies languages by numeric `language_id` (e.g. 71 = Python 3, 62 = Java, 54 = C++17). Your judge identifies languages by string id (`python`, `java`, `cpp`, …). The adapter needs an explicit mapping table — this is missing from the plan entirely and should be added to Phase 3.

---

## 4. Revised Plan

Keep the plan's phase structure — it's sound — but make it concrete and correct against this codebase.

### Phase 1 — Analysis (✅ done, use as reference)
- Go judge: `judge-service-go/ANALYSIS.md`
- Node submission flow: §2 of this report
- Open item: get the **actual** Judge0 request/response contract Arventiq currently sends (headers, body, expected fields) — this repo has no record of it. You cannot build a faithful facade without capturing real traffic or the Judge0 OpenAPI spec Arventiq targets.

### Phase 2 — Adapter layer
Create, without touching existing files:
```
assessment-api/src/adapters/judge0Adapter.js      # pure translation functions, no I/O
assessment-api/src/controllers/judge0.controller.js  # thin HTTP layer calling adapter + existing services
assessment-api/src/routes/judge0.routes.js
```
Mount at a new prefix, e.g. `app.use("/api/judge0", judge0Routes)` in `src/app.js` — additive only, matches Phase 7.

### Phase 3 — Payload translation
- `POST /api/judge0/submissions` (Judge0's `POST /submissions`) accepts `{ source_code, language_id, stdin?, expected_output?, cpu_time_limit?, memory_limit? }`.
- Adapter maps `language_id` → your internal language string via an explicit table (build from `judge-service-go/ANALYSIS.md` §7's supported languages: python, javascript, typescript, java, go, c, cpp, csharp).
- Two integration modes to decide between (recommend asking the user — see open questions below):
  - **Ephemeral mode**: call the Go judge's `POST /run` directly (bypasses Mongo problem/assessment model entirely) when Arventiq sends `stdin`/`expected_output` per-call like Judge0 does, with no pre-registered "problem". This avoids needing a `problemId` at all.
  - **Problem-bound mode**: if Arventiq submissions always correspond to a `problemId` you already store, go through `submissionsService.submitSolution` as today, with `assessmentId`/`attemptId` left `null`.
- The Judge0 API supports batch submissions too (`POST /submissions/batch`) — confirm whether Arventiq actually uses this before building it; don't build unused surface.

### Phase 4 — Reuse existing submission flow
Already correct in principle (§2.2). For adapter calls, prefer routing through `submissionsService.submitSolution`/Go judge `/run` exactly as the existing `/api/integration/submissions` does — do not create a parallel queue-publish path.

### Phase 5 — Response translation
Map your `Submission` doc / judge result to Judge0's shape:
```
{ status: { id, description }, stdout, stderr, compile_output, time, memory, token }
```
`status.id` needs a mapping table from your `status` enum (`Pending|Running|Success|Fail|Error`) plus per-test pass/fail info in `testResult.details[]` to Judge0's status codes (3=Accepted, 4=Wrong Answer, 5=TLE, 6=Compilation Error, etc.). This is genuinely new logic — nothing in the current codebase does this mapping today.

### Phase 6 — Authentication
Add `ARVENTIQ_SECRET` to `env.js` alongside (not replacing) `TESTING_PLATFORM_KEY`. Build a dedicated `verifyArventiq` middleware that checks a single `Authorization: Bearer <ARVENTIQ_SECRET>` header — **do not** reuse `verifyIntegrationStudent`, since (per §3.2) Arventiq likely has no student JWT to forward. Decide the user-identity question (§3.2) before implementing — it determines whether this middleware also needs to resolve/attach a `req.user`.

### Phase 7 — Backward compatibility
Already satisfied by construction if Phase 2's routes are additive and mounted on a new prefix. No action needed beyond not touching `integration.routes.js`, `submissions.controller.js`, `submissions.service.js`, or judge-service-go.

### Phase 8 — Future refactor
Unchanged from the plan — correctly deferred.

---

## 5. Open questions to resolve before writing code

1. **Do you have a capture of Arventiq's actual Judge0 requests/responses** (URL, headers, body, expected response), or should the adapter be built purely against the public Judge0 API spec? The plan's own closing recommendation says to reverse-engineer this first — it hasn't been done yet in this repo.
2. **User identity**: should every Arventiq submission be attributed to one shared service-account `userId`, or does Arventiq supply a student identifier you need to resolve?
3. **Ephemeral vs. problem-bound**: does Arventiq send full source+test-cases per call (→ use Go judge's `/run` directly, no Mongo `Problem` needed), or does it reference problems you already store (→ reuse `submitSolution`)?
4. **Sync vs. async**: Judge0 supports both `?wait=true` (synchronous) and async+poll. Your pipeline is async-only (RabbitMQ). If Arventiq needs synchronous responses, the adapter will need to poll internally (with a timeout) before responding, or you point it at the Go judge's synchronous `/run` endpoint instead of the queue.

---

## 6. Files referenced in this analysis

- `plan` (root) — original plan document
- `judge-service-go/ANALYSIS.md` — existing Go judge deep-dive (already in your working tree, untracked)
- `docs/guides/INTEGRATION_GUIDE.md` — existing "Testing Platform" integration docs
- `assessment-api/src/routes/integration.routes.js`, `src/middleware/integration.mjs`
- `assessment-api/src/services/submissions.service.js`, `src/services/judge.service.js`
- `assessment-api/src/config/env.js`
- `assessment-api/models/Submission.mjs`
