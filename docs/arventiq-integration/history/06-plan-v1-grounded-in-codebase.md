# Coding Platform Integration Plan (Document 1)

**Audience:** Coding Platform Developer (You)
**Status:** revised — corrections marked with 🔧, open decisions marked with ❗
**Source:** rewritten from `/workspaces/assessment_microservice_2/what to do`, checked against the actual codebase

This document contains only the changes required in the Coding Platform. It should not need to explain Arventiq's implementation details except where necessary to define an API contract (that belongs in Document 3, the shared contract, once these decisions are made).

---

## ❗ Decisions needed before Phase 2 design work starts

The original draft is architecturally sound but has two internal contradictions that block real design work. Resolve these first — everything else in the plan depends on the answers.

### ❗ Decision 1 — Are problems pre-registered, or sent inline per submission?

Your plan says both "Question Management stays with Arventiq" and "reuse the existing Submission Service without modification." Those can't both be true as-is:

`submissionsService.submitSolution` requires a `problemId` that resolves to a **stored Mongo `Problem` document** (`functionName`, typed `parameters[]`, `returnType`, `testCases[]`). Your Go judge wrapper-generates code around a **named function call** — it is not a stdin/stdout runner like classic Judge0. There is no way to "just reshape the payload" around this; it's a structural fact about how your execution engine works.

Two real options:

- **(A) Problem sync.** Arventiq pushes/syncs problem definitions (function name, parameter types, return type, test cases) into your `Problem` collection via a small admin-style API, ahead of time. Submissions then reference `problemId` and this plan's "reuse Submission Service unmodified" claim holds exactly as written. Arventiq still *authors* questions in their own UI — they just also call one more API to mirror the definition into your system. This is the cleaner long-term shape and keeps "one execution pipeline" true.
- **(B) Fully ephemeral.** Arventiq sends the complete problem (function signature + test cases) inline with every submission, and the adapter creates/reuses an ephemeral `Problem` doc on the fly (or calls the Go judge's `/run` HTTP endpoint directly, which already supports inline tests with no persistence). This avoids a sync API but means either (a) a lightweight upsert step in front of the existing submission flow, still one pipeline, or (b) genuinely a second, simpler pipeline (`/run` direct), which conflicts with "never build another execution pipeline."

**Recommendation:** (A), with test cases allowed inline as a convenience for problems not yet synced (falls back to an upsert). This keeps a single pipeline and single source of truth for `Problem` docs, and it's a small, well-scoped addition (`POST /api/arventiq/problems` — upsert), not new business logic.

This also needs an answer to a narrower technical question, which should go in Document 3 once known: **does Arventiq's problem model already use typed function signatures (LeetCode-style), or is it stdin/stdout-based?** If it's stdin/stdout, this is a bigger compatibility gap than a payload mapper can solve — flag that possibility now rather than discovering it mid-implementation.

### ❗ Decision 2 — Identity: one shared service user, or per-candidate shadow users?

`Submission.userId` is a required reference to a real `User` document, and result access is ownership-checked (`canAccessSubmission`). If Arventiq owns "Students and Candidates," the Coding Platform has no real user record for each candidate.

**Recommendation:** one shared service-account `User` (e.g. `arventiq-service@internal`) attributed to all Arventiq-originated submissions, with the adapter's auth middleware setting `req.user = { _id: <service user id>, role: "admin", isService: true }` — mirroring the pattern already implemented in `assessment-api/src/middleware/integration.mjs::verifyService`. No per-candidate identity needs to exist in this system; Arventiq's own candidate ID can travel through as an opaque field on the submission (e.g. `externalStudentId`) for traceability/logging only, not for auth.

### 🔧 Correction — an integration layer already exists

`assessment-api/src/routes/integration.routes.js` + `docs/guides/INTEGRATION_GUIDE.md` already implement a generic "Testing Platform" bridge with a working service-key middleware pattern. It requires a forwarded student JWT on most routes (built for a different, tighter-coupled client than Arventiq will be). Don't build blind next to it — pick one:
- Mount Arventiq's routes at a distinct prefix (`/api/arventiq`) with its own auth middleware (simpler: shared secret only, no student JWT — see Decision 2), reusing the *pattern* from `integration.mjs` but not its student-JWT requirement, **or**
- Generalize `integration.mjs` so `verifyService` alone (no student JWT) is sufficient for machine-to-machine callers, and Arventiq becomes a second consumer of the same routes.
Recommendation: new prefix, new middleware, for now — the two client shapes are different enough (JWT-forwarding vs. none) that forcing them into one code path will produce awkward conditionals. Reassess in Phase 8-equivalent cleanup.

### 🔧 Correction — confirm async-only (good — already decided correctly)

The plan's "Do NOT bypass RabbitMQ, even if synchronous execution is supported" is correct and should stand as written. This settles a question that would otherwise be open: submissions are always async, polled by result endpoint — matching Judge0-style token/poll semantics, so Arventiq's side isn't surprised by the shape even though we're not literally emulating Judge0. Keep this.

### 🔧 Addition — language-ID and limits mapping (missing from original draft)

Two small but required pieces of "Payload Mapper" that the original draft didn't call out explicitly:
- **Language mapping table**: whatever identifier Arventiq sends → your judge's internal string IDs (`python`, `javascript`, `typescript`, `java`, `go`, `c`, `cpp`, `csharp` — see `judge-service-go/ANALYSIS.md` §7). Needs to live in the new `config` layer described below, not hardcoded in the mapper.
- **Limits precedence**: your `Problem` schema stores `timeLimitMs`/`memoryLimitMb` per-problem. If Arventiq also sends limits per-request, decide precedence explicitly (recommend: stored `Problem` values win, since the judge sandbox is configured per-problem today — don't let a request silently override sandboxing behavior your team controls).

---

## Everything below is the original plan, kept largely as-is (it was correct) — read alongside the decisions above.

## Objective

Transform the existing Coding Platform into an execution service capable of receiving execution requests from the Arventiq Labs Assessment Platform while reusing the existing architecture.

The Coding Platform should expose a clean integration interface without changing its execution engine or core submission workflow.

---

## Current Architecture

```text
Client → React Frontend → Node Backend → RabbitMQ → Go Judge → MongoDB
```

The platform already supports: Submission Service, RabbitMQ, Go Judge, Result Storage, Language Support, and an existing (generic) Integration API layer (see correction above). These components should remain unchanged wherever possible.

## Primary Goal

The Node Backend should become the **Integration Layer** between external assessment platforms and the existing execution pipeline. The execution pipeline should remain exactly as it is today.

## Responsibilities

- **Receiving requests** — execution requests from external systems.
- **Validating requests** — required fields, language, limits, authentication.
- **Mapping requests** — convert external requests into the internal submission model (see Decision 1 for what this actually entails).
- **Creating submissions** — reuse the existing Submission Service. Never create another execution pipeline.
- **Queue management** — reuse RabbitMQ.
- **Execution** — reuse Go Judge.
- **Result formatting** — return results in the expected format.

## Things That MUST NOT Change

**Do NOT modify Go Judge.** It should never know about Arventiq, client names, assessment IDs, or external payloads. It executes code only.

**Do NOT duplicate submission logic.** Keep `Submission → Submission Service → RabbitMQ → Judge`. Never build a second `Integration → Another Submission Service → Judge` path. (This is exactly why Decision 1 matters — option (B)'s naive form would violate this.)

**Do NOT bypass RabbitMQ**, even though synchronous execution is technically available via the judge's `/run` endpoint. All production submissions go through the existing queue.

**Do NOT create another execution engine.** Reuse the Go Judge as-is.

## Business Responsibility During This Integration

**For the scope of the Arventiq integration project, the Coding Platform acts only as the execution engine.**

During this phase, the Coding Platform is responsible for: receiving execution requests, validating requests, processing submissions, managing the execution queue, compiling/executing code, evaluating test cases, and returning execution results — plus, per Decision 1, holding synced problem definitions so the judge's function-call model works.

The following continue to be handled by Arventiq for this integration: Colleges and Institutions, Assessments, Students and Candidates, Reports and Analytics, Exam Scheduling, Question *authoring* (though definitions are mirrored into the Coding Platform per Decision 1), Authentication and User Management.

This separation is only for the current integration project and is intended to minimize development effort while keeping a clean boundary between the two systems.

## Future Direction

The Coding Platform is already evolving toward a complete coding assessment platform (Assessment Management, Student Management, Problem Management, Reports & Analytics, Candidate Portal, Administrator Dashboard). That work is paused, not abandoned, while this integration is prioritized. Once stable, it resumes.

---

## Architecture

```text
External Client (Arventiq)
       ↓
Integration API              ← NEW: /api/arventiq/*
       ↓
Authentication                ← NEW: shared-secret middleware (Decision 2)
       ↓
Validation
       ↓
Payload Mapper                ← NEW: incl. language table, limits precedence
       ↓
Submission Service            ← EXISTING, unmodified
       ↓
RabbitMQ                      ← EXISTING
       ↓
Go Judge                      ← EXISTING, unmodified
       ↓
Execution Result
       ↓
Response Mapper               ← NEW
       ↓
Client
```

Everything above the Submission Service is new. Everything below already exists and stays untouched.

## Components To Build

**1. Integration API** — new routes under `/api/arventiq/*` (or the extended `integration.routes.js`, per the naming correction above): receive requests, authenticate, validate.

**2. Authentication Layer** — shared secret / API key only (`Authorization: Bearer <ARVENTIQ_SECRET>`), no per-candidate JWT forwarding, per Decision 2.

**3. Payload Mapper** — converts external payloads into the internal submission format, including the problem-sync/upsert step from Decision 1 and the language-ID/limits handling from the addition above. Isolates the rest of the system from external request structures.

**4. Response Mapper** — converts internal execution results (`Submission` doc + `testResult.details[]`) into whatever response shape Document 2/3 defines for Arventiq.

**5. Configuration** — API keys, execution limits, language mappings, feature flags, centralized (extend `assessment-api/src/config/env.js`), not hardcoded in route handlers.

## Request Lifecycle

```text
External Request → Authenticate → Validate → Map Request →
(Decision 1: resolve/sync Problem) → Create Submission → RabbitMQ →
Go Judge → Store Result → Fetch Result → Map Response → Return Response
```

## Development Roadmap

**Phase 1 — Study Existing Code.** Largely done already: see `judge-service-go/ANALYSIS.md` (Go judge deep-dive) and `ARVENTIQ_INTEGRATION_REPORT.md` (Node-side submission flow + existing integration layer gap analysis). Remaining: get real answers to Decisions 1 and 2 above — that's the actual blocking deliverable, not more code reading.

**Phase 2 — Design Integration Layer.** Integration endpoints, authentication, payload mapping, response mapping — informed by Decisions 1 & 2. Deliverable: approved integration architecture (this becomes Document 3, the shared contract, once Arventiq's side is known).

**Phase 3 — Build Integration APIs.** Authentication, validation, request mapping, response mapping. Deliverable: external systems can communicate with the Coding Platform.

**Phase 4 — Connect Existing Pipeline.** Reuse Submission Service, RabbitMQ, Go Judge. No duplication. Deliverable: end-to-end execution.

**Phase 5 — Testing.** Every supported language, invalid requests, queue failures, judge failures, timeouts, authentication failures, plus (added) problem-sync edge cases from Decision 1 (missing problem, stale definition, malformed test cases) and identity edge cases from Decision 2 (result access with the shared service user). Deliverable: reliable, production-ready integration.

## Definition of Done

- A request from Arventiq reaches the Integration API.
- The request is authenticated and validated.
- The request is mapped to the internal submission model (with a resolved `Problem` doc per Decision 1).
- The existing Submission Service processes it without modification.
- RabbitMQ handles execution.
- The Go Judge executes the code without any knowledge of Arventiq.
- Results are mapped back into the expected response format.
- No duplicate execution pipeline exists.
- No Arventiq-specific logic is present in the Go Judge.

## Core Philosophy

> Extend the Node Backend, preserve the execution pipeline, and keep the Go Judge completely client-agnostic.

Unchanged from the original — it's the right north star. The corrections above exist to make sure the plan under it is actually buildable against this codebase as it stands today.
