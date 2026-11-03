# Load test

A repeatable smoke and load test of the public judge API (`/api/codeAssess`), the same path
partner platforms use.

## One-time setup

1. Sign in as an admin or superadmin and open **System → API Keys** (`/admin/api-keys`).
2. Create a key named `loadtest` with the **codeAssess** scope and no limits. A superadmin
   picks the college that owns it; use **Add college** to make an internal "Load test"
   college if there is none.
3. Copy the key (it is shown once) into `loadtest/.env`:

   ```
   LOADTEST_KEY=ak_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   # optional, defaults to the testing stack
   LOADTEST_BASE=https://assess.fortifyhub.net/api/codeAssess
   ```

   `loadtest/.env` is gitignored. Keep the key for later runs; revoke it on the same page
   when it is no longer needed.

## Running

```bash
npm run loadtest -- smoke   # one run per language (12), checks every answer: does the deploy work?
npm run loadtest -- quick   # python + cpp at 1 and 10 concurrent, 20 s each (~2 min)
npm run loadtest -- full    # python, cpp, java at 1/10/20/40 concurrent, 45 s each (~13 min)

# any profile can be narrowed or widened
npm run loadtest -- full --langs=python,go --levels=5,50 --seconds=30
```

Each run is saved to `loadtest/results/` (gitignored) and compared with the previous run of the
same profile: throughput and median latency show the change in %. The exit code is non-zero if
any request failed, so `smoke` can gate a deploy.

## Reading the numbers

- **/min** is correct results per minute sustained at that concurrency (closed loop: each worker
  waits for its result before sending the next request).
- Throughput stops rising once the judge's CPU is saturated; past that, more concurrency only
  raises latency. On the 6-core testing server that happened around 20 concurrent for Python
  and 10 for C++ (October 2026).
- Programs are trivial (read a number, print twice it), so this measures judge overhead
  (queueing, containers, compile, start-up). Real submissions with many tests are heavier.
- Don't point `full` at a server people are using for an exam.
