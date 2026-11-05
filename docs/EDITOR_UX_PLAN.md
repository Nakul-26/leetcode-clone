# Coding editor: problems students reported, and the plan

**Written:** 2026-11-03. **Status:** building, see "Build plan" below.

## Build plan (started 2026-11-04)

Ordered so the exam portal benefits first, without any change on its side.

| Step | What | Where | Status |
|---|---|---|---|
| B1 | **Diagnostics module.** Raw compiler or traceback text in; `[{line, column, kind, message, hint}]` out. Handles gcc/g++, javac, Python, Node, kotlinc, csc, rustc, go, Ruby and PHP formats. Only the student's file, first error first (max 3), library-header errors mapped to the student's "required from here" line. Fixes the `;` and `}` line misdirections, gives hints for the common errors, and suggests "did you mean" from the student's own identifiers. | `assessment-api/src/services/diagnostics/` | **done** |
| B2 | **Remove workspace paths** (`/app/sub-raw-…/`) from `stderr` and `compile_output`, and show `solution.py` as `main.py` | same module | **done** |
| B3 | **GO Judge API** (`/api/codeAssess`, sync and queued): add a `diagnostics` array (additive), remove paths from the raw fields, report a Python `SyntaxError`/`IndentationError` as Compilation Error (6) | `codeAssessShim` | **done** |
| B4 | **Our Run and submission results** carry `diagnostics` too | `problems.service` runProblem, GET submission | **done** |
| A1 | **Basic libraries added automatically**, without moving line numbers. Only what the code *uses and doesn't define itself*: a blanket `bits/stdc++.h` makes a global `count`/`rank` ambiguous, and `<string.h>` breaks a student's own `strlen`. C/C++: missing headers go in a `prelude.h` passed with `-include` only when non-empty. A `#line 1` directive would make GCC print the wrong source text under each error, and an always-on `-include` stops `bits/stdc++.h` from using its precompiled header. Java/C#: imports and usings are joined onto line 1. Java also runs any `public class` with `main` through an appended `Main`. Checked with the real gcc, g++ and javac images. | `judge-service-go/pkg/central/adapters/prelude.go` | **done** |
| A2 | **Crash explanations:** done in the API rather than the judge (`explainRawResult`). An exit by signal with an empty stderr gets a plain message. | `codeAssessShim.service.js` | **done** |
| C1 | **Summary card** at the top of our result panel: line, message and hint; click jumps to the line; red underline on the line (Monaco markers); full output collapsed | `SubmissionOutput`, `ProblemPage`, `AssessmentWorkspace` | **done** |
| C2 | Starter code that runs as is in all 12 languages, per-language drafts, examples in the statement | frontend | **done** except examples in the statement (2026-11-05 · `d03d30f`): code kept per language on the practice and exam pages, Reset button, all 12 × {function, stdin} starters run on assess. Also fixed: exam page showed no editor for stdin problems |
| D1 | API contract for the portal (`diagnostics` field, how to show it), tests for every real mistake in this doc, lint, deploy to the testing stack, re-check in Chrome | docs, tests | API contract written (`GO_JUDGE_API.md`, "Showing errors to students"); tests done; deployed to the testing stack 2026-11-04 and checked live in Chrome (C `strlen` without its header passes, `cout << vector` is one diagnostic on line 7, the Python input loop gets its hint, click-to-jump and underlines work) | **done** |

Students reported five problems:

1. Proper error messages
2. When we switch between languages the boilerplate should update
3. Proper guidance on what to code: what the input is and what the output should be
4. Some input methods are not working
5. Show outputs without error messages

The reports don't say which platform they came from. Most students write code in the exam portal, which
calls our GO Judge API (`/api/codeAssess`) and shows the results in its own editor. So each item below is
split into **our side** (this repo: the practice page `ProblemPage.jsx`, the exam page
`AssessmentWorkspace.jsx`, and the judge or API) and **the portal's side** (for the friend who
maintains it). Anything only the portal's code can confirm is marked **VERIFY**.

---

## What the code does today

| # | Report | What I found here | Where the fix belongs |
|---|---|---|---|
| 1 | Error messages | Any failed Run shows **"Failed to run code"** and drops the server's real reason (rate limit, timeout, bad input, judge down). Compile errors are shown raw, with container paths like `/app/Main.java:3:`. The public API's sync path returns `status: { id }` with no `description`, so a client that shows `status.description` prints **"undefined"**. | Both |
| 2 | Boilerplate on language switch | Here it **does** update (`ProblemPage.jsx:79`, `AssessmentWorkspace.jsx:435`), but it **wipes whatever the student wrote** with no warning, and switching back doesn't bring that code back. Several function-mode templates (Java, Kotlin, Rust, C#, C++) have no `return`, so running the untouched starter gives a compile error instead of a wrong answer. | Ours: polish. Portal: **VERIFY**, most likely the real bug |
| 3 | Guidance on input and output | The statement shows the description and either the function signature or the input/output format. It **never shows a worked example** (sample input → expected output), even though sample tests exist (`isSample`). There's no place for constraints or an explanation of the example. | Both |
| 4 | Input methods | Whole-program (stdin) code has fixed rules that the editor never tells students: Java must be `public class Main`; Kotlin needs a top-level `fun main()`; C# can have only one entry point. Common habits that fail: `public class Solution` in Java (javac error about the file name), `prompt()` in JavaScript (doesn't exist in Node), and `input("Enter n: ")` in Python (the prompt text ends up in the output, so the answer is marked wrong). | Mostly ours (judge), plus portal guidance |
| 5 | Outputs without error messages | Most likely meaning: show what the program printed, cleanly, even when it fails or prints warnings, rather than an error box only. Today, if a run fails, the printed output is buried under the error or missing, and stderr (including harmless warnings) is coloured as an error. **To confirm with a screenshot.** | Both |

---

## Verified on the testing site (2026-11-04)

Checked in Chrome on assess.fortifyhub.net, using two test problems `[TEST] Sum of a list (stdin)` and
`[TEST] Sum of a list (function)`, created for this. They're tagged `test` and can be deleted.

**Input methods (item 4):** every usual way of reading input works:
- Python: `input()`, `sys.stdin`
- JS: `fs.readFileSync(0)`, `readline`
- Java: `Scanner`, `BufferedReader`
- C++: `cin`, `getline`
- C: `scanf`
- Go: `fmt.Scan`
- Kotlin: `readLine()`
- C#: `Console.ReadLine`
- Rust: `read_to_string`
- Ruby: `gets`
- PHP: `fgets(STDIN)`

Input with or without a trailing newline both pass. What fails:

| Student wrote | Student sees |
|---|---|
| Java `public class Solution` | Compilation Error: `compilation failed: runtime error: exit code 1 \| compilation failed: runtime error: exit code 1 \| stderr=/app/sub-run-…/Main.java:3: error: class Solution is public, should be declared in a file named Solution.java`, and "0 / 0 tests passed" |
| Python `input("Enter n: ")` | Wrong Answer, because the output becomes `Enter n: 6`. Nothing says why. |
| JS `prompt()` | Each case shows only "Runtime Error". `ReferenceError: prompt is not defined` appears only further down, under Console Logs. |

**Errors and output (items 1, 5):** for a Python crash after printing, each case shows:
- the error box: just "Runtime Error";
- no "Your output" field: what the program printed is mixed into "Console Logs";
- the traceback twice, with a literal `\n` between the copies and the full `/app/sub-run-…` path.

**Starter code (item 2):** switching language replaces the code. Switching back loses what the student wrote.
Running the untouched function-problem starter code, unchanged, in each language:

| Result | Languages |
|---|---|
| Wrong Answer (fine: it runs) | Python, JS, TS, C, Go, Ruby, PHP |
| Compilation Error | Java (missing return), Rust (mismatched types), C# (null warning shown first), Kotlin (first line shown is `Failed to load native library:jansi`, a harmless warning) |
| Runtime Error | C++: no return value, so the program crashes at `-O2` |

**Guidance (item 3):** the statement shows the input/output format but no examples.

---

## Plan: our side

Ordered by how many students each item helps for the effort.

### E1. Real error messages (item 1)
- Frontend Run and Submit: show the server's message (`err.response.data.error || msg`) and explain
  common cases in plain words: 429 "Too many runs, wait a few seconds", timeout "Your code took too
  long to start or run", network "Can't reach the judge, check your connection".
- A short friendly line above the raw compiler or runtime output, for example: "Compilation error on
  line 3: `';' expected`". Remove `/app/` and temporary paths, and keep the full text in a
  collapsible section.
- GO Judge API: always return `status.description` (`"Accepted"`, `"Compilation Error"`, `"Runtime
  Error (NZEC)"`, `"Time Limit Exceeded"`, ...) on the sync path too, matching the keyed path.
  This only adds a field, so clients can't break.
- When a program is killed by a signal, put a plain explanation in `stderr` on the raw path (X9):
  - 139 / SIGSEGV: "Segmentation fault: reading or writing memory you don't own (null pointer, array index out of range, very deep recursion)";
  - 136 / SIGFPE: "Arithmetic error, e.g. division by zero";
  - 132 / SIGILL: "Program hit undefined behaviour, often division by zero or a missing return";
  - 134 / SIGABRT: "Program aborted (failed assert, bad allocation)".
- Report a Python `SyntaxError` or `IndentationError` as Compilation Error (status 6), not Runtime Error. Name the
  file `main.py` so the traceback matches the editor tab (X10).
- Report an out-of-memory kill as **Memory Limit Exceeded** instead of a runtime error that only
  shows a big memory number.

### E2. Language switch keeps work (item 2)
- Keep code **per language** for each problem: switching to C++ and back to Python brings the
  Python code back. A language not yet touched gets its starter code.
- A **Reset to starter code** button (with a confirmation) instead of switching languages silently
  replacing work.
- Fix every function template so the untouched starter compiles: return a default value for the
  return type.
- Test: starter code for each of the 12 languages × {function, stdin} compiles and runs.

### E3. Guidance (item 3)
- Show **Example 1, 2, ...** under the statement from the sample tests: Input, Output and an
  optional Explanation. For stdin problems, show the input exactly as it's read (line by line).
- Add optional **Constraints** and per-sample **Explanation** fields to the problem form, and show
  them on both the practice and exam pages.
- In stdin starter code, add one comment per language saying how to read the input and that
  only the answer should be printed: no prompts, no extra text.

### E4. Input methods (item 4)
- **Java: accept any public class name.** The judge finds `public class X` with a `main` method and
  compiles it as `X.java` and runs `X`. This removes the most common Java failure.
- Send every stdin input with a trailing newline, so `readLine`, `getline` and `Scanner.nextLine`
  never hit end of input on the last line.
- Spot `prompt(` in JavaScript and `input("...")` with a prompt in Python, and show a hint under
  the editor before running: "Don't print prompts: the grader compares your exact output".
- Add a contract test in the judge: each language's common input styles (Scanner,
  BufferedReader, `input()`, `sys.stdin`, `readline`, `fs.readFileSync(0)`, `cin`, `scanf`,
  `getline`, `bufio`, `readLine()`, `Console.ReadLine`, `gets`, `fgets(STDIN)`, `read_line`) all
  read one-line and multi-line input correctly.

### E5. Clear output panel (item 5)
- On Run, every case shows **Your output** first, always, even when the program crashed or timed
  out, followed by the error underneath.
- Show stderr as **Console (stderr)** in a neutral colour. Use red only when the run actually
  failed, so warnings and debug prints don't look like errors.
- For a wrong answer, highlight the first line that differs from the expected output.

**Order:** E1 and E4 first: they're the biggest source of "it doesn't work" and they're mostly
server-side, so the portal benefits without changing anything. Then E2, then E3 and E5.

---

## Verified on the exam portal (2026-11-04)

Tested on exam-portal.fortifyhub.net with a dummy student account. I ran both dummy tests, the practice test
"test to improve the platform" (10 questions) and the exam "test exam to improve platform" (20 questions,
fullscreen and paste-blocked), in the same editor. The exam was left unsubmitted.

**Already good:**
- Switching language keeps each language's own code (C → Java → C → Java kept my edits).
- The Java starter has `import java.util.*`, `class Main` and a `Scanner`.
- Sample tests show input, expected output and your output side by side.
- A crash shows "(nothing printed)" separately from the traceback.

**Problems seen:**

| # | What happened | Report |
|---|---|---|
| X1 | C++ with `vector` and `sort` under the starter's only `#include <iostream>`: **"didn't compile"**, `'vector' was not declared in this scope` | Libraries |
| X2 | C with `strlen` and `tolower` under the starter's only `#include <stdio.h>`: **"didn't compile"**, `implicit declaration of function 'strlen'`. GCC 14 makes this an error; older compilers only warned, so students don't expect it. | Libraries |
| X3 | Every compiler and traceback line starts with `/app/sub-raw-1793763843311605486-1051734594/main.cpp:5:5:`. The real message is hard to find in a small scrolling box. | Error messages |
| X4 | Python: reading an array with `for i in range(n): arr.append(int(input()))` gives `ValueError: invalid literal for int() with base 10: '4 1 7 7 3'`, with no hint that `input()` reads the whole line | Input |
| X5 | Python `input("Enter n: ")`: Wrong answer, with output `Enter n: Enter numbers: 4`. Nothing says prompts are the cause. | Input |
| X6 | The Python starter is a single comment line: no example of reading a number or a list | Guidance and boilerplate |
| X7 | Each question has one sample and no explanation of the answer | Guidance |
| X9 | **Run** on C++ with a null-pointer read (segfault) or a division by zero: just **"RUNTIME ERROR · (nothing printed)"**, no reason at all. Cause on **our** side: `/raw-run` leaves `stderr` empty when the program is killed by a signal. The function path says "Segmentation fault (core dumped)", exit 139. Division by zero at `-O2` comes out as SIGILL, "Illegal instruction", exit 132. | Error messages |
| X10 | **Run** on Python with bad indentation: labelled **"RUNTIME ERROR"** although it's a syntax error, and the traceback names `solution.py` while the editor tab says `main.py` | Error messages |
| X11 | **Run** on an infinite loop: "TIME LIMIT EXCEEDED · took 2.1 s · (nothing printed)". This one is clear. | ok |
| X8 | **Run is disabled until the code differs from the starter**, with no tooltip or message, so it just looks broken | Error messages |

### Realistic mistakes: where the real error ends up (Run, practice test)

The output box shows about **200px** (roughly 10 lines) and scrolls.

| Student code | Output | Where the useful part is |
|---|---|---|
| C++ `cout << result` where `result` is a `vector` | **107 lines, 8 KB**, "there are 47 candidates" | Line 4 says "no match for operator<<". The remaining ~100 lines are a list of overloads. Nothing says "you can't print a vector, loop over it". |
| C++ `sort()` on a `set` | **93 lines** | The first `error:` is in **`/usr/local/include/c++/16.2.0/bits/stl_algo.h:1914`**: `no match for 'operator-' (… '_Rb_tree_const_iterator<int>' …)`. The student's line 9 appears only as a "required from here" note above it. |
| C++ `secnd` typo, plus `greater<int>` without `()`, plus a missing `<algorithm>` | 3 errors | The box is already full, so the typo (with a useful "did you mean 'second'") is below the fold |
| C++ missing `}` on an `else` block | `expected '}' at end of input` at **line 26**, "to match this '{'" at **line 10** (`main`) | The real mistake is the `else {` on line 17. Nothing points there. |
| C missing `;` at the end of line 17 | `expected ',' or ';' before 'pritnf'` at **line 18** | The wrong line. After fixing it, the student compiles again to discover the `pritnf` typo. |
| Python typo `reuslt` in a helper function | Three stack frames with full `/app/sub-raw-…/solution.py` paths, then the cause | The cause, `NameError: name 'reuslt' is not defined`, is the **last** line, in the same red as the noise. With a deeper call stack it scrolls out of view. |

Also: the editor never marks the failing line (no red squiggle) and there's no way to jump to it.

---

## Error summary: the fix for "hard to pinpoint" (our side, plus a small portal change)

The judge already has everything needed. It just returns one raw blob. Plan:

**S1. Structured diagnostics in the API** (additive, so existing clients are unaffected). Every result gets
`diagnostics: [{ line, column, kind, message, hint, raw }]`:
- **Only the student's file.** Map library-header errors back to the student's "required from here" line.
  `sort` on a `set` becomes **line 9**: "`sort` needs a vector or array; a `set` is already sorted, so loop over it directly."
- **First error first**, at most 3, with duplicates and follow-on errors removed.
- **Fix known misdirections:**
  - `expected ';' before X` points to the end of the *previous* code line (line 17, not 18);
  - `expected '}' at end of input`: we scan the code ourselves and report the `{` that was never closed (the `else {` on line 17);
  - Python: the error line comes first, and only frames in the student's file are kept.
- **Plain-language hints for the ~30 most common errors**, matched on the compiler text. For example:

  | Compiler or Python says | Hint shown |
  |---|---|
  | `was not declared in this scope; did you mean 'second'` | "`secnd` isn't defined. Typo for `second`?" |
  | `no match for 'operator<<' … std::vector` | "`cout` can't print a whole vector. Loop over it, or print elements with spaces." |
  | `NameError: name 'reuslt' is not defined` | "`reuslt` isn't defined. Did you mean `result`?" Suggested from the student's own identifiers, by edit distance. |
  | `invalid literal for int() … '4 1 7 7 3'` | "`input()` reads a whole line. Use `list(map(int, input().split()))`." |
  | `IndentationError` / `SyntaxError` | Reported as a **compile** error, with the line |
  | segfault / SIGFPE / SIGILL | The crash explanations above |
  | `implicit declaration of function 'strlen'` / `'vector' was not declared` | Goes away once libraries are added automatically |

- **`raw`** keeps the full output, with paths removed, for anyone who wants it.

**S2. Portal display (small change for the friend):**
- A **summary card at the top of the output**: "Line 17: missing `;` at the end of this line", with the hint underneath.
- **Click a diagnostic to jump to that line**, and put a red squiggle on it (Monaco `setModelMarkers`; we send the line and column).
- The full output collapsed under "Show full compiler output". Make the box taller or resizable.

**S3. Same on our pages:** `SubmissionOutput` renders `diagnostics` the same way.

**How we know it works:** a test fixture of the real student mistakes above (and more) per language. Each one asserts that the first
diagnostic names the right line and has a hint. Fixtures come from these runs and, later, from anonymised real
compile failures in the database.

---

## Libraries and input: what we'll do

**Libraries.** Students shouldn't have to remember basic headers.
- Starter code includes them. C++: `#include <bits/stdc++.h>` plus `using namespace std;`. C: stdio, stdlib,
  string, ctype, math and stdbool. Java: `java.util.*`, `java.io.*`, `java.math.*`.
- The judge also adds them silently when missing. This is safe for C, C++, Java, C# and Kotlin: adding a
  duplicate include or import is harmless. C also gets linked with the math library (`-lm`). Line numbers
  in errors are shifted back so they match the student's code.
- Go can't be done this way, because an unused import is a compile error. Go stays starter-code only.

**Input.** `input()` reads one whole line on every platform (HackerRank, Codeforces, CodeChef), so a loop
of `int(input())` can only read numbers that are one per line. The fix is guidance, not a change to Python:
- Starter code reads input the robust way: `data = sys.stdin.read().split()`, then an iterator. That works
  whether the numbers are on one line or several. Each language gets the same pattern.
- A hint line under the error, keyed on the error text. A `ValueError: invalid literal for int()` with spaces
  in the value gets: "input() reads a whole line. Use list(map(int, input().split())) for numbers on one line."
- A hint for prompts: if the output starts with the text passed to `input("...")`, show "Don't pass text to
  input(): it's printed and compared with the answer."

---

## For the exam portal (friend's changes)

These are changes in the portal's own editor and its judge client (`runOnJudge()` in `judge.js`). Our
API changes above help with no portal change needed. Everything else needs the portal.

| # | Change in the portal | Detail |
|---|---|---|
| P1 | **Language switch updates the starter code** (item 2) | **VERIFY** that changing the language dropdown replaces the editor content with that language's template, and keeps each language's draft separately so work isn't lost. Monaco's `defaultValue` and `defaultLanguage` only apply on first mount. Use the controlled `value` and `language` props, or give the editor a `key` per language. |
| P2 | **Templates that follow our rules** (items 2 and 4) | Java: `public class Main` (until E4 ships). Kotlin: top-level `fun main()`. C#: a single `Main`. Each template should already read the input in the usual way and print nothing else. Our stdin templates are in `frontend/src/utils/buildTemplate.js` (`STDIN_TEMPLATES`) and can be copied as they are. |
| P3 | **Show examples, input format, output format and constraints** (item 3) | Show the sample input and expected output for each question as examples, and say plainly: "Read from standard input. Print only the answer." |
| P4 | **Show the real reason** (item 1) | Map `status.id` to a message: 3 Accepted, 4 Wrong Answer, 5 Time Limit Exceeded, 6 Compilation Error (show `compile_output`), 11 Runtime Error (show `stderr`), 13 internal error ("Judge problem, try again", not the student's fault). Don't rely on `status.description` until E1 is deployed. Decode `stdout`, `stderr` and `compile_output` from base64 when `base64_encoded=true`. |
| P5 | **Output panel** (item 5) | Always show the decoded `stdout`, even for status 11 or 5. Show `stderr` separately and in a neutral style when the status is 3. For a wrong answer, show expected and actual output side by side. |
| P6 | **Custom input box** (item 4) | **VERIFY** that the stdin typed by the student is sent as is (multi-line, base64 encoded) and isn't trimmed or JSON-quoted. Add a trailing newline if there isn't one. |

| P7 | **Fuller starter code** (X1, X2, X6) | C++: `bits/stdc++.h`. C: the common headers. Python: read n and a list, with a comment saying what each line reads. |
| P8 | **Hints on common mistakes** (X4, X5) | The two Python hints above. Our API can return a `hint` field so the portal only has to display it. |
| P9 | **Explain the disabled Run button** (X8) | A tooltip such as "Edit the code to run it", or just keep Run enabled. |
| P10 | **Shorter error box** (X3) | Remove `/app/sub-raw-…/` from each line (we'll also do this in the API), make the box taller, and show the first `error:` line in bold above it. |
| P11 | **More samples and an explanation** (X7) | Two or three samples per question, including one edge case, with one line explaining the answer. |

**To make this concrete, ask the friend for 2 or 3 failing examples**: the language, the code, the input
and what the student saw. Then we can check them directly with `npm run loadtest`-style calls against
the testing stack.
