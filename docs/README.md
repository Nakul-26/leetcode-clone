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
| **See what the exam portal may need to change** | [Exam Portal Changes](./plans/FRIEND_PORTAL_CHANGES.md) |
| **Add or run a second judge server** | [Second Judge](./judge/SECOND_JUDGE.md) |
| **Move a change from testing to production** | [Production and Testing](./PRODUCTION_AND_TESTING.md) |

## For the people using the platform

| Role | Guide |
|---|---|
| Instructors, professors, lab coordinators | [Faculty Guide](./guides/FACULTY_GUIDE.md): onboard students in bulk, create and schedule assessments, monitor live exams |
| System administrators and IT staff | [Admin Guide](./guides/ADMIN_GUIDE.md): monitoring, backup and restore, scaling |
| Candidates taking an assessment | [Student Guide](./guides/STUDENT_GUIDE.md): logging in, the IDE, running and submitting code |
| Developers connecting an external testing platform | [Integration Guide](./guides/INTEGRATION_GUIDE.md): the `/api/integration` surface |

## The judge: running more than one, and making it faster

| Document | What it is |
|---|---|
| [Second Judge](./judge/SECOND_JUDGE.md) | How the second judge on deploy4 shares work with deploy2's over Tailscale; setup, checks and measured results. Live since 2026-11-06 |
| [Second Judge for Another Stack](./judge/SECOND_JUDGE_FOR_ANOTHER_STACK.md) | The same setup for the Exam Sandbox stack, running beside GO Judge's on both servers |
| [Judge Fix Plan](./judge/JUDGE_FIX_PLAN.md) | The dated list of every judge fix (reliability, correctness, performance, security, scale-out), with commits |
| [Judge Agent Plan](./judge/JUDGE_AGENT_PLAN.md) | Fewer Docker calls per run: Phase 0 measurements, Phase 1 (merged execs, behind `JUDGE_MERGED_EXECS`) built, Phase 2 to decide |
| [Judge Performance Review](./judge/JUDGE_PERFORMANCE_REVIEW.md) | How a submission flows through the judge, what limits throughput (measured), and the prioritised fixes |
| [Judge Unification and Scaling Plan](./judge/JUDGE_UNIFICATION_AND_SCALING_PLAN.md) | The six-phase plan that put every surface on one queue-backed pipeline, with the measurements taken at each step. All phases done |

`judge/bench/` holds the benchmark script behind the Agent Plan's measurements.

## Plans and owner to-dos

| Document | What it is |
|---|---|
| [User Action Items](./plans/USER_ACTION_ITEMS.md) | Things only the owner can do (deployments, secrets, decisions) |
| [Editor UX Plan](./plans/EDITOR_UX_PLAN.md) | The editor problems students reported and the fixes (diagnostics, starter code, per-language drafts) |
| [Exam Portal Changes](./plans/FRIEND_PORTAL_CHANGES.md) | What the exam portal may need to change for GO Judge |
| [Exam Portal Agent Prompt](./plans/EXAM_PORTAL_AGENT_PROMPT.md) | A prompt to give an AI agent working in the exam portal's repository |
| [Platform Audit and SaaS Roadmap](./plans/PLATFORM_AUDIT_AND_SAAS_ROADMAP.md) | Findings from the platform audit and the path to a sellable service |
| [Validation Plan](./plans/VALIDATION_PLAN.md) | The plan for making problem validation mandatory before a problem can be saved |
| [Arventiq integration](./arventiq-integration/README.md) | The living plan for one partner's stdin/stdout integration, plus its decision history |

## Archive

Kept for history; parts are out of date.

| Document | What it is |
|---|---|
| [Codespace Handoff](./archive/CODESPACE_HANDOFF.md) | Earlier hand-off notes; some names in it are historical |
| [Local Testing Notes](./archive/LOCAL_TESTING_NOTES.md) | Notes from running the stack locally |
| [Security brainstorm: websites](./archive/SECURITY_BRAINSTORM_GENERAL.md), [this platform](./archive/SECURITY_BRAINSTORM_PLATFORM.md) | Early checklists of vulnerability classes; the findings that mattered are in the Platform Audit and the Fix Plan (S1-S3) |

## Which document is the source of truth?

| Question | Authoritative document |
|---|---|
| What does a public API call accept and return? | [GO Judge API Reference](./GO_JUDGE_API.md) |
| What does a setting do and what is its default? | The tables in the [Runbook](./OPERATIONS_RUNBOOK.md) |
| Why was it built this way? | The decision log in [Architecture](./ARCHITECTURE.md) |
| What is deployed, and what is only built? | The status line at the top of each plan, and the dated rows of the [Fix Plan](./judge/JUDGE_FIX_PLAN.md) |

When you change the system, update the document that describes it. The table at the end of the
[Developer Guide](./DEVELOPER_GUIDE.md#9-keeping-the-docs-true) says which.

## Operational readiness

Before your first real exam, do a **restore test** as described in the [Admin Guide](./guides/ADMIN_GUIDE.md), and
read the "exam-day settings" section of the [Runbook](./OPERATIONS_RUNBOOK.md#capacity-and-tuning).
