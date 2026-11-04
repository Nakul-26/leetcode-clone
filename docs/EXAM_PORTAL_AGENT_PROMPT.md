# Prompt for an AI agent working on the exam portal

> **How to use this file:** pull this repository (GO Judge, `leetcode_clone`), open your AI coding agent in
> the **exam portal's** repository, and give it everything below the line. Tell it where you cloned this
> repository, replacing `<GO_JUDGE_REPO>` (for example `../leetcode_clone`).
>
> Last updated: 2026-11-04. When this file changes, `git log -p docs/EXAM_PORTAL_AGENT_PROMPT.md` shows
> what's new.

---

You are working on the **exam portal** (exam-portal.fortifyhub.net): the platform students use for practice
tests and exams. It runs and grades code through **GO Judge**, a separate service whose source is at
`<GO_JUDGE_REPO>`. The portal calls GO Judge's public API (`/api/codeAssess/submissions`, header
`x-rapidapi-key`), most likely from `runOnJudge()` in `workers/student-workerjs/src/judge.js`. Confirm the
actual location before changing anything.

Your job is to bring the portal up to date with what GO Judge now offers, and to fix the editor problems
students reported. Work in the portal's repository. Treat `<GO_JUDGE_REPO>` as **read-only reference**:
don't change it. If something there looks wrong, write it down for the GO Judge owner.

## Ground rules

1. **Exams come first.** Never deploy during an exam window, and never change how a submission is
   *graded* without saying so explicitly in your summary. Display changes are safe; grading changes need
   the owner's approval.
2. **Read before changing.** Find how the portal calls GO Judge today, what it reads from the response, how
   it shows results, and how the editor picks starter code, *before* you edit. Quote the relevant code in
   your plan.
3. **Every change must keep working against an older GO Judge.** New response fields may be missing:
   treat `diagnostics` and `status.description` as optional.
4. **Small, reviewable commits**, each with a clear message. Run the portal's own tests and linters before
   each commit. Add tests where the portal has a test setup.
5. **Plan first.** Start by writing a short plan (which files, which change, how you'll verify it) and
   wait for approval if your tool supports it.
6. When unsure about the API, the source of truth is `<GO_JUDGE_REPO>/docs/GO_JUDGE_API.md`. Read it fully
   before starting.

## Read these first (in `<GO_JUDGE_REPO>/docs/`)

| File | Why |
|---|---|
| `GO_JUDGE_API.md` | The API contract: request/response fields, statuses, languages, limits, errors, batch, test-case check, and **"Showing errors to students"** (the new `diagnostics` field) |
| `EDITOR_UX_PLAN.md` | What students reported, what we observed on the exam portal on 2026-11-04 (with exact messages), and the plan. Sections "Verified on the exam portal" and "For the exam portal" are written for you |
| `FRIEND_PORTAL_CHANGES.md` | Earlier handoff: behaviour changes, API keys, batch, quotas, test-case checking, rollout |
| `JUDGE_FIX_PLAN.md` | Dated log of every judge fix and its measured effect |

---

## Part 1: what changed in GO Judge (context)

You don't implement these: they're in GO Judge already. They explain what the portal will now receive
and what it can rely on. If the portal's judge runs from this repository (the "Exam Sandbox" deployment
uses the same `docker-compose.prod.yml`), **redeploying it from the latest `main`** is what delivers
them. See Part 3.

### 1a. Errors students can act on (2026-11-04)

What students were seeing on the portal, and what GO Judge now returns:

| Student's mistake | Before | Now |
|---|---|---|
| C++ `cout << v` where `v` is a vector | 107 lines, 8 KB of "candidate" notes | `diagnostics`: line 16, "`cout` can't print a whole vector. Loop over it…" |
| C++ `sort()` on a `set` | 93 lines; the first error inside `stl_algo.h:1914` | Line 9, "`sort()` only works on a vector or an array. A `set` is already sorted…" |
| C missing `;` at the end of line 17 | Reported on line 18 | Line 17, "Missing `;` at the end of this line." |
| Missing `}` on an `else` block | Pointed at `main()`'s brace (line 10) and the end of the file | The `{` that's never closed (line 17) |
| Python typo in a function | Cause on the last line, under 3 stack frames with `/app/sub-raw-…` paths | Line of the typo, "`reuslt` isn't defined. Did you mean `result`?" |
| Python `int(input())` in a loop, numbers on one line | `ValueError: invalid literal for int() with base 10: '4 1 7 7 3'` | Plus: "`int(input())` read the whole line… use `list(map(int, input().split()))`" |
| C/C++ segfault, division by zero | "Runtime Error · (nothing printed)" | `stderr`: "Segmentation fault (exit code 139): The program read or wrote memory it doesn't own…" |
| Python `IndentationError` | Status 11 (Runtime Error), named `solution.py` | Status **6** (Compilation Error), message in `compile_output`, file named `main.py` |
| Every compiler line | Started with `/app/sub-raw-1793763843311605486-1051734594/main.cpp:` | Starts with `main.cpp:` |

New and changed response fields (all additive):

- **`diagnostics`**: up to 3 `{ line, column, kind, message, hint }`, **plain JSON, never base64**, empty
  when accepted. `line`/`column` are 1-based in the submitted source, already corrected (see the table),
  or `null` when no line applies. `kind` is `compile | runtime | timeout | memory`. `hint` is plain
  language with code in backticks, or `null`.
- **`status.description`** is now on every response.
- `stderr` / `compile_output` contain no workspace paths, and no judge-internal prefix like
  `compilation failed: runtime error: exit code 1 | stderr=`.

### 1b. Students no longer need to remember libraries (2026-11-04)

For C, C++, Java and C#, when a program uses a standard library it didn't include or import, GO Judge
supplies it:
- **C:** `strlen` without `<string.h>`, `toupper` without `<ctype.h>`, `sqrt` without `<math.h>`.
- **C++:** `vector`, `sort`, `accumulate` without their headers.
- **Java:** `Scanner`, `ArrayList` without `java.util`.
- **C#:** `List` without its `using`.

**Error line numbers don't change.** C/C++ headers are force-included from a separate file, and Java/C#
imports are joined onto line 1. Nothing is added for a name the program defines itself (a student's own
`strlen`), or when it already includes `<bits/stdc++.h>`.

**Java accepts any `public class` with a `main` method**, not only `Main`. `public class Solution` used to
fail with "class Solution is public, should be declared in a file named Solution.java".

### 1c. Speed (October 2026)

Measured per submission, before → after:

| Language | Before | After |
|---|---|---|
| Python | 8.68 s | 0.32 s |
| JavaScript | 2.94 s | 0.19 s |
| TypeScript | 17.5 s | 0.77 s |
| Java | 5.36 s | 1.06 s |
| C++ (5 tests) | 6.7 s | 1.7 s |
| Kotlin | 20.7 s | 7.0 s |
| C# | 10.8 s | 4.4 s |

The changes behind this:
- all tests of a submission run in one process;
- precompiled `bits/stdc++.h`;
- Java class-data archives;
- Kotlin compiles only the student's file, and C# compiles with `csc` directly;
- `wait=true` wakes up through Redis instead of polling.

### 1d. Grading behaviour changes you must know about (October 2026)

- **C and C++ compile with `-O2`.** Code with undefined behaviour (uninitialised variables, out-of-bounds
  reads, signed overflow) can print something different than it did unoptimised. Re-check the expected
  outputs of C/C++ questions against the new judge before an exam: `scripts/judge_contract_check.mjs`.
- **Time limits are judged on CPU time**, not wall-clock, so a busy server no longer causes false Time
  Limit Exceeded verdicts. A program that sleeps or is starved runs on to a 3× wall-clock cap.
- **A crashing program is status 11** (Runtime Error, with `exit_code` and `stderr`), not 13. Status 13
  now only means GO Judge itself failed: safe to retry, not the student's fault.
- Source is compiled **as sent**. Nothing "unescapes" `\n` in the source any more.

### 1e. Optional API features you can adopt (see `GO_JUDGE_API.md`)

- **Per-client API key.** Same header; makes usage, quotas and the queue-backed path available. An admin
  creates one on GO Judge's **System → API Keys** page. The shared secret keeps working.
- **Batch:** `POST /submissions/batch`, up to 20 items. Items with the same source compile once:
  **3.6× faster for C++, 3.4× for Java** on a 6-test question. Key only.
- **Test-case check:** `POST /test-cases/check` and `/generate` run the question's reference solution on
  its inputs and flag wrong expected outputs before students see the question.
- **Quotas:** a `429` with `Retry-After` means wait and retry. **Never fail the student's submission for
  a 429.**

---

## Part 2: portal tasks, in priority order

Each task lists what we observed on exam-portal.fortifyhub.net (dummy student account, practice test "test
to improve the platform" and exam "test exam to improve platform", 2026-11-04), what to change, and when
it's done. Screenshots of the observations are referenced in `EDITOR_UX_PLAN.md`.

### Task 0: Check that the judge client handles the current responses (do this first)

Read the portal's GO Judge client (`runOnJudge()` or equivalent) and confirm:
- status `6` is shown with `compile_output`, including for **Python** (syntax errors are now 6, not 11);
- status `11` shows `stderr` **and** `stdout`;
- status `13` is shown as "Judge problem, please try again", not as the student's fault;
- base64 fields are decoded only when non-null;
- the HTTP timeout is above 25 s;
- a `429` is retried after `Retry-After` and never marks the submission failed.

**Done when** you've listed each check with the code that handles it, and fixed any that fail, with a
test where possible.

### Task 1: Show `diagnostics` first

**Observed:**
- Errors appear in a small box (about 10 lines) that scrolls. One C++ mistake fills 2,500 px.
- The important line is buried, at the bottom of a Python traceback, or names a file inside the compiler.
- The editor never marks the failing line.

**Do:**
- Above the raw output, render each entry of `diagnostics` as a card: the kind ("Compile error"), a
  clickable "Line N", the `message`, and the `hint` (render `` `code` `` spans as code).
- Clicking "Line N" moves the editor cursor there (`editor.revealLineInCenter`, `editor.setPosition`,
  `editor.focus`).
- Put a red underline on every diagnostic line with Monaco markers (`monaco.editor.setModelMarkers(model,
  "judge", ...)`), with message and hint on hover. Clear them on the next run.
- Keep the full `compile_output`/`stderr` behind "Show full output", collapsed when `diagnostics` is not
  empty. Make the box taller or resizable.
- If `diagnostics` is missing (older judge), keep today's display.

A working reference implementation (React and Monaco):
- `<GO_JUDGE_REPO>/frontend/src/components/DiagnosticsSummary.jsx`
- `<GO_JUDGE_REPO>/frontend/src/utils/editorDiagnostics.js`
- styles: `.diagnostic*` in `<GO_JUDGE_REPO>/frontend/src/styles.css`

**Done when:** for the six mistakes in Part 1a, the student sees the right line and the hint without
scrolling, and clicking it jumps to the line. This holds in practice tests and in exams; check that the
exam's fullscreen and paste rules still work.

### Task 2: Starter code that already does the boring parts

**Observed:**
- Python starter is a single comment line.
- C starter has only `<stdio.h>`; C++ has only `<iostream>`.
- Students wrote `int(input())` in a loop for numbers that are on one line.

The Java starter (`import java.util.*`, `class Main`, a `Scanner`) is good. **Keep the per-language
drafts**: switching languages already keeps each language's code, and that's correct.

**Do**, for each language the portal offers:
- **C:** `stdio.h`, `stdlib.h`, `string.h`, `ctype.h`, `math.h`, `stdbool.h`.
- **C++:** `#include <bits/stdc++.h>` and `using namespace std;`. It's precompiled on the judge, so
  compiles stay fast.
- **Python:** read the input robustly, e.g. `import sys` then `data = sys.stdin.read().split()` and an
  iterator. With a comment: "this reads every number, whatever the line breaks".
- In every language, a comment saying **"print only the answer: no prompts, no extra text"**.
- Our stdin templates can be copied: `STDIN_TEMPLATES` in
  `<GO_JUDGE_REPO>/frontend/src/utils/buildTemplate.js`.

**Done when** each starter compiles and runs as is, and switching languages still keeps each language's
draft.

### Task 3: Warn before running about prompts

**Observed:** `input("Enter n: ")` produces output `Enter n: Enter numbers: 4`, marked Wrong Answer with no
explanation. JavaScript `prompt()` doesn't exist on the judge.

**Do:** before Run and Submit, if Python code calls `input("…")` with an argument, or JS/TS calls
`prompt(`, show a non-blocking hint under the editor: "Don't print prompts: the grader compares your exact
output." Don't block the run.

**Done when** the hint appears for those cases and not for `input()`.

### Task 4: Explain the disabled Run button

**Observed:** Run is disabled until the code differs from the starter, with no tooltip or message, so it
looks broken.

**Do:** keep Run enabled, or add a visible tooltip or label ("Edit the code to run it").

### Task 5: Guidance in each question

**Observed:**
- Each question has a single sample and no explanation.
- Students don't know the input is several numbers on one line.

**Do:**
- Show two or three samples, including an edge case, with a one-line explanation each.
- Show the input format line by line, and a fixed sentence: "Read from standard input. Print only the
  answer."
- If question authoring is in the portal, add an optional "Explanation" per sample.

### Task 6: Output panel

**Do:**
- Always show what the program printed (`stdout`), even when it crashed or timed out ("(nothing printed)"
  only when empty).
- When the run is accepted, show `stderr` (debug prints, warnings) in a neutral colour, not red.
- For a wrong answer, keep expected vs actual side by side, and highlight the first line that differs.

### Task 7 (optional, capacity): API key, batch and test-case check

Only after Tasks 0 to 6, and with the owner's approval:
- move the portal to its own API key;
- send a question's test cases as one batch;
- on "save question", call `POST /test-cases/check` and refuse to publish unless `all_match` is true.

Read `FRIEND_PORTAL_CHANGES.md` sections 2, 3 and 5 first: with a key, responses can be status 1/2 with
`null` fields, and the poll loop starts to run.

---

## Part 3: deploying the judge side

If the portal's GO Judge runs from this repository:

1. Pick a time **outside any exam window**.
2. Before deploying, re-check C/C++ questions' expected outputs:
   `node scripts/judge_contract_check.mjs` (see `FRIEND_PORTAL_CHANGES.md` §6). Add the exam's own
   questions as fixtures.
3. Deploy the latest `main` with `docker-compose.prod.yml`. Wait until `/api/health` reports every service
   connected.
4. Smoke-test with `npm run loadtest -- smoke` from this repository (needs an API key in
   `loadtest/.env`; see `loadtest/README.md`). Then run one practice test by hand with the mistakes from
   Part 1a.

## Part 4: how to verify your portal changes

Run these by hand in a practice test **and** in an exam (fullscreen, paste blocked):

| Language | Code | Expect |
|---|---|---|
| C++ | `cout << v;` with `vector<int> v` | One card, the right line, hint about looping |
| C | missing `;` at the end of a line | Card on *that* line |
| Python | `int(input())` in a loop, input `5\n4 1 7 7 3` | Card on the loop line with the `split()` hint |
| Python | bad indentation | Compile error card, not Runtime Error |
| C++ | null pointer dereference | Card "Segmentation fault" with an explanation |
| Python | `input("Enter n: ")` | Prompt hint before running |
| any | correct solution | Accepted, no cards, output shown |
| C | `strlen` without `<string.h>` | Compiles and runs (judge side, needs Part 3) |
| Java | `public class Solution` with `main` | Runs (judge side, needs Part 3) |

## What to hand back

A summary with:
- each task: done / partly / not done, and why;
- the files changed;
- anything that changes grading (should be nothing);
- anything you found in GO Judge that looks wrong (don't fix it there; report it);
- screenshots of Task 1 for the C++ vector case and the Python indentation case.
