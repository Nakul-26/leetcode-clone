# Coding editor: problems students reported, and the plan

**Written:** 2026-11-03. **Status:** plan only, nothing built yet.

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

**To make this concrete, ask the friend for 2 or 3 failing examples**: the language, the code, the input
and what the student saw. Then we can check them directly with `npm run loadtest`-style calls against
the testing stack.
