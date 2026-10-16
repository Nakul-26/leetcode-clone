#!/usr/bin/env node
/**
 * judge_contract_check.mjs — contract/regression harness for the judge's external API.
 *
 * Why this exists: the plan in docs/JUDGE_UNIFICATION_AND_SCALING_PLAN.md routes the
 * Judge0 shim through the queue and adds real tokens + a batch endpoint. The whole point
 * is that an external platform pointing JUDGE_URL at us should need little or no change.
 * The only way to be sure of that is to pin the *observable* behaviour now, before the
 * refactor, and diff against it after.
 *
 * Record a baseline today, re-run after each phase, diff. Any difference is either an
 * intended improvement you accept into the baseline, or a break in the public contract.
 *
 * Two targets, because they are two different contracts:
 *   --target shim  the PUBLIC Judge0-compatible surface an external platform calls
 *                  (assessment-api  POST /api/codeAssess/submissions). This is the one
 *                  that must not break.
 *   --target raw   judge-service-go's internal POST /raw-run. Useful for isolating
 *                  whether a change came from the judge or from assessment-api.
 *
 * Usage:
 *   node scripts/judge_contract_check.mjs --target shim --record
 *   node scripts/judge_contract_check.mjs --target shim
 *   node scripts/judge_contract_check.mjs --target raw --filter cpp
 *   node scripts/judge_contract_check.mjs --target shim --repeat 60 --concurrency 8
 *
 * Safety: refuses any non-local host unless --allow-remote is passed explicitly, so a
 * stray run cannot load-test production.
 */

const DEFAULTS = {
  raw: "http://localhost:8081",
  shim: "http://localhost:5000",
};

// Judge0 status ids, mirroring CODEASSESS_STATUS in
// assessment-api/src/services/codeAssessShim.service.js. 1/2 are Judge0's own
// In Queue / Processing — not produced today (the shim is synchronous), but the poll
// loop below handles them so this script keeps working unchanged once the shim is
// queue-backed (plan Phase 2).
const STATUS = { IN_QUEUE: 1, PROCESSING: 2, ACCEPTED: 3, TLE: 5, COMPILE_ERROR: 6, RUNTIME_ERROR: 11, INTERNAL_ERROR: 13 };

// Judge0 language ids -> our language slugs. Mirrors LANGUAGE_ID_MAP in the shim service.
const LANG = {
  cpp: { id: 54, slug: "cpp" },
  java: { id: 62, slug: "java" },
  python: { id: 71, slug: "python" },
};

// ---------------------------------------------------------------------------
// Fixtures. Deliberately small and fast: this is a contract check, not a
// benchmark of student code. C++ and Java first since those dominate real usage.
// ---------------------------------------------------------------------------
const SOURCES = {
  sumTwo: {
    cpp: `#include <bits/stdc++.h>
int main(){long long a,b; if(!(std::cin>>a>>b)) return 0; std::cout<<a+b<<std::endl; return 0;}`,
    java: `import java.util.*;
public class Main{public static void main(String[] a){Scanner s=new Scanner(System.in); if(!s.hasNextLong())return; long x=s.nextLong(),y=s.nextLong(); System.out.println(x+y);}}`,
    python: `import sys
d=sys.stdin.read().split()
if len(d)>=2: print(int(d[0])+int(d[1]))`,
  },
  echoLines: {
    cpp: `#include <bits/stdc++.h>
int main(){std::string l; while(std::getline(std::cin,l)) std::cout<<l<<"\\n"; return 0;}`,
    java: `import java.io.*;
public class Main{public static void main(String[] a) throws IOException{BufferedReader r=new BufferedReader(new InputStreamReader(System.in));String l;StringBuilder b=new StringBuilder();while((l=r.readLine())!=null)b.append(l).append("\\n");System.out.print(b);}}`,
    python: `import sys
sys.stdout.write(sys.stdin.read())`,
  },
  // The empty-stdin case. Found during the placement-question review: with stdin as a
  // single newline every language is fine, but at immediate EOF Python/Java raise while
  // C++ silently succeeds. Pinned here so that divergence can never change unnoticed.
  readOneLine: {
    cpp: `#include <bits/stdc++.h>
int main(){std::string s; std::getline(std::cin,s); std::cout<<"["<<s<<"]"<<std::endl; return 0;}`,
    java: `import java.io.*;
public class Main{public static void main(String[] a) throws IOException{BufferedReader r=new BufferedReader(new InputStreamReader(System.in));String s=r.readLine();System.out.println("["+(s==null?"":s)+"]");}}`,
    python: `import sys
s=sys.stdin.readline().rstrip("\\n")
print("["+s+"]")`,
  },
  compileError: {
    cpp: `int main(){ this is not valid c++ }`,
    java: `public class Main{ public static void main(String[] a){ int x = ; } }`,
    python: `def f(:\n  pass`, // SyntaxError — surfaces at run time for Python, not compile
  },
  runtimeError: {
    cpp: `#include <bits/stdc++.h>
int main(){std::vector<int> v; std::cout<<v.at(5)<<std::endl; return 0;}`,
    java: `public class Main{public static void main(String[] a){int[] x=new int[1]; System.out.println(x[5]);}}`,
    python: `raise ValueError("boom")`,
  },
  infiniteLoop: {
    cpp: `int main(){ volatile long long i=0; while(1){i++;} }`,
    java: `public class Main{public static void main(String[] a){long i=0; while(true){i++;}}}`,
    python: `
i=0
while True: i+=1`,
  },
};

function fixtures() {
  const out = [];
  for (const lang of Object.keys(LANG)) {
    out.push(
      { id: `${lang}/accepted-sum`, lang, source: SOURCES.sumTwo[lang], stdin: "2 3\n", timeoutMs: 5000 },
      { id: `${lang}/multiline-echo`, lang, source: SOURCES.echoLines[lang], stdin: "alpha\nbeta\ngamma\n", timeoutMs: 5000 },
      { id: `${lang}/stdin-one-newline`, lang, source: SOURCES.readOneLine[lang], stdin: "\n", timeoutMs: 5000 },
      { id: `${lang}/stdin-empty-eof`, lang, source: SOURCES.readOneLine[lang], stdin: "", timeoutMs: 5000 },
      { id: `${lang}/compile-error`, lang, source: SOURCES.compileError[lang], stdin: "", timeoutMs: 5000 },
      { id: `${lang}/runtime-error`, lang, source: SOURCES.runtimeError[lang], stdin: "", timeoutMs: 5000 },
      { id: `${lang}/timeout`, lang, source: SOURCES.infiniteLoop[lang], stdin: "", timeoutMs: 2000 },
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalisation. Everything volatile between two otherwise-identical runs is
// stripped, so a diff only ever shows a real behavioural change.
// ---------------------------------------------------------------------------
function normalizeText(s) {
  if (s == null) return "";
  return String(s)
    .replace(/\r\n/g, "\n")
    .replace(/\/app\/sub-[A-Za-z0-9._-]+/g, "/app/<sub>")
    .replace(/\/tmp\/[A-Za-z0-9._-]+/g, "/tmp/<tmp>")
    .replace(/0x[0-9a-fA-F]+/g, "0x<addr>")
    .replace(/\b\d+\.\d+s\b/g, "<dur>")
    .replace(/[ \t]+$/gm, "")
    .trimEnd();
}

function b64(s) { return Buffer.from(s ?? "", "utf8").toString("base64"); }
function unb64(s) { return s == null ? "" : Buffer.from(String(s), "base64").toString("utf8"); }

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------
async function callRaw(base, fx, httpTimeoutMs) {
  const res = await fetchJson(`${base}/raw-run`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({
      language: LANG[fx.lang].slug,
      code: fx.source,
      stdin: fx.stdin,
      timeoutMs: fx.timeoutMs,
      memoryLimitMb: 256,
    }),
  }, httpTimeoutMs);

  if (!res.ok) return { transportError: `HTTP ${res.status}`, body: normalizeText(res.text).slice(0, 300) };
  const j = res.json ?? {};
  return {
    stdout: normalizeText(j.stdout),
    stderrEmpty: !normalizeText(j.stderr),
    compileOutputEmpty: !normalizeText(j.compileOutput),
    exitCode: j.exitCode,
    timedOut: !!j.timedOut,
    oomKilled: !!j.oomKilled,
    compileError: !!j.compileError,
    error: j.error ? normalizeText(j.error) : undefined,
  };
}

async function callShim(base, key, fx, httpTimeoutMs) {
  const url = `${base}/api/codeAssess/submissions?base64_encoded=true&wait=true`;
  const res = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rapidapi-key": key, connection: "close" },
    body: JSON.stringify({
      language_id: LANG[fx.lang].id,
      source_code: b64(fx.source),
      stdin: b64(fx.stdin),
      cpu_time_limit: Math.ceil(fx.timeoutMs / 1000),
      wall_time_limit: Math.ceil(fx.timeoutMs / 1000),
      memory_limit: 256 * 1024,
    }),
  }, httpTimeoutMs);

  if (!res.ok) return { transportError: `HTTP ${res.status}`, body: normalizeText(res.text).slice(0, 300) };
  let j = res.json ?? {};

  // Forward-compatibility with plan Phase 2: once the shim is queue-backed it may answer
  // In Queue/Processing instead of a finished result. Poll the token exactly as a real
  // Judge0 client would, so this script needs no edit when that lands.
  let statusId = j?.status?.id;
  if ((statusId === STATUS.IN_QUEUE || statusId === STATUS.PROCESSING) && j.token) {
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const p = await fetchJson(`${base}/api/codeAssess/submissions/${encodeURIComponent(j.token)}?base64_encoded=true`,
        { headers: { "x-rapidapi-key": key, connection: "close" } }, httpTimeoutMs);
      if (!p.ok) break;
      j = p.json ?? j;
      statusId = j?.status?.id;
      if (statusId !== STATUS.IN_QUEUE && statusId !== STATUS.PROCESSING) break;
    }
  }

  return {
    statusId,
    stdout: normalizeText(unb64(j.stdout)),
    stderrEmpty: !normalizeText(unb64(j.stderr)),
    compileOutputEmpty: !normalizeText(unb64(j.compile_output)),
    exitCode: j.exit_code,
    // token/time/memory are deliberately excluded: volatile by nature, and the token
    // format is expected to change in Phase 2 (fabricated -> real submission id).
    tokenPresent: !!j.token,
  };
}

async function fetchJson(url, init, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { /* non-JSON body kept as text */ }
    return { ok: r.ok, status: r.status, text, json };
  } catch (e) {
    return { ok: false, status: 0, text: `${e.name}: ${e.message}` };
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = { target: "shim", record: false, filter: null, repeat: 0, concurrency: 1, allowRemote: false, httpTimeoutMs: 120000 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--target") a.target = v();
    else if (k === "--base") a.base = v();
    else if (k === "--key") a.key = v();
    else if (k === "--baseline") a.baseline = v();
    else if (k === "--filter") a.filter = v();
    else if (k === "--repeat") a.repeat = Number(v());
    else if (k === "--concurrency") a.concurrency = Number(v());
    else if (k === "--http-timeout-ms") a.httpTimeoutMs = Number(v());
    else if (k === "--record") a.record = true;
    else if (k === "--allow-remote") a.allowRemote = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else { console.error(`Unknown argument: ${k}`); process.exit(2); }
  }
  return a;
}

function assertLocal(base, allowRemote) {
  let host;
  try { host = new URL(base).hostname; } catch { console.error(`Invalid --base: ${base}`); process.exit(2); }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || host.endsWith(".localhost") || host.endsWith(".test");
  if (!local && !allowRemote) {
    console.error(
      `\nRefusing to run against non-local host "${host}".\n` +
      `This harness compiles and executes code and can be run in load mode, so pointing it\n` +
      `at a live deployment can affect real users. Re-run with --allow-remote if you are\n` +
      `certain the target is not production.\n`);
    process.exit(2);
  }
  if (!local) console.error(`WARNING: running against remote host "${host}" (--allow-remote given).\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(headerHelp()); return; }

  const target = args.target;
  if (!["raw", "shim"].includes(target)) { console.error(`--target must be "raw" or "shim"`); process.exit(2); }

  const base = (args.base || process.env.JUDGE_CONTRACT_BASE || DEFAULTS[target]).replace(/\/+$/, "");
  assertLocal(base, args.allowRemote);

  const key = args.key || process.env.CODEASSESS_SHIM_KEY || "codeassess_shim_secret";
  if (target === "shim" && !key) { console.error("shim target needs --key or CODEASSESS_SHIM_KEY"); process.exit(2); }

  const run = (fx) => (target === "raw" ? callRaw(base, fx, args.httpTimeoutMs) : callShim(base, key, fx, args.httpTimeoutMs));

  let list = fixtures();
  if (args.filter) list = list.filter((f) => f.id.includes(args.filter));
  if (list.length === 0) { console.error(`No fixtures matched --filter ${args.filter}`); process.exit(2); }

  if (args.repeat > 0) return loadMode(run, list, args);

  console.log(`target=${target} base=${base} fixtures=${list.length}\n`);
  const results = {};
  for (const fx of list) {
    const t0 = Date.now();
    results[fx.id] = await run(fx);
    console.log(`  ran ${fx.id.padEnd(28)} ${String(Date.now() - t0).padStart(6)}ms`);
  }

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const baselinePath = args.baseline || path.join("scripts", "tests", `judge-contract-baseline.${target}.json`);

  if (args.record) {
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(baselinePath, JSON.stringify(results, null, 2) + "\n", "utf8");
    console.log(`\nBaseline written: ${baselinePath}`);
    console.log(`Commit it, then re-run without --record after each change to diff.`);
    return;
  }

  let baseline;
  try { baseline = JSON.parse(await fs.readFile(baselinePath, "utf8")); }
  catch { console.error(`\nNo baseline at ${baselinePath}. Create one first:\n  node scripts/judge_contract_check.mjs --target ${target} --record\n`); process.exit(2); }

  let diffs = 0;
  console.log("");
  for (const id of Object.keys(results)) {
    const got = JSON.stringify(results[id]);
    const want = JSON.stringify(baseline[id]);
    if (want === undefined) { console.log(`NEW   ${id}  (not in baseline)`); diffs++; continue; }
    if (got !== want) {
      diffs++;
      console.log(`DIFF  ${id}`);
      console.log(`        baseline: ${want}`);
      console.log(`        current : ${got}`);
    } else {
      console.log(`ok    ${id}`);
    }
  }
  for (const id of Object.keys(baseline)) {
    if (!(id in results)) { console.log(`GONE  ${id}  (in baseline, not produced now)`); diffs++; }
  }

  console.log(`\n${Object.keys(results).length} fixtures, ${diffs} difference(s)`);
  // Set exitCode rather than calling process.exit(): exiting while fetch sockets are
  // still tearing down trips a libuv assertion on Windows and reports 127 instead of
  // the real result, which would quietly break any CI check on this script.
  process.exitCode = diffs === 0 ? 0 : 1;
}

async function loadMode(run, list, args) {
  const total = args.repeat;
  const conc = Math.max(1, args.concurrency);
  console.log(`LOAD MODE  requests=${total} concurrency=${conc} fixtures=${list.length}\n`);

  const lat = [];
  let done = 0, failed = 0, next = 0;
  const started = Date.now();

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const fx = list[i % list.length];
      const t0 = Date.now();
      const r = await run(fx);
      lat.push(Date.now() - t0);
      if (r.transportError) failed++;
      if (++done % 10 === 0) process.stdout.write(`  ${done}/${total}\r`);
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));

  const wall = (Date.now() - started) / 1000;
  lat.sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))];
  console.log(`\n  wall          ${wall.toFixed(1)}s`);
  console.log(`  throughput    ${(total / wall).toFixed(2)} req/s`);
  console.log(`  failed        ${failed}`);
  console.log(`  p50 / p95     ${pct(50)}ms / ${pct(95)}ms`);
  console.log(`  min / max     ${lat[0]}ms / ${lat[lat.length - 1]}ms`);
  console.log(`\nNote: fixtures include a deliberate timeout case, so p95 is expected to sit`);
  console.log(`near the configured time limit. Use --filter accepted for a clean latency read.`);
}

function headerHelp() {
  return `judge_contract_check.mjs — pin and diff the judge's external API behaviour

  --target raw|shim        which contract to exercise (default: shim)
  --base <url>             default: shim ${DEFAULTS.shim}, raw ${DEFAULTS.raw}
  --key <key>              shim only; or CODEASSESS_SHIM_KEY
  --record                 write the baseline instead of diffing
  --baseline <path>        default scripts/tests/judge-contract-baseline.<target>.json
  --filter <substr>        run only fixtures whose id contains <substr>
  --repeat N               load mode: send N requests
  --concurrency C          load mode: C in flight (default 1)
  --http-timeout-ms N      per-request timeout (default 120000)
  --allow-remote           required for any non-local --base
`;
}

main().catch((e) => { console.error(e); process.exit(1); });
