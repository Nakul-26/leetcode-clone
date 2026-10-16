# Documentation

Two products live in this repository: the **Placement Assessment Platform** (colleges, students, exams) and
**GO Judge**, the code-execution service underneath it, which can also be used on its own.

Start with the row that matches what you are doing.

## I want to...

| I want to... | Read |
|---|---|
| **Understand how it all fits together** | [Architecture](./ARCHITECTURE.md) |
| **Run it, deploy it, or fix it when it breaks** | [Operations Runbook](./OPERATIONS_RUNBOOK.md) |
| **Change the code** | [Developer Guide](./DEVELOPER_GUIDE.md) |
| **Bring on a new client** (judge only, full platform, or hybrid) | [Client Onboarding](./CLIENT_ONBOARDING.md) |
| **Integrate with GO Judge** (a client developer) | [GO Judge API Reference](./GO_JUDGE_API.md) |
| **See what the exam portal may need to change** | [Exam Portal Changes](./FRIEND_PORTAL_CHANGES.md) |

## For the people using the platform

| Role | Guide |
|---|---|
| Instructors, professors, lab coordinators | [Faculty Guide](./FACULTY_GUIDE.md): onboard students in bulk, create and schedule assessments, monitor live exams |
| System administrators and IT staff | [Admin Guide](./ADMIN_GUIDE.md): monitoring, backup and restore, scaling |
| Candidates taking an assessment | [Student Guide](./STUDENT_GUIDE.md): logging in, the IDE, running and submitting code |
| Developers connecting an external testing platform | [Integration Guide](./INTEGRATION_GUIDE.md): the `/api/integration` surface |

## Planning and history

| Document | What it is |
|---|---|
| [Judge Unification and Scaling Plan](./JUDGE_UNIFICATION_AND_SCALING_PLAN.md) | The six-phase plan to put every surface on one queue-backed pipeline, with the measurements taken at each step. Phases 0-4 are built; Phase 5 (scale-out) remains |
| [Platform Audit and SaaS Roadmap](./PLATFORM_AUDIT_AND_SAAS_ROADMAP.md) | Findings from the platform audit and the path to a sellable service |
| [Arventiq integration](./arventiq-integration/README.md) | The living plan for one partner's stdin/stdout integration, plus its decision history |
| [Local Testing Notes](./LOCAL_TESTING_NOTES.md) | Notes from running the stack locally |
| [User Action Items](./USER_ACTION_ITEMS.md) | Things only the owner can do (deployments, secrets, decisions) |
| [Validation Plan](./VALIDATION_PLAN.md) | The plan for making problem validation mandatory before a problem can be saved |
| [Codespace Handoff](./CODESPACE_HANDOFF.md) | Earlier hand-off notes; some names in it are historical |

## Which document is the source of truth?

| Question | Authoritative document |
|---|---|
| What does a public API call accept and return? | [GO Judge API Reference](./GO_JUDGE_API.md) |
| What does a setting do and what is its default? | The tables in the [Runbook](./OPERATIONS_RUNBOOK.md) |
| Why was it built this way? | The decision log in [Architecture](./ARCHITECTURE.md) |
| What is deployed, and what is only built? | The status line at the top of the [Plan](./JUDGE_UNIFICATION_AND_SCALING_PLAN.md) |

When you change the system, update the document that describes it. The table at the end of the
[Developer Guide](./DEVELOPER_GUIDE.md#9-keeping-the-docs-true) says which.

## Operational readiness

Before your first real exam, do a **restore test** as described in the [Admin Guide](./ADMIN_GUIDE.md), and
read the "exam-day settings" section of the [Runbook](./OPERATIONS_RUNBOOK.md#capacity-and-tuning).
