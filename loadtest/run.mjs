#!/usr/bin/env node
// Repeatable smoke and load test for the public judge API (/api/codeAssess).
//
//   npm run loadtest -- smoke            one run per language, checks the output is right
//   npm run loadtest -- quick            python + cpp at 1 and 10 concurrent, 20 s each (~2 min)
//   npm run loadtest -- full             python, cpp, java at 1/10/20/40 concurrent, 45 s each (~13 min)
//   npm run loadtest -- full --langs=python,go --levels=5,50 --seconds=30
//
// Reads LOADTEST_KEY (and optionally LOADTEST_BASE) from loadtest/.env or the environment.
// Every run is saved to loadtest/results/ and compared with the previous run of the same
// profile, so before/after numbers for a change are one command each. Closed loop: each
// "concurrent" worker sends a request, waits for its result, then sends the next, so
// throughput at a level is what the judge sustains with that many requests in flight.
// No dependencies: Node 18+ (global fetch).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(DIR, "results");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadEnvFile(path.join(DIR, ".env"));

// Each program reads one number and prints twice it, so every result can be checked.
const PROGRAMS = {
  python: { id: 71, src: "n = int(input())\nprint(n * 2)\n" },
  javascript: { id: 63, src: "const n = Number(require('fs').readFileSync(0, 'utf8').trim());\nconsole.log(n * 2);\n" },
  typescript: { id: 74, src: "import { readFileSync } from 'fs';\nconst n: number = Number(readFileSync(0, 'utf8').trim());\nconsole.log(n * 2);\n" },
  java: { id: 62, src: "import java.util.*;\npublic class Main {\n  public static void main(String[] a) {\n    long n = new Scanner(System.in).nextLong();\n    System.out.println(n * 2);\n  }\n}\n" },
  c: { id: 50, src: "#include <stdio.h>\nint main(void) { long long n; scanf(\"%lld\", &n); printf(\"%lld\\n\", n * 2); return 0; }\n" },
  cpp: { id: 54, src: "#include <bits/stdc++.h>\nint main() { long long n; std::cin >> n; std::cout << n * 2 << \"\\n\"; }\n" },
  go: { id: 60, src: "package main\nimport \"fmt\"\nfunc main() { var n int64; fmt.Scan(&n); fmt.Println(n * 2) }\n" },
  rust: { id: 73, src: "use std::io::Read;\nfn main() { let mut s = String::new(); std::io::stdin().read_to_string(&mut s).unwrap(); let n: i64 = s.trim().parse().unwrap(); println!(\"{}\", n * 2); }\n" },
  ruby: { id: 72, src: "n = gets.to_i\nputs n * 2\n" },
  php: { id: 68, src: "<?php\n$n = (int) trim(fgets(STDIN));\necho $n * 2, \"\\n\";\n" },
  kotlin: { id: 78, src: "fun main() { val n = readLine()!!.trim().toLong(); println(n * 2) }\n" },
  csharp: { id: 51, src: "using System;\nclass Program { static void Main() { long n = long.Parse(Console.ReadLine().Trim()); Console.WriteLine(n * 2); } }\n" }
};

const PROFILES = {
  smoke: { langs: Object.keys(PROGRAMS), levels: [1], seconds: 0 },
  quick: { langs: ["python", "cpp"], levels: [1, 10], seconds: 20 },
  full: { langs: ["python", "cpp", "java"], levels: [1, 10, 20, 40], seconds: 45 }
};

const args = process.argv.slice(2);
const profileName = args.find((a) => !a.startsWith("--")) || "smoke";
const base = PROFILES[profileName];
if (!base) {
  console.error(`Unknown profile "${profileName}". Use one of: ${Object.keys(PROFILES).join(", ")}`);
  process.exit(2);
}
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const config = {
  profile: profileName,
  langs: flag("langs")?.split(",") || base.langs,
  levels: flag("levels")?.split(",").map(Number) || base.levels,
  seconds: Number(flag("seconds") ?? base.seconds)
};
const unknown = config.langs.filter((l) => !PROGRAMS[l]);
if (unknown.length) {
  console.error(`Unknown language(s): ${unknown.join(", ")}. Known: ${Object.keys(PROGRAMS).join(", ")}`);
  process.exit(2);
}

const BASE = (process.env.LOADTEST_BASE || "https://assess.fortifyhub.net/api/codeAssess").replace(/\/$/, "");
const KEY = process.env.LOADTEST_KEY;
if (!KEY) {
  console.error("LOADTEST_KEY is not set. Create a key on the API Keys page (System > API Keys, scope codeassess)\n" +
    "and save it in loadtest/.env as LOADTEST_KEY=ak_... (see loadtest/README.md).");
  process.exit(2);
}
const HEADERS = { "Content-Type": "application/json", "x-rapidapi-key": KEY };
const b64 = (s) => Buffer.from(s).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request: submit with wait=true, poll if the judge has not finished within the wait.
async function runOnce(lang) {
  const program = PROGRAMS[lang];
  const n = Math.floor(Math.random() * 1e6);
  const t0 = Date.now();
  try {
    let res = await fetch(`${BASE}/submissions?base64_encoded=true&wait=true`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ language_id: program.id, source_code: b64(program.src), stdin: b64(`${n}\n`) })
    });
    if (res.status === 401) throw Object.assign(new Error("401 Unauthorized: the key is wrong, revoked or lacks the codeassess scope"), { fatal: true });
    if (res.status === 429) return { ok: false, ms: Date.now() - t0, why: "429 rate limited" };
    let body = await res.json();
    while (body?.status?.id === 1 || body?.status?.id === 2) {
      await sleep(500);
      res = await fetch(`${BASE}/submissions/${body.token}?base64_encoded=true`, { headers: HEADERS });
      body = await res.json();
    }
    const decode = (v) => (v ? Buffer.from(v, "base64").toString() : "");
    const out = decode(body.stdout).trim();
    const ok = body?.status?.id === 3 && out === String(n * 2);
    const why = ok ? "" : `${body?.status?.description || `HTTP ${res.status}`}${out ? ` (stdout "${out.slice(0, 40)}")` : ""}${body.compile_output ? `: ${decode(body.compile_output).slice(0, 200)}` : ""}${body.stderr ? `: ${decode(body.stderr).slice(0, 200)}` : ""}`;
    return { ok, ms: Date.now() - t0, why };
  } catch (err) {
    if (err.fatal) throw err;
    return { ok: false, ms: Date.now() - t0, why: err.message };
  }
}

const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);

async function step(lang, concurrency, seconds) {
  const results = [];
  const start = Date.now();
  const end = start + seconds * 1000;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    do results.push(await runOnce(lang));
    while (Date.now() < end);
  }));
  const wall = (Date.now() - start) / 1000;
  const ms = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const errors = {};
  for (const r of results.filter((x) => !x.ok)) errors[r.why] = (errors[r.why] || 0) + 1;
  return {
    lang, concurrency, requests: results.length, ok: ms.length, failed: results.length - ms.length,
    perMin: Math.round((ms.length / wall) * 60), p50: pct(ms, 0.5), p95: pct(ms, 0.95), max: ms.at(-1) ?? null, errors
  };
}

// The latest earlier run of this profile against the same server (a local run is never
// compared with the testing stack).
function previousRun(profile, base) {
  if (!fs.existsSync(RESULTS)) return null;
  const files = fs.readdirSync(RESULTS).filter((f) => f.endsWith(`-${profile}.json`)).sort().reverse();
  for (const f of files) {
    const run = JSON.parse(fs.readFileSync(path.join(RESULTS, f), "utf8"));
    if (run.base === base) return run;
  }
  return null;
}

const delta = (now, before) => {
  if (now == null || before == null || before === 0) return "";
  const d = Math.round(((now - before) / before) * 100);
  return ` (${d >= 0 ? "+" : ""}${d}%)`;
};

const prev = previousRun(config.profile, BASE);
console.log(`${config.profile}: ${config.langs.join(", ")} at ${config.levels.join("/")} concurrent` +
  `${config.seconds ? `, ${config.seconds} s each` : ""} against ${BASE}`);
if (prev) console.log(`comparing with the previous ${config.profile} run (${prev.startedAt})`);

const startedAt = new Date().toISOString();
const steps = [];
try {
  for (const lang of config.langs) {
    for (const level of config.levels) {
      const s = await step(lang, level, config.seconds);
      steps.push(s);
      const before = prev?.steps.find((p) => p.lang === s.lang && p.concurrency === s.concurrency);
      const line = config.seconds === 0
        ? `${s.lang.padEnd(11)} ${s.failed ? "FAIL" : "ok  "} ${String(s.p50 ?? "-").padStart(6)} ms${delta(s.p50, before?.p50)}`
        : `${s.lang.padEnd(11)} x${String(s.concurrency).padEnd(3)} ${String(s.perMin).padStart(6)}/min${delta(s.perMin, before?.perMin)}` +
          `  p50 ${s.p50 ?? "-"} ms${delta(s.p50, before?.p50)}  p95 ${s.p95 ?? "-"} ms  ok ${s.ok}/${s.requests}`;
      console.log(line);
      for (const [why, count] of Object.entries(s.errors)) console.log(`    ${count} x ${why}`);
      if (config.seconds) await sleep(5000);
    }
  }
} catch (err) {
  console.error(`\nStopped: ${err.message}`);
  steps.length = 0;
}

// exitCode, not process.exit(): exiting while fetch sockets are still open trips a libuv
// assertion on Windows, which exits 127 instead of the real code.
if (steps.length === 0) {
  process.exitCode = 1;
} else {
  fs.mkdirSync(RESULTS, { recursive: true });
  const file = path.join(RESULTS, `${startedAt.replace(/[:.]/g, "-")}-${config.profile}.json`);
  fs.writeFileSync(file, JSON.stringify({ startedAt, base: BASE, ...config, steps }, null, 2));
  const failed = steps.reduce((sum, s) => sum + s.failed, 0);
  console.log(`\n${failed ? `${failed} failed request(s)` : "no failures"}; saved ${path.relative(process.cwd(), file)}`);
  process.exitCode = failed ? 1 : 0;
}
