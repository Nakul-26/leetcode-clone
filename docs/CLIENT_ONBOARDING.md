# Client Onboarding

How to bring on a new client, whichever part of the platform they want.

**Audience:** the platform operator (you). Client-facing material is linked where it exists:
[`GO_JUDGE_API.md`](./GO_JUDGE_API.md) for developers using the judge, and the
[Faculty](./FACULTY_GUIDE.md), [Admin](./ADMIN_GUIDE.md) and [Student](./STUDENT_GUIDE.md) guides for
people using the full platform.

- [1. Which product does the client want?](#1-which-product-does-the-client-want)
- [2. Judge only (GO Judge)](#2-judge-only-go-judge)
- [3. The full platform](#3-the-full-platform)
- [4. Hybrid: their exam portal, our platform behind it](#4-hybrid-their-exam-portal-our-platform-behind-it)
- [5. Choosing limits](#5-choosing-limits)
- [6. Data, security and tenancy](#6-data-security-and-tenancy)
- [7. Day-to-day: usage, changes, offboarding](#7-day-to-day-usage-changes-offboarding)
- [8. Decisions that are yours to make](#8-decisions-that-are-yours-to-make)

---

## 1. Which product does the client want?

Ask one question: **who do the students log in to?**

| If the client says... | They want | Section |
|---|---|---|
| "We have our own exam / coding platform. We just need somewhere to run students' code." | **GO Judge only** | [2](#2-judge-only-go-judge) |
| "We want an assessment platform for our college: accounts, exams, results, placement drives." | **Full platform** | [3](#3-the-full-platform) |
| "We have our own student-facing portal but want to use your problems, attempts and scoring behind it." | **Hybrid** | [4](#4-hybrid-their-exam-portal-our-platform-behind-it) |
| "We'll start with the judge and maybe move more over later." | **Judge only now**, upgrade later | 2, then 3 |

### What each one means

| | GO Judge only | Full platform | Hybrid |
|---|---|---|---|
| Student accounts and login | Client's | Ours | Client's, forwarded to us |
| Exam / assessment UI | Client's | Ours | Client's |
| Problem bank, test cases, scoring | Client's | Ours | Ours |
| Code execution | Ours | Ours | Ours |
| Who compares output to the expected answer | **Client** | Us | Us |
| Integration effort for the client | Low: one HTTP API | None: log in and use it | **High**: shared JWT secret and service key |
| What we store about them | Results for 24 h, usage counts | Everything an assessment platform stores | Same as full platform |
| Billing unit | Test cases run | Plan per college | Plan per college |

Judge only is by far the easiest to onboard and to support. Steer clients that way unless they really
want assessments run for them.

---

## 2. Judge only (GO Judge)

### What the client gets

A key, a base URL, and [`GO_JUDGE_API.md`](./GO_JUDGE_API.md). Nothing else. They send code and input and
receive output; they compare it with the expected answer themselves.

### Operator checklist

1. **Create the client's tenant.** Every key, usage record and quota is attributed to a *college*, so even
   a judge-only client needs one. Either:
   - have them self-register at `POST /api/auth/signup` with `{ collegeName, name, email, password }`,
     which creates the college and its first admin, **or**
   - create it yourself (superadmin) and make an admin account for it.

2. **Issue the key.** As that college's admin (or as superadmin, who must also pass `collegeId`):

   ```bash
   curl -s -X POST https://<host>/api/admin/api-clients \
     -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
     -d '{ "name": "Acme exam portal", "scopes": ["codeassess"],
           "rateLimitPerMin": 120, "monthlyQuota": 100000 }'
   ```

   The response contains the key **once**. It cannot be retrieved afterwards. Only a hash is stored.
   `scopes: ["codeassess"]` is what lets the key call the GO Judge API and nothing else.

3. **Choose the limits** ([section 5](#5-choosing-limits)). `0` means unlimited. Leaving both at `0`
   for a paying client is a decision, not a default: do it knowingly.

4. **Hand over, securely.** Send the key through a password manager or an encrypted channel, never plain
   email or chat. Give them the base URL, [`GO_JUDGE_API.md`](./GO_JUDGE_API.md) and these three
   instructions: *call from your server only; handle `429` by waiting `Retry-After`; never treat status
   3 as "correct".*

5. **Verify before they go live.** Ask them to run the quick start in the API reference. Then, from
   a machine you control, run the contract harness against their key with a small filter:

   ```bash
   node scripts/judge_contract_check.mjs --target shim --base https://<host> --key <their key> \
        --filter accepted --allow-remote
   ```

6. **Watch the first week** ([section 7](#7-day-to-day-usage-changes-offboarding)): their usage, any
   `429`s, and the queue depth.

### Common questions

- *Can they test without being billed?* Usage is counted per test case regardless. Issue a separate key
  named "<client> - test" with a small `monthlyQuota` so test traffic cannot eat the real allowance.
- *Can they rotate a key?* Yes, with no downtime: issue a second key, let them switch, then revoke the first.
- *Is it a wrapper around someone else's judge?* No. GO Judge is built in-house, from the sandbox pool to
  the queue. Its API deliberately follows a familiar shape so existing client code is easy to adapt.

---

## 3. The full platform

### What the client gets

A tenant (college) on our platform: their own admins, faculty and students; a problem bank; assessments
with timed attempts, proctoring events, announcements and analytics; placement drives and interview
slots; results export. See the [Faculty](./FACULTY_GUIDE.md), [Admin](./ADMIN_GUIDE.md) and
[Student](./STUDENT_GUIDE.md) guides.

### Roles

| Role | Can do |
|---|---|
| `student` | Take assessments, run and submit code, see own results |
| `faculty` | Create problems and assessments, manage students, rejudge, post announcements, manage drives and interviews |
| `admin` | Everything faculty can, plus delete content, view system stats and issue API keys, for **their own college only** |
| `superadmin` | Platform-wide: all colleges, plans, queue stats, backup and restore |

Every role below superadmin is confined to one college. Another college's data is invisible: a request for
it gets `404`, not `403`, so even the existence of an id is not revealed.

### Operator checklist

1. **Create the college.** Self-signup (`POST /api/auth/signup`) creates the college and its first admin.
2. **Set their plan.** As superadmin: `PATCH /api/billing/colleges/<collegeId>/plan`. Billing in practice
   may be cash or bank transfer rather than card checkout; the plan field is what the platform enforces.
3. **Let their admin do the rest**, following the Admin Guide:
   create faculty accounts, then students in bulk (CSV/Excel via bulk import), then problems and
   assessments.
4. **Tune the exam-day quotas.** The defaults are deliberately modest:

   | Setting | Default | Meaning |
   |---|---|---|
   | `COLLEGE_SUBMISSION_QUOTA` | 30 per 60 s | Whole-college submission rate |
   | `STUDENT_SUBMISSION_QUOTA` | 10 per 60 s | Per-student submission rate |

   **A college of several hundred students submitting in the same minute will hit the college limit.**
   Raise it, for the whole deployment, only after checking judge capacity
   ([`OPERATIONS_RUNBOOK.md`](./OPERATIONS_RUNBOOK.md#capacity-and-tuning)).
5. **Rehearse.** Run a short mock exam with real devices before the first real one, and do the restore
   test described in the Admin Guide.
6. **Do not deploy during their exam window.** A push to `main` restarts the stack.

### Judge capacity is shared

Every tenant shares one judge. The judge is limited by CPU, not memory, and throughput stops improving
beyond a handful of concurrent compile-heavy runs. Two colleges taking exams at the same hour compete
for the same cores. When you sell to a second college, schedule or size accordingly.

---

## 4. Hybrid: their exam portal, our platform behind it

The client keeps their own student-facing portal and calls our API for problems, attempts and scoring.

Two surfaces exist. Pick by what the client sends:

| Surface | Auth | Shape | Use when |
|---|---|---|---|
| `/api/integration/*` | `x-service-key` **plus** the student's JWT, forwarded | Create assessments, start attempts, submit solutions, fetch results. Reference: [`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md) | The client wants us to run assessments |
| `/api/arventiq/*` | `Authorization: Bearer <secret>`, where the secret is the legacy shared secret or an `arventiq`-scoped API key | Sync a problem, run code, submit, fetch a result. Built for one partner's stdin/stdout problem model | Only for that partner's integration. A new client should use `/api/integration` or the judge API |

### What makes this expensive

- **Shared JWT trust.** To verify the student tokens it forwards, our API must share the client's
  `JWT_SECRET`. That is a deep coupling and a single shared secret across two organisations. Do this only
  with a client you trust, and never reuse a secret between clients.
- **One deployment, one trust domain.** Sharing the secret is per deployment, so a hybrid client is
  effectively a dedicated stack. Prefer *judge only* where the client can live with comparing output
  themselves.

### Operator checklist

1. Create the college, as in section 3.
2. Issue an API key with scope `integration` (or `arventiq`): this makes every call attributable and
   meterable, which the legacy shared secrets are not.
3. Agree the JWT secret and claim format. Test that a forwarded student token is accepted.
4. Run the integration test suite (`npm test src/routes/integration.test.js` in `assessment-api`).
5. Same go-live and monitoring steps as the other options.

---

## 5. Choosing limits

Each API key has two optional limits, both counted in **test cases** (a batch of six is six):

- `rateLimitPerMin`: protects the judge from bursts. Fixed one-minute window.
- `monthlyQuota`: the allowance the client has bought. Calendar month, UTC.

### Sizing `rateLimitPerMin`

The judge is CPU-bound. On the 8-core development machine the sustained plateau for a mixed
C++/Java/Python workload was roughly **0.9 single executions per second**, about 54 per minute, and batching
raised the effective rate for compiled languages by about 3.5x. Interpreted languages are much faster.
Treat these as orders of magnitude, **and re-measure on the production server**.

A workable rule:

1. Estimate the judge's sustainable test cases per minute, `C` (measure it; see the runbook).
2. Keep the **sum of all clients' `rateLimitPerMin`** at about `1.5 x C`. Clients rarely burst together, so
   some oversubscription is fine, but a sum of `10 x C` means the limits protect nothing.
3. Give a client enough for their real peak: their largest class size times test cases per submission,
   divided by the minutes they expect that to take.

### Sizing `monthlyQuota`

Base it on the plan sold, plus headroom. The quota is a billing boundary, so decide in advance whether going
over means **stop** (`429`, the current behaviour) or **bill the overage** (raise the quota and invoice).

### What happens at the limit

The client receives `429` with `Retry-After` and nothing is charged for the refused request. A request
larger than the whole per-minute limit gets `422`, since waiting can never help. Tell clients about both in
the handover; the API reference explains them.

### Changing limits later

```bash
curl -s -X PATCH https://<host>/api/admin/api-clients/<clientId> \
  -H "Authorization: Bearer <admin JWT>" -H "Content-Type: application/json" \
  -d '{ "rateLimitPerMin": 200, "monthlyQuota": 250000 }'
```

Takes effect on the next request. `0` removes a limit.

---

## 6. Data, security and tenancy

### What is stored, and for how long

| Data | Where | Kept |
|---|---|---|
| Judge-only results (source, stdin, output) | `submissions`, flagged ad-hoc | **24 hours**, then deleted automatically |
| Usage records (who, language, status, time, test-case count) | `usageevents` | **Indefinitely** today. No source or output |
| Full-platform submissions, attempts, scores | `submissions`, `assessmentattempts` | Until deleted by the college |
| API keys | `apiclients` | The **hash** only. Revoked keys are kept, deactivated, so historical usage stays attributable |

If a client asks "do you keep our students' code?": judge-only, no beyond 24 hours; full platform, yes, as
part of the assessment record, for as long as the college keeps it.

### Security properties worth stating

- Keys are random, high-entropy, shown once, and stored only as a hash. A database leak does not reveal them.
- A revoked key stops working on the next request.
- Programs run in sandboxes with no network access, a CPU and memory ceiling, and a time limit.
- Tenant isolation is by college: one college's admin cannot read, change or even confirm the existence of
  another's data or keys.
- Browser-side code must never hold a key. Calls go from the client's **server**.

### Known gaps to be upfront about

- Legacy shared secrets (`TESTING_PLATFORM_KEY`, `ARVENTIQ_SECRET`, `CODEASSESS_SHIM_KEY`) still work and are
  **not attributable or limited**. A client on one of them is invisible to billing and quotas. Move every
  client to a real key, then retire the secrets.
- Per-IP rate limits depend on correct proxy configuration; see the
  [runbook's known risks](./OPERATIONS_RUNBOOK.md#known-risks).

---

## 7. Day-to-day: usage, changes, offboarding

| Task | How |
|---|---|
| See one client's usage and limits | `GET /api/admin/api-clients/<clientId>/usage` (their admin or a superadmin) |
| See all clients ranked by usage this month | `GET /api/admin/queue-stats` (superadmin) |
| List a college's keys | `GET /api/admin/api-clients` |
| Change limits, name or scopes | `PATCH /api/admin/api-clients/<clientId>` |
| Replace a leaked or old key | Issue a new key, switch the client over, `DELETE` the old one |
| Stop a client immediately | `DELETE /api/admin/api-clients/<clientId>` (deactivates; usage history is kept) |

### Monthly routine

1. Pull each client's `usedThisMonth` for billing. It comes from the durable usage record, which is exact.
2. Look for clients above ~80% of their quota, and warn them before they hit `429`.
3. Look at the queue depth and `429` counts for signs the judge is oversubscribed.

### Offboarding

1. Revoke the key (instant).
2. Judge-only data deletes itself within 24 hours.
3. For full-platform clients, agree the export and deletion of assessment data. There is no one-click
   tenant delete today.
4. Decide what to do with their usage records ([section 8](#8-decisions-that-are-yours-to-make)).

---

## 8. Decisions that are yours to make

These are not technical gaps; they are choices only the owner can make, and clients will ask about them.

| Decision | Why it matters |
|---|---|
| **Pricing**: per test case, per college per month, or tiered | Determines `monthlyQuota` defaults and what "over quota" means |
| **Overage policy**: hard stop at the quota, or bill the excess | Today it is a hard stop (`429`) |
| **Usage-record retention**: forever, or delete after N months | Usage records are kept indefinitely and contain tenant identifiers |
| **Support commitments**: channel, hours, response time | Nothing is promised in this documentation |
| **Availability target** | None is defined; the system has single points of failure (one judge host) |
| **Terms**: acceptable use, data processing, liability | Needed before onboarding a client you do not personally know |
| **When to retire the legacy shared secrets** | They are the only unmetered path |
| **Whether to publish the API reference** | [`GO_JUDGE_API.md`](./GO_JUDGE_API.md) is written to be shared with clients as is |
