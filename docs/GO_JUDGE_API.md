# GO Judge API Reference

GO Judge compiles and runs source code in an isolated sandbox and returns what the program
printed. This document is for developers who send code to GO Judge from their own platform.

**You do not need any other part of the Placement Assessment Platform to use it.** If you want the
full platform (assessments, student accounts, proctoring, results), see
[`CLIENT_ONBOARDING.md`](./CLIENT_ONBOARDING.md).

- [Quick start](#quick-start)
- [Concepts you need first](#concepts-you-need-first)
- [Authentication](#authentication)
- [Run one program](#run-one-program)
- [Run many test cases (batch)](#run-many-test-cases-batch)
- [Check or generate test cases](#check-or-generate-test-cases)
- [Reading results](#reading-results)
- [Languages](#languages)
- [Limits](#limits)
- [Errors and retries](#errors-and-retries)
- [Best practices](#best-practices)
- [Examples](#examples)

---

## Quick start

You will be given a **base URL** and an **API key** (`ak_...`). Replace `BASE` and `KEY` below.

```bash
BASE=https://<your-go-judge-host>/api/codeAssess
KEY=ak_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

curl -s -X POST "$BASE/submissions?base64_encoded=true&wait=true" \
  -H "x-rapidapi-key: $KEY" -H "Content-Type: application/json" \
  -d '{
        "language_id": 71,
        "source_code": "'"$(printf 'print(int(input()) * 2)' | base64 -w0)"'",
        "stdin":       "'"$(printf '21\n' | base64 -w0)"'"
      }'
```

The response contains `stdout` (base64) and a `status`. `stdout` decodes to `42`.

The same API is also available under `/api/v1/codeAssess`. Use whichever your operator tells you to.

---

## Concepts you need first

1. **GO Judge runs; it does not judge.** You send source code and an input (`stdin`). You get back
   what the program printed. GO Judge does **not** compare the output with an expected answer: you do
   that on your side. Status `3 Accepted` therefore means *"the program ran to completion and exited
   normally"*, **not** *"the answer is correct"*. Any `expected_output` field you send is ignored.

2. **Inputs can be plain or base64, but outputs are always base64.**
   `base64_encoded=true` (the default) means your `source_code` and `stdin` are base64.
   `base64_encoded=false` means they are plain strings. Either way, `stdout`, `stderr` and
   `compile_output` in the **response are always base64-encoded**. This is the single most common
   integration mistake.

3. **A request may finish later than your HTTP call.** `wait=true` holds the request open for up to
   **25 seconds**. If the run is not finished by then you get the *same* response shape back with a
   `status.id` of `1` (In Queue) or `2` (Processing) and `null` outputs. Keep the `token` and poll for
   it. Always handle this case.

4. **Quotas count test cases, not requests.** Sending six test cases in one batch uses six units of
   your quota, exactly like six single requests, but costs far less to run (see
   [batch](#run-many-test-cases-batch)).

---

## Authentication

Send your key in the `x-rapidapi-key` header on every request.

```
x-rapidapi-key: ak_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

(The header name is historical. It has nothing to do with RapidAPI.)

- Treat the key like a password. Do not put it in browser code, mobile apps or source control.
  Call GO Judge from your **server**.
- A missing, wrong or revoked key all return the same `401 {"error":"Unauthorized"}`.
- Keys are tied to your organisation and can be revoked or replaced at any time. Ask your operator
  to issue a new one before you revoke the old one, so there is no gap.

---

## Run one program

`POST {BASE}/submissions`

### Query parameters

| Parameter | Default | Meaning |
|---|---|---|
| `base64_encoded` | `true` | `false` if `source_code` and `stdin` are plain text |
| `wait` | not set | `true` to hold the request open (up to 25 s) and return the result |

### Body (JSON)

| Field | Required | Meaning |
|---|---|---|
| `language_id` | yes | A number from the [languages table](#languages) |
| `source_code` | yes | The program. At most **200 KB** |
| `stdin` | no | Text fed to the program's standard input |
| `cpu_time_limit` | no | Seconds. Maximum 60. Default 10 |
| `wall_time_limit` | no | Seconds. Maximum 60. If both are given, this one wins |
| `memory_limit` | no | **Kilobytes**. Maximum 2,097,152 (2 GB) |

Any other field is ignored.

### Responses

| Situation | Status | Body |
|---|---|---|
| `wait=true`, finished or not | `200` | a [result](#reading-results) |
| no `wait` | `201` | `{ "token": "..." }` |
| missing `language_id` / `source_code` | `400` | `{ "error": "..." }` |
| unknown `language_id` | `400` | `{ "error": "Unsupported language_id: 99" }` |
| source over 200 KB | `413` | `{ "error": "...", "code": "source_too_large" }` |

### Fetch a result later

`GET {BASE}/submissions/{token}` returns the same result object (`200`), or
`404 {"error":"Submission not found"}` if the token is unknown, belongs to another account, or is
older than **24 hours**. Results are kept for 24 hours and then deleted.

---

## Run many test cases (batch)

If you run the same program against several inputs (the normal case when grading), send them as
**one batch**. GO Judge compiles the program **once** and runs it once per input, instead of
compiling it again for every request.

Measured on GO Judge itself with six test cases and identical results:

| Language | Six separate requests | One batch | Faster by |
|---|---|---|---|
| C++ | 15.6 s | 4.4 s | **3.6x** |
| Java | 11.0 s | 3.2 s | **3.4x** |
| Python | 2.9 s | 2.4 s | 1.2x (nothing to compile) |

### Submit

`POST {BASE}/submissions/batch?base64_encoded=true`

```json
{
  "submissions": [
    { "language_id": 54, "source_code": "<base64>", "stdin": "<base64>" },
    { "language_id": 54, "source_code": "<base64>", "stdin": "<base64>" }
  ]
}
```

- Up to **20** items per batch. More is `422`.
- Items that have the **same language, source and limits** are run together and compiled once.
  Different programs in one batch are fine; they simply are not combined.
- Answers `201` with an array of the same length **in the same order**. Each entry is
  `{ "token": "..." }` or `{ "error": "..." }`. **Match results to inputs by position.** One bad item
  does not reject the others.
- Tokens of items that ran together look like `<id>.0`, `<id>.1`. Treat tokens as opaque strings.
- A batch does **not** support `wait`. Poll for it.
- Admitted or refused as a whole against your quota, in test cases.

### Poll

`GET {BASE}/submissions/batch?tokens=tokenA,tokenB,tokenC` (up to 20 tokens) answers

```json
{ "submissions": [ { ...result for tokenA... }, { ...result for tokenB... }, null ] }
```

in the order you asked. An unknown, expired or foreign token is `null`. Poll until every entry has a
`status.id` other than `1` or `2`.

### Reading a coalesced group

- A **compile error** is reported on **every** item of the group (they share one source), each with
  the same `compile_output`.
- A **timeout or crash** is reported only on the test case that caused it. Its neighbours keep
  their own results.

---

## Check or generate test cases

When you write a question, a wrong expected output fails every correct student. These two endpoints
take **your reference solution** and the test inputs, run the solution, and tell you what it prints.
Use them while creating or editing a question, before students see it.

**Nothing is stored.** Your reference solution and test cases are run and then discarded; they stay on
your platform.

| Endpoint | Use it to |
|---|---|
| `POST {BASE}/test-cases/generate?base64_encoded=true` | Get the expected output for each input. Any `expected_output` you send is ignored. |
| `POST {BASE}/test-cases/check?base64_encoded=true` | Find out whether the expected outputs you already have are correct. |

### Request

```json
{
  "language_id": 54,
  "source_code": "<base64 reference solution>",
  "test_cases": [
    { "stdin": "<base64>", "expected_output": "<base64>" },
    { "stdin": "<base64>" }
  ],
  "cpu_time_limit": 2,
  "memory_limit": 262144
}
```

- Same authentication, `language_id` values and base64 rules as `/submissions`. With
  `base64_encoded=false`, send and receive plain text instead.
- Up to **100** test cases per request. More is `422`.
- `expected_output` is optional on `check`: a case without one is just run and its output returned.
- `cpu_time_limit` (seconds) and `memory_limit` (KB) are optional. **Send the limits your students
  will get**: a reference solution that is too slow then shows up as a time limit failure here, not
  as a test case no student can pass.
- Counted against your quota like a run: one unit per test case.

### Response `200`

```json
{
  "compile_error": false,
  "compile_output": null,
  "all_match": false,
  "summary": { "total": 3, "matched": 1, "mismatched": 1, "generated": 1, "failed": 0 },
  "results": [
    { "index": 0, "status": { "id": 3, "description": "Accepted" }, "actual_output": "<base64>", "expected_output": "<base64>", "match": true,  "exact_match": false, "error": null, "stderr": "", "time": "0.012" },
    { "index": 1, "status": { "id": 3, "description": "Accepted" }, "actual_output": "<base64>", "expected_output": "<base64>", "match": false, "exact_match": false, "error": null, "stderr": "", "time": "0.011" },
    { "index": 2, "status": { "id": 3, "description": "Accepted" }, "actual_output": "<base64>", "expected_output": null,       "match": null,  "exact_match": null,  "error": null, "stderr": "", "time": "0.010" }
  ]
}
```

- `results` are in the same order as `test_cases`; `index` is the position.
- `actual_output` is what your reference solution printed. On `generate`, this is your expected output.
- `match` uses the same rule GO Judge uses for stdin problems: the outputs are equal **after trailing
  spaces, tabs and newlines are removed**. `exact_match` compares byte for byte, for platforms that
  compare that way. `null` when you sent no expected output.
- `all_match` is `true` only when every case had an expected output and every one is correct. Use it
  as the "safe to publish" check.
- If the reference solution fails on an input, that case has `status` 5 (time limit) or 11 (runtime
  error), `actual_output: null`, `match: false` when an expected output was sent, and the reason in
  `error` and `stderr`. Usually the input breaks the problem's constraints, or the solution is wrong.
- If the reference solution does not compile: `compile_error: true`, `status.id` 6, the compiler
  message in `compile_output`, and `results` is empty.

### Example: check a question before publishing it (Node.js)

```js
const b64 = (s) => Buffer.from(s).toString("base64");
const unb64 = (s) => (s == null ? s : Buffer.from(s, "base64").toString("utf8"));

const res = await fetch(`${BASE}/test-cases/check?base64_encoded=true`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-rapidapi-key": API_KEY },
  body: JSON.stringify({
    language_id: question.referenceLanguageId,
    source_code: b64(question.referenceSolution),
    test_cases: question.testCases.map((t) => ({ stdin: b64(t.input), expected_output: b64(t.output) })),
    cpu_time_limit: question.timeLimitSec,
    memory_limit: question.memoryLimitKb
  })
});
const report = await res.json();
if (report.compile_error) throw new Error(unb64(report.compile_output));
for (const r of report.results.filter((r) => r.match === false)) {
  console.log(`Test ${r.index + 1}: expected ${JSON.stringify(unb64(r.expected_output))}, ` +
              `the reference solution prints ${JSON.stringify(unb64(r.actual_output))} ${r.error || ""}`);
}
if (!report.all_match) throw new Error("Fix the test cases above before publishing");
```

To **fill in** outputs instead, call `/test-cases/generate` with only `stdin` in each case and store
each `actual_output` as that case's expected output.

---

## Reading results

```json
{
  "token": "6ad202380e1e9c13ef76b32f.1",
  "stdout": "NDIK",
  "stderr": "",
  "compile_output": "",
  "status": { "id": 3, "description": "Accepted" },
  "time": 0.04,
  "memory": 0,
  "exit_code": 0,
  "exit_signal": null
}
```

| Field | Meaning |
|---|---|
| `stdout`, `stderr`, `compile_output` | **base64** text. `null` while the run is not finished |
| `status.id` | See below |
| `time` | Seconds of wall-clock time the run took, including process start-up. `null` while pending |
| `memory` | Not measured, so `0`. After an out-of-memory kill it is reported as the sandbox limit |
| `exit_code` | The program's exit code. `-1` when the program never ran to an exit (compile error, timeout) |
| `exit_signal` | Always `null` |

### Status

| `status.id` | Meaning | What to do |
|---|---|---|
| `1` | In Queue | Not finished. Poll again |
| `2` | Processing | Not finished. Poll again |
| `3` | Accepted | The program ran and exited with code 0. **Compare `stdout` yourself** |
| `5` | Time Limit Exceeded | Killed for running too long |
| `6` | Compilation Error | Read `compile_output` |
| `11` | Runtime Error | The program crashed, exited non-zero, or was killed for using too much memory. Read `stderr` and `exit_code` |
| `13` | Internal Error | GO Judge failed, not your program. Safe to retry; report it if it repeats |

While status is `1` or `2` every output field is `null`. Decode defensively: a client that base64-decodes
`null` without checking will throw.

---

## Languages

| `language_id` | Language | Requirements on your program |
|---|---|---|
| 71 | Python | |
| 63 | JavaScript (Node.js) | |
| 74 | TypeScript | |
| 54 | C++ | Compiled with `-O2` |
| 50 | C | Compiled with `-O2` |
| 62 | Java | The class must be `public class Main` |
| 78 | Kotlin | A single file with a top-level `fun main()` |
| 51 | C# | One entry point, in a single file |
| 60 | Go | `package main` with `func main()` |
| 73 | Rust | Compiled with `-O`, edition 2021 |
| 72 | Ruby | |
| 68 | PHP | |

- Your source is compiled and run **exactly as sent**. Nothing is rewritten or "unescaped".
- Programs have **no network access**, and each run gets its own working directory.
- Heavy toolchains (C#, Kotlin, Rust, Go) take several seconds to compile. That is normal.
- C and C++ are optimised (`-O2`). Code with undefined behaviour (uninitialised variables,
  out-of-bounds reads, signed overflow) can print different results than it would unoptimised.

---

## Limits

| Limit | Value |
|---|---|
| Source size | 200 KB |
| Request body | 2 MB |
| Time per test case | 10 s default, 60 s maximum |
| Memory | 2 GB maximum (`memory_limit` is in KB) |
| Batch size | 20 items |
| Result retention | 24 hours |
| `wait=true` | holds up to 25 s, then returns `status.id` 1 or 2 |

### Your quota

Each API key has two optional limits, set when it is issued (ask your operator for yours or to change
them):

- **Per minute**: how many test cases you can start in any one-minute window.
- **Per month**: how many test cases you can run in a calendar month (UTC).

Both are counted in **test cases**. A request that would exceed either is refused **before** anything
runs, and nothing is charged for it.

A coarse per-IP safety limit also applies. It is set high enough that normal use never reaches it.

---

## Errors and retries

| Status | Meaning | Retry? |
|---|---|---|
| `400` | Malformed request | No. Fix the request |
| `401` | Missing, wrong or revoked key | No |
| `403` | Batch endpoints need an API key issued by your operator | No. Contact your operator |
| `404` | Unknown, foreign or expired token | No |
| `413` | Source over 200 KB | No |
| `422` | Batch too large, or **one request alone is bigger than your per-minute limit** | No. Send fewer per request |
| `429` | Over your per-minute or per-month quota | **Yes, after `Retry-After` seconds** |
| `503` | Queue full or temporarily unavailable | Yes, with backoff |
| `5xx` | Server error | Yes, with backoff |

### 429

```
HTTP/1.1 429 Too Many Requests
Retry-After: 38

{ "error": "Rate limit of 6 test cases per minute exceeded.", "code": "rate_limited" }
```

`code` is `rate_limited` (wait `Retry-After` seconds, usually under a minute) or
`monthly_quota_exceeded` (`Retry-After` is the time until the month rolls over; ask your operator for
more quota). Always wait the full `Retry-After`. **Do not fail a student's submission because of a
429; wait and retry.**

A `422` with `"code": "exceeds_rate_limit"` means a single request holds more test cases than your
whole per-minute allowance, so waiting can never help. Send fewer cases per request.

### Retrying safely

There is no idempotency key. If a `POST` times out on your side, GO Judge may still have run it, and a
retry runs it again and counts it again. For a timed-out `POST`, prefer to retry; for a timed-out
`GET`, retry freely, since reads never change anything.

---

## Best practices

1. **Batch your test cases.** One batch per program, not one request per test case.
2. **Compare outputs yourself**, and decide how strict to be about trailing whitespace and line
   endings. GO Judge returns the program's output exactly as it was printed.
3. **Poll politely.** Start at about 200 ms and back off towards 1 s. Stop after a sensible bound
   (for example 60 s) and treat it as a failure you can retry.
4. **Use `wait=true` for interactive "Run" buttons** and a batch plus polling for grading.
5. **Handle `null` and `1`/`2` everywhere** before decoding.
6. **Keep keys on your server**, and rotate them if they may have leaked.
7. **Limit your own concurrency.** The sandbox is CPU-bound. Throughput stops improving after a few
   concurrent compile-heavy runs, and past that point only latency gets worse.

---

## Examples

### Node.js: run one program

```js
const BASE = process.env.GOJUDGE_BASE;   // https://<host>/api/codeAssess
const KEY = process.env.GOJUDGE_KEY;

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s) => (s == null ? "" : Buffer.from(s, "base64").toString("utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "x-rapidapi-key": KEY, "content-type": "application/json", ...init.headers },
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") || 5);
    await sleep(wait * 1000);                       // wait the full time, then try again
    return api(path, init);
  }
  if (!res.ok) throw new Error(`GO Judge ${res.status}: ${await res.text()}`);
  return res.json();
}

async function run(languageId, source, stdin) {
  let r = await api("/submissions?base64_encoded=true&wait=true", {
    method: "POST",
    body: JSON.stringify({ language_id: languageId, source_code: b64(source), stdin: b64(stdin) }),
  });
  // wait=true can return before the run finishes. Poll with the token.
  for (let i = 0; r.status.id <= 2 && i < 120; i++) {
    await sleep(500);
    r = await api(`/submissions/${r.token}`);
  }
  return { status: r.status, stdout: unb64(r.stdout), stderr: unb64(r.stderr), compile: unb64(r.compile_output) };
}

console.log(await run(71, "print(int(input()) * 2)", "21\n"));
```

### Node.js: grade one program against several test cases

```js
async function grade(languageId, source, cases) {            // cases: [{ input, expected }]
  const created = await api("/submissions/batch?base64_encoded=true", {
    method: "POST",
    body: JSON.stringify({
      submissions: cases.map((c) => ({ language_id: languageId, source_code: b64(source), stdin: b64(c.input) })),
    }),
  });
  const tokens = created.map((c) => c.token);               // same order as `cases`
  if (created.some((c) => c.error)) throw new Error(created.find((c) => c.error).error);

  let results;
  for (let i = 0; i < 120; i++) {
    ({ submissions: results } = await api(`/submissions/batch?tokens=${tokens.join(",")}`));
    if (results.every((r) => r && r.status.id > 2)) break;
    await sleep(300);
  }
  return results.map((r, i) => ({
    passed: r.status.id === 3 && unb64(r.stdout).trim() === cases[i].expected.trim(),
    status: r.status.description,
  }));
}
```

### curl: batch and poll

```bash
# Write the program to a file first (the quoted 'EOF' keeps the \n exactly as typed),
# then base64 it. On macOS use:  base64 < prog.cpp | tr -d '\n'
cat > prog.cpp <<'EOF'
#include <iostream>
int main() { long long a, b; std::cin >> a >> b; std::cout << a * b << "\n"; }
EOF
SRC=$(base64 -w0 < prog.cpp)
IN1=$(printf '2 3\n' | base64 -w0); IN2=$(printf '4 5\n' | base64 -w0)

curl -s -X POST "$BASE/submissions/batch?base64_encoded=true" \
  -H "x-rapidapi-key: $KEY" -H "Content-Type: application/json" \
  -d "{\"submissions\":[
        {\"language_id\":54,\"source_code\":\"$SRC\",\"stdin\":\"$IN1\"},
        {\"language_id\":54,\"source_code\":\"$SRC\",\"stdin\":\"$IN2\"}]}"
# -> [{"token":"<id>.0"},{"token":"<id>.1"}]

curl -s "$BASE/submissions/batch?tokens=<id>.0,<id>.1" -H "x-rapidapi-key: $KEY"
```

---

## Changes to this API

This document describes the current behaviour. Fields are only ever **added**; existing fields keep
their meaning. Operators announce changes that could affect an integration in advance.

- **2026-10-24:** added `POST /test-cases/generate` and `POST /test-cases/check`, for authoring test cases with your own reference solution.
