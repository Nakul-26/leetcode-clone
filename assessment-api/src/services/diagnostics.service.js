// Turns raw compiler and interpreter output into a short list of what went wrong, for a
// student to read (docs/EDITOR_UX_PLAN.md, B1-B2).
//
// Raw output buries the cause: printing a vector with cout is 107 lines of overload
// candidates, sort() on a set reports its first error inside stl_algo.h, a missing ';' is
// reported on the next line, and a Python traceback puts the cause on its last line. Every
// result is reduced to at most three diagnostics:
//
//   { line, column, kind, message, hint }
//
// - line/column point into the student's own code (null when no line applies, e.g. a crash).
// - kind is "compile", "runtime", "timeout" or "memory".
// - message is the compiler's own first line, with paths and type noise removed.
// - hint is a plain-language explanation for the common cases, or null.
//
// Line numbers are not trusted blindly: compilers print the offending source line back, and
// that text is matched against the student's code. This keeps lines right when the judge wraps
// the code in a harness (function-mode problems) and drops locations that are in the harness.

const MAX_DIAGNOSTICS = 3;
const MAX_MESSAGE = 240;

// /app/sub-raw-1793763843311605486-1051734594/main.cpp, file:///app/Main.kt, /home/judge/app/Program.cs
const WORKSPACE_PATH = /(?:file:\/\/)?(?:\/home\/judge)?\/app\/(?:sub-[a-z]+(?:-\d+)+\/)?/g;
const INTERPRETED_SOURCE = /\bsolution\.(py|js|ts|rb|php)\b/g;
// The judge's own wrapping around a compiler's output, e.g.
// "compilation failed: runtime error: exit code 1 | compilation failed: runtime error: exit code 1 | stderr=Main.java:3: error: ..."
const JUDGE_ERROR_PREFIX = /^(?:compilation failed: [^|\n]*\|\s*)+(?:stdout|stderr)[= ]/gm;

// Removes the judge's workspace paths so "main.cpp:5:3: error" reads like the student's own file.
// The stdin judge names interpreted programs solution.*; the editors call them main.*.
export function stripWorkspacePaths(text) {
  if (!text) return text || "";
  return String(text)
    .replace(JUDGE_ERROR_PREFIX, "")
    .replace(WORKSPACE_PATH, "")
    .replace(INTERPRETED_SOURCE, "main.$1");
}

const PYTHON_SYNTAX = /^\s*(SyntaxError|IndentationError|TabError)\b/m;

// A Python syntax error is raised before the program runs, so it is a compile error even
// though the interpreter reports it as a non-zero exit.
export function isPythonSyntaxError(stderr) {
  return PYTHON_SYNTAX.test(String(stderr || "")) && !/Traceback \(most recent call last\)/.test(String(stderr || ""));
}

// ---------------------------------------------------------------------------------------------
// Parsing: one function per output format. Each returns entries
//   { line, column, message, severity, excerpt, file, extra }
// in the order the tool printed them.

const isLibraryFile = (file) => /^(\/usr\/|\/opt\/|<|\/lib\/|\/rustc\/|node:)/.test(file || "");

function gccEntries(text) {
  const out = [];
  const lines = text.split("\n");
  // GCC prints "required from here" (the student's line) before an error that is reported
  // inside a library header; remember it so that error can be moved to the student's line.
  let studentContext = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const required = raw.match(/^(.+?):(\d+):(\d+):\s+required from here/);
    if (required && !isLibraryFile(required[1])) {
      studentContext = { line: Number(required[2]), column: Number(required[3]), excerpt: excerptAfter(lines, i, Number(required[2])) };
      continue;
    }
    const m = raw.match(/^(.+?):(\d+):(\d+):\s+(fatal error|error|warning):\s+(.*)$/);
    if (m) {
      const [, file, line, column, severity, message] = m;
      if (isLibraryFile(file)) {
        if (studentContext) {
          out.push({ ...studentContext, file: "", message, severity: severity === "warning" ? "warning" : "error", fromLibrary: true });
          studentContext = null;
        } else {
          out.push({ line: null, column: null, file, message, severity: severity === "warning" ? "warning" : "error", fromLibrary: true });
        }
      } else {
        out.push({ line: Number(line), column: Number(column), file, message, severity: severity === "warning" ? "warning" : "error", excerpt: excerptAfter(lines, i, Number(line)) });
      }
      continue;
    }
    const undefinedRef = raw.match(/undefined reference to [`'](\w+)'/);
    if (undefinedRef) {
      out.push({ line: null, column: null, message: `undefined reference to '${undefinedRef[1]}'`, severity: "error", symbol: undefinedRef[1] });
    }
  }
  return out;
}

// "    5 |     vector<int> a(n);" printed after a gcc or rustc location line.
function excerptAfter(lines, index, lineNo) {
  for (let j = index + 1; j < Math.min(lines.length, index + 3); j++) {
    const m = lines[j].match(/^\s*(\d+)\s\|\s?(.*)$/);
    if (m && Number(m[1]) === lineNo) return m[2];
  }
  return undefined;
}

function javacEntries(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(.+?\.java):(\d+):\s+(error|warning):\s+(.*)$/);
    if (!m) continue;
    const excerpt = lines[i + 1];
    const caret = lines[i + 2] && /^\s*\^\s*$/.test(lines[i + 2]) ? lines[i + 2].indexOf("^") + 1 : null;
    const details = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const d = lines[j].match(/^\s+(symbol|location|required|found|reason):\s+(.*)$/);
      if (d) details.push(`${d[1]}: ${d[2].trim()}`);
    }
    out.push({ line: Number(m[2]), column: caret, file: m[1], message: m[4], severity: m[3], excerpt, extra: details });
  }
  return out;
}

function pythonEntries(text) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    const frame = lines[i].match(/^\s*File "(.+?)", line (\d+)/);
    if (frame && !isLibraryFile(frame[1]) && !frame[1].startsWith("<frozen")) {
      const next = lines[i + 1];
      const excerpt = next && !/^\s*File "/.test(next) && !/^\w+(Error|Exception)?:/.test(next.trim()) ? next : undefined;
      const caretLine = lines[i + 2];
      const column = caretLine && /^\s*[~^]+\s*$/.test(caretLine) && excerpt ? caretLine.search(/[~^]/) - (excerpt.length - excerpt.trimStart().length) + 1 : null;
      last = { line: Number(frame[2]), column: column > 0 ? column : null, file: frame[1], excerpt };
    }
  }
  const finalLine = [...lines].reverse().find((l) => /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning)?\b(:|$)/.test(l.trim()) && !/^\s*File "/.test(l));
  if (!finalLine) return [];
  return [{ ...(last || { line: null, column: null }), message: finalLine.trim(), severity: "error" }];
}

function nodeEntries(text) {
  const lines = text.split("\n");
  // Uncaught error: "file.js:12" then the source line, a caret, a blank line, "TypeError: ...".
  let location = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(.+?\.(?:js|ts|mjs|cjs)):(\d+)$/);
    if (m && !isLibraryFile(m[1])) {
      const caret = lines[i + 2] && /^\s*\^+\s*$/.test(lines[i + 2]) ? lines[i + 2].indexOf("^") + 1 : null;
      location = { line: Number(m[2]), column: caret, file: m[1], excerpt: lines[i + 1] };
      break;
    }
    // tsx / esbuild: "main.ts:3:5: ERROR: Expected ";" but found "x""
    const esbuild = lines[i].match(/(\S+?\.(?:ts|js)):(\d+):(\d+):\s+ERROR:\s+(.*)$/);
    if (esbuild) return [{ line: Number(esbuild[2]), column: Number(esbuild[3]) + 1, file: esbuild[1], message: esbuild[4], severity: "error" }];
  }
  const message = lines.find((l) => /^[A-Z]\w*(Error|Exception)\b.*?:/.test(l.trim()) || /^Error:/.test(l.trim()));
  if (!message) return [];
  if (!location) {
    const frame = lines.map((l) => l.match(/\((?!node:)(.+?\.(?:js|ts|mjs|cjs)):(\d+):(\d+)\)/) || l.match(/at (?!node:)(.+?\.(?:js|ts)):(\d+):(\d+)/)).find(Boolean);
    if (frame) location = { line: Number(frame[2]), column: Number(frame[3]), file: frame[1] };
  }
  return [{ ...(location || { line: null, column: null }), message: message.trim(), severity: "error" }];
}

function kotlinEntries(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    // K1: "Main.kt:3:5: error: unresolved reference: x"; K2: "e: Main.kt:3:5 Unresolved reference 'x'."
    const m = raw.match(/^(?:([ew]):\s+)?(.+?\.kts?):(\d+):(\d+):?\s+(?:(error|warning):\s+)?(.*)$/);
    if (!m) continue;
    const severity = m[5] || (m[1] === "w" ? "warning" : "error");
    out.push({ line: Number(m[3]), column: Number(m[4]), file: m[2], message: m[6], severity });
  }
  return out;
}

function csharpEntries(text) {
  const out = [];
  const seen = new Set();
  for (const raw of text.split("\n")) {
    const m = raw.match(/^(.+?\.cs)\((\d+),(\d+)\):\s+(error|warning)\s+(CS\d+):\s+(.*?)(?:\s+\[.*\])?\s*$/);
    if (!m) continue;
    const key = `${m[2]}:${m[3]}:${m[5]}`;
    if (seen.has(key)) continue; // dotnet prints each diagnostic twice (build + summary)
    seen.add(key);
    out.push({ line: Number(m[2]), column: Number(m[3]), file: m[1], message: `${m[6]} (${m[5]})`, severity: m[4], code: m[5] });
  }
  return out;
}

function rustEntries(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^(error|warning)(?:\[(E\d+)\])?:\s+(.*)$/);
    if (head) {
      if (/^aborting due to|could not compile/.test(head[3])) continue;
      let loc = null;
      const help = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 14); j++) {
        if (/^(error|warning)(\[|:)/.test(lines[j])) break;
        const at = lines[j].match(/^\s*-->\s+(.+?):(\d+):(\d+)$/);
        if (at && !loc) loc = { file: at[1], line: Number(at[2]), column: Number(at[3]), excerpt: excerptAfter(lines, j + 1, Number(at[2])) };
        const h = lines[j].match(/(?:help|note):\s+(.*)$/);
        if (h) help.push(h[1].trim());
      }
      out.push({ ...(loc || { line: null, column: null }), message: head[3], severity: head[1], extra: help });
      continue;
    }
    // Panic, new format: "thread 'main' panicked at main.rs:5:9:" then the message on the next line.
    const panicNew = lines[i].match(/^thread '.*' panicked at (.+?):(\d+):(\d+):$/);
    if (panicNew) {
      out.push({ line: Number(panicNew[2]), column: Number(panicNew[3]), file: panicNew[1], message: (lines[i + 1] || "panic").trim(), severity: "error" });
      continue;
    }
    const panicOld = lines[i].match(/^thread '.*' panicked at '(.*)', (.+?):(\d+):(\d+)/);
    if (panicOld) out.push({ line: Number(panicOld[3]), column: Number(panicOld[4]), file: panicOld[2], message: panicOld[1], severity: "error" });
  }
  return out;
}

function goEntries(text) {
  const out = [];
  const lines = text.split("\n");
  for (const raw of lines) {
    const m = raw.match(/^(?:\.\/)?([\w./-]+?\.go):(\d+):(\d+):\s+(.*)$/);
    if (m) out.push({ line: Number(m[2]), column: Number(m[3]), file: m[1], message: m[4], severity: "error" });
  }
  if (out.length) return out;
  const panic = lines.find((l) => /^panic: /.test(l));
  if (panic) {
    const frame = lines.map((l) => l.match(/^\s+(.+?\.go):(\d+)/)).find((m) => m && !isLibraryFile(m[1]) && !/\/go\/src\//.test(m[1]));
    out.push({ line: frame ? Number(frame[2]) : null, column: null, file: frame?.[1], message: panic.replace(/^panic: /, "").replace(/\s*\[recovered\]$/, ""), severity: "error" });
  }
  return out;
}

function rubyEntries(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    // "main.rb:3:in '<main>': undefined local variable or method 'x' for main (NameError)"
    // "main.rb:3: syntax error, unexpected end-of-input"
    const m = raw.match(/^(.+?\.rb):(\d+):(?:in [`'][^']*'\s*:)?\s*(.+)$/);
    if (m && !isLibraryFile(m[1])) {
      out.push({ line: Number(m[2]), column: null, file: m[1], message: m[3].trim(), severity: "error" });
      if (out.length >= MAX_DIAGNOSTICS) break;
    }
  }
  return out;
}

function phpEntries(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const m = raw.match(/^(?:PHP )?(Parse error|Fatal error|Warning|Notice|Deprecated):\s+(.*?) in (.+?)(?: on line |:)(\d+)/);
    if (!m) continue;
    const severity = /error/i.test(m[1]) ? "error" : "warning";
    out.push({ line: Number(m[4]), column: null, file: m[3], message: m[2].replace(/^Uncaught (Error|\w+Exception): /, ""), severity });
  }
  return out;
}

const PARSERS = {
  c: gccEntries, cpp: gccEntries, java: javacEntries, python: pythonEntries,
  javascript: nodeEntries, typescript: nodeEntries, kotlin: kotlinEntries, csharp: csharpEntries,
  rust: rustEntries, go: goEntries, ruby: rubyEntries, php: phpEntries
};

// Java runtime exceptions: "Exception in thread "main" java.lang.ArrayIndexOutOfBoundsException: ...
//     at Main.main(Main.java:8)"
function javaRuntimeEntries(text) {
  const lines = text.split("\n");
  const head = lines.find((l) => /^Exception in thread|^Caused by:/.test(l)) || lines.find((l) => /^[a-z]+(\.[a-z]+)+\.\w+(Exception|Error)\b/.test(l));
  if (!head) return [];
  const frame = lines.map((l) => l.match(/^\s+at\s+(?!java\.|jdk\.|sun\.)[\w.$]+\((\w+\.java):(\d+)\)/)).find(Boolean);
  const message = head.replace(/^Exception in thread "[^"]*"\s+/, "").replace(/^Caused by:\s+/, "").replace(/^java\.(lang|util|io)\./, "");
  return [{ line: frame ? Number(frame[2]) : null, column: null, file: frame?.[1], message, severity: "error" }];
}

function kotlinRuntimeEntries(text) {
  const entries = javaRuntimeEntries(text);
  if (!entries.length) return [];
  const frame = text.split("\n").map((l) => l.match(/^\s+at\s+[\w.$]+\((\w+\.kt):(\d+)\)/)).find(Boolean);
  return [{ ...entries[0], line: frame ? Number(frame[2]) : null, file: frame?.[1] }];
}

// ---------------------------------------------------------------------------------------------
// Crashes with no message of their own (a C or C++ program killed by a signal).

const SIGNALS = {
  139: ["Segmentation fault", "The program read or wrote memory it doesn't own: often an array or vector index out of range, a null or uninitialised pointer, or recursion that never stops."],
  136: ["Floating point exception", "An arithmetic error, almost always an integer division or % by zero."],
  132: ["Illegal instruction", "The program hit undefined behaviour. Common causes: an integer division by zero, or a function that is missing its return statement."],
  134: ["Aborted", "The program stopped itself: a failed assert, an exception that was never caught (for example vector.at() out of range), or an invalid free/delete."],
  137: ["Killed", "The program was stopped from outside, usually for using too much memory."],
  135: ["Bus error", "Invalid memory access, similar to a segmentation fault."]
};

function signalEntry(exitCode, stderr) {
  const code = Number(exitCode);
  const byText = Object.entries(SIGNALS).find(([, [name]]) => new RegExp(`^${name}\\b`, "m").test(stderr || ""));
  const entry = SIGNALS[code] ? [code, SIGNALS[code]] : byText ? [Number(byText[0]), byText[1]] : null;
  if (!entry) return null;
  const [, [name, hint]] = entry;
  return { line: null, column: null, message: `${name} (exit code ${entry[0]})`, severity: "error", hint };
}

// Describes an exit by signal for a raw stderr that is empty (A2 does the same in the judge).
export function describeSignal(exitCode) {
  const s = SIGNALS[Number(exitCode)];
  return s ? `${s[0]} (exit code ${Number(exitCode)}): ${s[1]}` : "";
}

// ---------------------------------------------------------------------------------------------
// Source helpers.

function stripComments(code, language) {
  // Good enough for brace counting and identifier extraction: blank out string and char
  // literals and comments, keeping line structure intact.
  const hashComments = ["python", "ruby"].includes(language);
  let out = "";
  let i = 0;
  let mode = null; // "line", "block", '"', "'", "`"
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (mode === null) {
      if (!hashComments && c === "/" && n === "/") { mode = "line"; i += 2; out += "  "; continue; }
      if (!hashComments && c === "/" && n === "*") { mode = "block"; i += 2; out += "  "; continue; }
      if (hashComments && c === "#") { mode = "line"; i++; out += " "; continue; }
      if (c === '"' || c === "'" || c === "`") { mode = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === "line") { if (c === "\n") { mode = null; out += "\n"; } else out += " "; i++; continue; }
    if (mode === "block") { if (c === "*" && n === "/") { mode = null; out += "  "; i += 2; continue; } out += c === "\n" ? "\n" : " "; i++; continue; }
    // In a string or char literal.
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (c === mode) { mode = null; out += c; i++; continue; }
    if (c === "\n" && mode !== "`") { mode = null; out += "\n"; i++; continue; }
    out += " "; i++;
  }
  return out;
}

const indentOf = (line) => {
  let w = 0;
  for (const ch of line) {
    if (ch === " ") w += 1;
    else if (ch === "\t") w += 4;
    else break;
  }
  return w;
};

// The '{' a student most likely forgot to close. A '}' that is indented less than the line
// that opened the innermost block means that block was never closed: that is the brace to
// point at, not the outermost one the compiler names at the end of the file.
export function findUnclosedBrace(code, language) {
  const lines = stripComments(code, language).split("\n");
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstNonSpace = line.trimStart()[0];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch === "{") stack.push({ line: i + 1, column: col + 1, indent: indentOf(line) });
      else if (ch === "}") {
        const top = stack[stack.length - 1];
        if (!top) continue;
        if (firstNonSpace === "}" && col === line.length - line.trimStart().length && top.line !== i + 1 && top.indent > indentOf(line)) {
          return top;
        }
        stack.pop();
      }
    }
  }
  return stack.length ? stack[stack.length - 1] : null;
}

const KEYWORDS = new Set(("if else for while do return int long char float double bool void auto const static class struct public private protected " +
  "new delete true false null nullptr None True False def import from as in not and or is pass break continue lambda with try except finally " +
  "raise yield global let var function this super extends implements interface package final throws throw catch switch case default " +
  "using namespace include define fun val when object func go type map chan select fn mut impl pub use match loop let elif end").split(" "));

const LIBRARY_NAMES = {
  c: "printf scanf puts gets fgets getchar putchar strlen strcpy strncpy strcmp strncmp strcat strchr strstr malloc calloc realloc free abs qsort atoi atol sqrt pow fabs floor ceil tolower toupper isdigit isalpha isspace isupper islower memset memcpy sizeof",
  cpp: "cout cin endl getline vector string map set unordered_map unordered_set pair stack queue deque priority_queue sort reverse max min swap abs sqrt pow begin end push_back pop_back size empty insert erase find count accumulate greater less make_pair",
  python: "print input range len int str float list dict set tuple sorted sum min max abs map filter enumerate zip append split join strip lower upper isdigit",
  java: "System out println print Scanner nextInt nextLine next nextLong Integer String Math Arrays ArrayList HashMap HashSet List Map length size add get put",
  javascript: "console log require readFileSync split map Number parseInt String Math length push join",
  go: "fmt Println Printf Scan Scanln len append make",
  kotlin: "println readLine readln toInt split map",
  csharp: "Console WriteLine ReadLine int Parse Split",
  rust: "println read_line parse unwrap trim split_whitespace collect",
  ruby: "puts gets to_i split map",
  php: "echo fgets trim explode intval"
};
LIBRARY_NAMES.typescript = LIBRARY_NAMES.javascript;

function identifiersIn(code, language) {
  // Without PHP's '$', so "$totl" is compared with "total" and never with itself.
  const ids = new Set((stripComments(code, language).match(/[A-Za-z_][\w]*/g) || []).filter((w) => !KEYWORDS.has(w)));
  for (const w of (LIBRARY_NAMES[language] || "").split(" ")) if (w) ids.add(w);
  return ids;
}

// Damerau-Levenshtein (with adjacent transpositions), so "reuslt" is one edit from "result".
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

export function didYouMean(name, candidates) {
  if (!name) return null;
  const limit = name.length <= 4 ? 1 : 2;
  let best = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    if (c === name || Math.abs(c.length - name.length) > limit) continue;
    const dist = editDistance(name.toLowerCase(), c.toLowerCase()) - (c.toLowerCase() === name.toLowerCase() ? 0.5 : 0);
    if (dist <= limit && dist < bestDistance) { best = c; bestDistance = dist; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Hints: plain-language explanations for the common errors, keyed on the tool's message.

const C_HEADERS = {
  "string.h": "strlen strcpy strncpy strcmp strncmp strcat strchr strstr memset memcpy",
  "ctype.h": "tolower toupper isdigit isalpha isspace isupper islower isalnum",
  "math.h": "sqrt pow fabs floor ceil log exp sin cos",
  "stdlib.h": "malloc calloc realloc free abs qsort atoi atol exit rand",
  "stdio.h": "printf scanf puts gets fgets getchar putchar sprintf",
  "stdbool.h": "bool true false"
};
const CPP_HEADERS = {
  vector: "vector", string: "string", map: "map", set: "set", unordered_map: "unordered_map", unordered_set: "unordered_set",
  stack: "stack", queue: "queue priority_queue", deque: "deque", algorithm: "sort reverse max_element min_element unique lower_bound upper_bound next_permutation",
  numeric: "accumulate iota gcd", iostream: "cout cin endl cerr", utility: "pair make_pair swap", climits: "INT_MAX INT_MIN LLONG_MAX LLONG_MIN"
};
const headerFor = (table, name) => Object.entries(table).find(([, names]) => names.split(" ").includes(name))?.[0];

const code = (s) => `\`${s}\``;

const HINTS = [
  // ---- C and C++ ----
  { langs: ["cpp"], re: /no match for 'operator<<'.*(vector|set|map|pair|array|deque|list)</, hint: (m) => `${code("cout")} can't print a whole ${m[1]}. Loop over it and print each element, e.g. ${code("for (auto x : v) cout << x << \" \";")}` },
  { langs: ["cpp"], re: /no match for 'operator>>'.*(vector|set|map)</, hint: (m) => `${code("cin")} can't read a whole ${m[1]}. Read into each element in a loop, e.g. ${code("for (auto &x : v) cin >> x;")}` },
  { langs: ["cpp"], re: /no match for 'operator-'.*_Rb_tree|_Rb_tree.*no match for 'operator-'|_Rb_tree_(const_)?iterator.*operator[-+]/, hint: () => `${code("sort()")} only works on a vector or an array. A ${code("set")} or ${code("map")} is already sorted, so loop over it directly.` },
  { langs: ["cpp"], re: /expected primary-expression before '\)'/, test: (e) => /\b(greater|less)<[^>]+>\s*\)/.test(e.excerpt || ""), hint: () => `Write ${code("greater<int>()")} with ${code("()")}: ${code("sort")} needs a comparator object, not the type.` },
  { langs: ["c", "cpp"], re: /expected '([;,])'(?: or '[;,]')* before/, hint: () => `Missing ${code(";")} at the end of this line.` },
  { langs: ["c", "cpp"], re: /expected '}' at end of input|expected declaration or statement at end of input/, hint: () => `This ${code("{")} is never closed. Add the missing ${code("}")}.` },
  { langs: ["c", "cpp"], re: /expected '\)' before|expected '\)' at end of input/, hint: () => `A ${code("(")} is not closed: check the brackets on this line.` },
  { langs: ["c"], re: /implicit declaration of function '(\w+)'/, hint: (m, ctx) => cMissingFunction(m[1], ctx) },
  { langs: ["c", "cpp"], re: /undefined reference to '(\w+)'/, hint: (m, ctx) => {
    const guess = didYouMean(m[1], ctx.identifiers);
    return guess ? `${code(m[1])} doesn't exist. Did you mean ${code(guess)}?` : `${code(m[1])} is used but never defined: check the spelling.`;
  } },
  { langs: ["cpp"], re: /'(\w+)' was not declared in this scope(?:; did you mean '(\w+)')?/, hint: (m, ctx) => cppNotDeclared(m[1], m[2], ctx) },
  { langs: ["c"], re: /'(\w+)' undeclared(?: \(first use in this function\))?(?:; did you mean '(\w+)')?/, hint: (m, ctx) => {
    const guess = m[2] || didYouMean(m[1], ctx.identifiers);
    return guess ? `${code(m[1])} isn't defined. Did you mean ${code(guess)}?` : `${code(m[1])} isn't defined: check the spelling, and declare it before this line.`;
  } },
  { langs: ["c", "cpp"], re: /control reaches end of non-void function|no return statement in function returning non-void/, hint: () => `This function must ${code("return")} a value on every path.` },
  { langs: ["c", "cpp"], re: /redefinition of '(\w+)'|conflicting types for '(\w+)'|redeclaration of '(\w+)'/, hint: (m) => `${code(m[1] || m[2] || m[3])} is defined twice. Rename one of them.` },
  { langs: ["c", "cpp"], re: /invalid conversion from '([^']+)' to '([^']+)'|cannot convert '([^']+)' to '([^']+)'/, hint: () => `The value's type doesn't match what's expected here. Check the variable's type.` },
  { langs: ["cpp"], re: /request for member '(\w+)' in '(\w+)', which is of non-class type/, hint: (m) => `${code(m[2])} isn't an object, so it has no ${code("." + m[1])}.` },
  { langs: ["cpp"], re: /'class std::(?:__cxx11::)?(\w+)<?.*' has no member named '(\w+)'|has no member named '(\w+)'/, hint: (m) => {
    const member = m[2] || m[3];
    const fix = { push: "push_back", append: "push_back", length: "size", add: "insert", pop: "pop_back" }[member];
    return fix ? `There's no ${code("." + member + "()")} here. Did you mean ${code("." + fix + "()")}?` : `There's no member ${code(member)} on this type: check the spelling.`;
  } },

  // ---- Java ----
  { langs: ["java"], re: /class (\w+) is public, should be declared in a file named \1\.java/, hint: (m) => `Name the class ${code("Main")}: write ${code("public class Main")} instead of ${code("public class " + m[1])}.` },
  { langs: ["java"], re: /cannot find symbol/, hint: (m, ctx, e) => javaCannotFind(e, ctx) },
  { langs: ["java"], re: /';' expected/, hint: () => `Missing ${code(";")} at the end of this line.` },
  { langs: ["java"], re: /reached end of file while parsing/, hint: () => `A ${code("{")} is never closed. Add the missing ${code("}")}.` },
  { langs: ["java"], re: /missing return statement/, hint: () => `This method must ${code("return")} a value on every path.` },
  { langs: ["java"], re: /incompatible types: possible lossy conversion from (\w+) to (\w+)/, hint: (m) => `A ${code(m[1])} doesn't fit in an ${code(m[2])}. Make the variable ${code(m[1])}, or cast with ${code("(" + m[2] + ")")}.` },
  { langs: ["java"], re: /incompatible types: (\w+) cannot be converted to (\w+)/, hint: (m) => `This is a ${code(m[1])}, but a ${code(m[2])} is needed here.` },
  { langs: ["java"], re: /variable (\w+) might not have been initialized/, hint: (m) => `Give ${code(m[1])} a starting value before using it.` },
  { langs: ["java"], re: /variable (\w+) is already defined/, hint: (m) => `${code(m[1])} is declared twice in this method. Rename one, or drop the second type name.` },
  { langs: ["java"], re: /non-static (method|variable) (\w+).* cannot be referenced from a static context/, hint: (m) => `${code("main")} is static. Make ${code(m[2])} static too, or call it on an object.` },
  { langs: ["java"], re: /NoSuchElementException/, hint: () => `The program tried to read more input than there is. Check how many values you read, and the input format.` },
  { langs: ["java"], re: /InputMismatchException/, hint: () => `The next input value isn't the type you read (e.g. ${code("nextInt()")} on text). Check the input format.` },
  { langs: ["java"], re: /NumberFormatException: For input string: "(.*)"/, hint: (m) => /\s/.test(m[1]) ? `${code("Integer.parseInt")} got ${code(m[1])}, which has several numbers. Split the line first: ${code("line.trim().split(\"\\\\s+\")")}.` : `${code(m[1])} isn't a number.` },
  { langs: ["java", "kotlin"], re: /ArrayIndexOutOfBoundsException: Index (-?\d+) out of bounds for length (\d+)/, hint: (m) => `Index ${m[1]} is outside the array: valid indexes are 0 to ${Number(m[2]) - 1}.` },
  { langs: ["java", "kotlin"], re: /IndexOutOfBoundsException: Index:? (-?\d+).*(?:Size:?|length) (\d+)/, hint: (m) => `Index ${m[1]} is outside the list: valid indexes are 0 to ${Number(m[2]) - 1}.` },
  { langs: ["java", "kotlin"], re: /NullPointerException/, hint: () => `Something on this line is ${code("null")}: an object that was never created, or a missing value.` },
  { langs: ["java", "kotlin"], re: /ArithmeticException: \/ by zero/, hint: () => `Division by zero.` },
  { langs: ["java", "kotlin"], re: /StackOverflowError/, hint: () => `The recursion never stops (or goes too deep). Check the base case.` },

  // ---- Python ----
  { langs: ["python"], re: /NameError: name '(\w+)' is not defined(?:\. Did you mean: '(\w+)'\?)?/, hint: (m, ctx) => {
    const guess = m[2] || didYouMean(m[1], ctx.identifiers);
    return guess ? `${code(m[1])} isn't defined. Did you mean ${code(guess)}?` : `${code(m[1])} isn't defined: check the spelling, and that it's assigned before this line.`;
  } },
  { langs: ["python"], re: /IndentationError: expected an indented block/, hint: () => `The lines inside this block (after the ${code(":")}) must be indented, usually by 4 spaces.` },
  { langs: ["python"], re: /IndentationError: unexpected indent/, hint: () => `This line is indented more than it should be. Line it up with the code around it.` },
  { langs: ["python"], re: /IndentationError: unindent does not match|TabError/, hint: () => `The indentation here doesn't line up with the lines above. Use 4 spaces everywhere, not a mix of tabs and spaces.` },
  { langs: ["python"], re: /SyntaxError: expected ':'/, hint: () => `Add a ${code(":")} at the end of this line (after ${code("if")}, ${code("for")}, ${code("while")}, ${code("def")} …).` },
  { langs: ["python"], re: /SyntaxError: '\(' was never closed|SyntaxError: unexpected EOF|SyntaxError: '\[' was never closed/, hint: () => `A bracket opened on this line is never closed.` },
  { langs: ["python"], re: /SyntaxError: invalid syntax\. Perhaps you forgot a comma\?/, hint: () => `Check for a missing ${code(",")} between items.` },
  { langs: ["python"], re: /SyntaxError: Missing parentheses in call to 'print'/, hint: () => `In Python 3, write ${code("print(x)")}.` },
  { langs: ["python"], re: /ValueError: invalid literal for int\(\) with base 10: '(.*)'/, hint: (m) => /\S\s+\S/.test(m[1])
    ? `${code("int(input())")} read the whole line ${code(m[1])}. For several numbers on one line use ${code("list(map(int, input().split()))")}.`
    : m[1].trim() === "" ? `${code("int()")} got an empty line: the program read more lines than the input has, or a blank line.` : `${code(m[1])} isn't a whole number.` },
  { langs: ["python"], re: /ValueError: (?:too many|not enough) values to unpack \(expected (\d+)(?:, got (\d+))?\)/, hint: (m) => `The line has a different number of values than the ${m[1]} variables on the left. Check the input format.` },
  { langs: ["python"], re: /EOFError: EOF when reading a line/, hint: () => `${code("input()")} was called more times than the input has lines. If several numbers are on one line, read them with one ${code("input().split()")}.` },
  { langs: ["python"], re: /IndexError: list index out of range/, hint: () => `An index is past the end of the list. Valid indexes are 0 to ${code("len(list) - 1")}.` },
  { langs: ["python"], re: /IndexError: string index out of range/, hint: () => `An index is past the end of the string. Valid indexes are 0 to ${code("len(s) - 1")}.` },
  { langs: ["python"], re: /ZeroDivisionError/, hint: () => `Division by zero.` },
  { langs: ["python"], re: /TypeError: can only concatenate str \(not "(\w+)"\) to str/, hint: (m) => `Convert the ${m[1]} with ${code("str()")} before joining, or use ${code("print(a, b)")} / an f-string.` },
  { langs: ["python"], re: /TypeError: unsupported operand type\(s\) for [^:]+: '(\w+)' and '(\w+)'/, hint: (m) => `A ${m[1]} and a ${m[2]} can't be combined like this. Did you forget ${code("int()")} on the input?` },
  { langs: ["python"], re: /TypeError: '(\w+)' object is not (callable|subscriptable|iterable)/, hint: (m) => `A ${code(m[1])} isn't ${m[2]}. Check that the variable holds what you expect (did a name get reused?).` },
  { langs: ["python"], re: /AttributeError: '(\w+)' object has no attribute '(\w+)'/, hint: (m) => {
    const fix = { push: "append", add: "append", length: "len()", size: "len()", push_back: "append" }[m[2]];
    return fix ? `A ${m[1]} has no ${code("." + m[2])}. Use ${code(fix.endsWith("()") ? fix : "." + fix + "()")}.` : `A ${m[1]} has no ${code("." + m[2])}: check the spelling.`;
  } },
  { langs: ["python"], re: /RecursionError/, hint: () => `The recursion never stops (or goes too deep). Check the base case.` },
  { langs: ["python"], re: /KeyError: (.*)/, hint: (m) => `The key ${code(m[1])} isn't in the dictionary. Check it exists first, or use ${code(".get()")}.` },
  { langs: ["python"], re: /ModuleNotFoundError: No module named '(\w+)'/, hint: (m) => `${code(m[1])} isn't available on the judge. Only the standard library can be used.` },

  // ---- JavaScript / TypeScript ----
  { langs: ["javascript", "typescript"], re: /ReferenceError: prompt is not defined/, hint: () => `${code("prompt()")} only exists in browsers. Read the input with ${code("require('fs').readFileSync(0, 'utf8')")}.` },
  { langs: ["javascript", "typescript"], re: /ReferenceError: (\w+) is not defined/, hint: (m, ctx) => {
    const guess = didYouMean(m[1], ctx.identifiers);
    return guess ? `${code(m[1])} isn't defined. Did you mean ${code(guess)}?` : `${code(m[1])} isn't defined: check the spelling, and declare it with ${code("let")} or ${code("const")}.`;
  } },
  { langs: ["javascript", "typescript"], re: /TypeError: Cannot read properties of (undefined|null) \(reading '(\w+)'\)/, hint: (m) => `Something on this line is ${code(m[1])}, so ${code("." + m[2])} can't be read. Often an index past the end of an array, or input read the wrong way.` },
  { langs: ["javascript", "typescript"], re: /TypeError: (\S+) is not a function/, hint: (m) => `${code(m[1])} isn't a function: check the name and what the variable holds.` },
  { langs: ["javascript", "typescript"], re: /SyntaxError: Unexpected end of input/, hint: () => `A bracket or ${code("{")} is never closed.` },
  { langs: ["javascript", "typescript"], re: /SyntaxError: Identifier '(\w+)' has already been declared/, hint: (m) => `${code(m[1])} is declared twice. Remove the second ${code("let")}/${code("const")}.` },

  // ---- Kotlin ----
  { langs: ["kotlin"], re: /[Uu]nresolved reference:? '?(\w+)'?/, hint: (m, ctx) => {
    const guess = didYouMean(m[1], ctx.identifiers);
    return guess ? `${code(m[1])} isn't defined. Did you mean ${code(guess)}?` : `${code(m[1])} isn't defined: check the spelling.`;
  } },
  { langs: ["kotlin"], re: /NumberFormatException: For input string: "(.*)"/, hint: (m) => /\s/.test(m[1]) ? `${code("toInt()")} got ${code(m[1])}, which has several numbers. Use ${code("readln().split(\" \").map { it.toInt() }")}.` : `${code(m[1])} isn't a number.` },
  { langs: ["kotlin"], re: /NullPointerException|KotlinNullPointerException/, hint: () => `A value was null. ${code("readLine()!!")} fails when there is no more input.` },

  // ---- C# ----
  { langs: ["csharp"], re: /The name '(\w+)' does not exist in the current context/, hint: (m, ctx) => {
    const guess = didYouMean(m[1], ctx.identifiers);
    return guess ? `${code(m[1])} isn't defined. Did you mean ${code(guess)}?` : `${code(m[1])} isn't defined: check the spelling.`;
  } },
  { langs: ["csharp"], re: /\(CS1002\)|; expected/, hint: () => `Missing ${code(";")} at the end of this line.` },
  { langs: ["csharp"], re: /\(CS1513\)|\} expected/, hint: () => `A ${code("{")} is never closed. Add the missing ${code("}")}.` },
  { langs: ["csharp"], re: /\(CS0161\)|not all code paths return a value/, hint: () => `This method must ${code("return")} a value on every path.` },
  { langs: ["csharp"], re: /FormatException/, hint: () => `${code("int.Parse")} got text that isn't a single number. If a line has several numbers, ${code("Split()")} it first.` },
  { langs: ["csharp"], re: /IndexOutOfRangeException/, hint: () => `An index is outside the array.` },

  // ---- Rust ----
  { langs: ["rust"], re: /cannot find value `(\w+)` in this scope/, hint: (m, ctx, e) => rustHelp(e) || (didYouMean(m[1], ctx.identifiers) ? `${code(m[1])} isn't defined. Did you mean ${code(didYouMean(m[1], ctx.identifiers))}?` : `${code(m[1])} isn't defined.`) },
  { langs: ["rust"], re: /index out of bounds: the len is (\d+) but the index is (\d+)/, hint: (m) => `Index ${m[2]} is outside: valid indexes are 0 to ${Number(m[1]) - 1}.` },
  { langs: ["rust"], re: /mismatched types/, hint: (m, ctx, e) => rustHelp(e) || `The value's type doesn't match what's expected here.` },
  { langs: ["rust"], re: /called `Result::unwrap\(\)` on an `Err` value: ParseIntError/, hint: () => `${code("parse()")} got text that isn't a single number. ${code("trim()")} the line, or ${code("split_whitespace()")} it first.` },

  // ---- Go ----
  { langs: ["go"], re: /declared and not used: (\w+)|(\w+) declared (?:and|but) not used/, hint: (m) => `Go refuses unused variables. Use ${code(m[1] || m[2])}, or remove it.` },
  { langs: ["go"], re: /"(\w+)" imported and not used/, hint: (m) => `Go refuses unused imports. Remove the import of ${code(m[1])}.` },
  { langs: ["go"], re: /undefined: (\w+)/, hint: (m, ctx) => {
    const guess = didYouMean(m[1], ctx.identifiers);
    return guess ? `${code(m[1])} isn't defined. Did you mean ${code(guess)}?` : `${code(m[1])} isn't defined: check the spelling (Go is case-sensitive).`;
  } },
  { langs: ["go"], re: /index out of range \[(\d+)\] with length (\d+)/, hint: (m) => `Index ${m[1]} is outside: valid indexes are 0 to ${Number(m[2]) - 1}.` },

  // ---- Ruby / PHP ----
  { langs: ["ruby"], re: /undefined local variable or method [`'](\w+)'/, hint: (m, ctx) => {
    const guess = didYouMean(m[1], ctx.identifiers);
    return guess ? `${code(m[1])} isn't defined. Did you mean ${code(guess)}?` : `${code(m[1])} isn't defined: check the spelling.`;
  } },
  { langs: ["ruby"], re: /undefined method [`']\+' for nil/, hint: () => `A value was ${code("nil")}: often ${code("gets")} returned nothing because the input ran out.` },
  { langs: ["php"], re: /Undefined variable \$(\w+)/, hint: (m, ctx) => {
    const guess = didYouMean(m[1], ctx.identifiers);
    return guess ? `${code("$" + m[1])} isn't defined. Did you mean ${code("$" + guess)}?` : `${code("$" + m[1])} isn't defined before this line.`;
  } },
  { langs: ["php"], re: /syntax error, unexpected .*expecting "?;"?|syntax error, unexpected end of file/, hint: () => `Check for a missing ${code(";")} or an unclosed ${code("{")} just before this line.` },

  // ---- C/C++ runtime ----
  { langs: ["cpp"], re: /terminate called after throwing an instance of 'std::out_of_range'/, hint: () => `${code(".at()")} was given an index outside the container.` },
  { langs: ["cpp"], re: /std::bad_alloc/, hint: () => `The program tried to allocate more memory than is allowed. Check the sizes you create.` },
  { langs: ["c", "cpp"], re: /stack smashing detected/, hint: () => `The program wrote past the end of a local array.` }
];

function cMissingFunction(name, ctx) {
  const header = headerFor(C_HEADERS, name);
  if (header) return `${code(name)} needs ${code(`#include <${header}>`)} at the top.`;
  const guess = didYouMean(name, ctx.identifiers);
  return guess ? `${code(name)} doesn't exist. Did you mean ${code(guess)}?` : `${code(name)} isn't defined: check the spelling, or define it above ${code("main")}.`;
}

function cppNotDeclared(name, compilerGuess, ctx) {
  const header = headerFor(CPP_HEADERS, name);
  if (header && !new RegExp(`\\bstd::${name}\\b`).test(ctx.code)) {
    if (["cout", "cin", "endl", "string", "vector"].includes(name) && /#include\s*<(iostream|string|vector|bits\/stdc\+\+\.h)>/.test(ctx.code) && !/using\s+namespace\s+std/.test(ctx.code)) {
      return `Add ${code("using namespace std;")} after the includes, or write ${code("std::" + name)}.`;
    }
    return `${code(name)} needs ${code(`#include <${header}>`)} (or ${code("#include <bits/stdc++.h>")}).`;
  }
  const guess = compilerGuess && compilerGuess !== "short" ? compilerGuess : didYouMean(name, ctx.identifiers);
  return guess ? `${code(name)} isn't defined. Did you mean ${code(guess)}?` : `${code(name)} isn't defined: check the spelling, and declare it before this line.`;
}

function javaCannotFind(entry, ctx) {
  const symbol = (entry.extra || []).map((d) => d.match(/^symbol:\s+(class|variable|method)\s+(\w+)/)).find(Boolean);
  if (!symbol) return `Something on this line isn't defined: check the spelling.`;
  const [, kind, name] = symbol;
  const imports = { Scanner: "java.util.Scanner", ArrayList: "java.util.ArrayList", HashMap: "java.util.HashMap", HashSet: "java.util.HashSet", List: "java.util.List", Map: "java.util.Map", Arrays: "java.util.Arrays", Collections: "java.util.Collections", BufferedReader: "java.io.BufferedReader", InputStreamReader: "java.io.InputStreamReader", IOException: "java.io.IOException", BigInteger: "java.math.BigInteger" };
  if (kind === "class" && imports[name]) return `${code(name)} needs ${code(`import ${imports[name]};`)} (or ${code(`import ${imports[name].replace(/\.\w+$/, ".*")};`)}) at the top.`;
  const guess = didYouMean(name, ctx.identifiers);
  return guess ? `${code(name)} isn't defined. Did you mean ${code(guess)}?` : `The ${kind} ${code(name)} isn't defined: check the spelling (Java is case-sensitive).`;
}

function rustHelp(entry) {
  const help = (entry.extra || []).find((h) => /similar name exists|you might have meant|try|consider/.test(h));
  return help ? help.charAt(0).toUpperCase() + help.slice(1) : null;
}

function hintFor(entry, ctx) {
  const text = [entry.message, ...(entry.extra || [])].join("\n");
  for (const h of HINTS) {
    if (h.langs && !h.langs.includes(ctx.language)) continue;
    const m = text.match(h.re);
    if (!m) continue;
    if (h.test && !h.test(entry, ctx)) continue;
    const hint = h.hint(m, ctx, entry);
    if (hint !== undefined) return hint;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Fix-ups for errors that compilers report in the wrong place.

function previousCodeLine(codeLines, line) {
  for (let i = line - 2; i >= 0; i--) {
    const t = codeLines[i].trim();
    if (t && !t.startsWith("//") && !t.startsWith("#")) return i + 1;
  }
  return null;
}

function relocate(entry, ctx) {
  const { codeLines, language } = ctx;
  if (!entry.line) return entry;
  // "expected ';' before 'x'" at the first token of a line: the ';' is missing at the end of
  // the line before. (GCC reports the token that follows the missing ';'.)
  if (["c", "cpp"].includes(language) && /^expected '[;,]'(?: or '[;,]')* before/.test(entry.message)) {
    const text = codeLines[entry.line - 1] || "";
    const firstToken = text.length - text.trimStart().length + 1;
    if (entry.column && entry.column <= firstToken) {
      const prev = previousCodeLine(codeLines, entry.line);
      if (prev) return { ...entry, line: prev, column: codeLines[prev - 1].trimEnd().length + 1, excerpt: codeLines[prev - 1] };
    }
  }
  return entry;
}

const UNCLOSED = /expected '}' at end of input|expected declaration or statement at end of input|reached end of file while parsing|Unexpected end of input|\(CS1513\)|unclosed delimiter|Expecting '}'|unexpected EOF|syntax error, unexpected end of file|unexpected end-of-input/;

function relocateUnclosed(entry, ctx) {
  if (!UNCLOSED.test(entry.message) || ctx.language === "python") return entry;
  const brace = findUnclosedBrace(ctx.code, ctx.language);
  if (!brace) return entry;
  return { ...entry, line: brace.line, column: brace.column, excerpt: ctx.codeLines[brace.line - 1], message: `'{' on line ${brace.line} is never closed (${entry.message})` };
}

// Make an entry's line point into the student's code, using the source line the tool printed.
function resolveLine(entry, ctx) {
  if (entry.line == null) return entry;
  const { codeLines, trustLines } = ctx;
  const excerpt = entry.excerpt?.trim();
  const at = codeLines[entry.line - 1];
  if (excerpt) {
    if (at !== undefined && at.trim() === excerpt) return entry;
    const matches = codeLines.map((l, i) => (l.trim() === excerpt ? i + 1 : 0)).filter(Boolean);
    if (matches.length === 1) return { ...entry, line: matches[0] };
    if (matches.length > 1) {
      // Several identical lines: the one nearest the reported line.
      const nearest = matches.reduce((a, b) => (Math.abs(b - entry.line) < Math.abs(a - entry.line) ? b : a));
      return { ...entry, line: nearest };
    }
    return { ...entry, line: null, column: null };
  }
  if (!trustLines || at === undefined) return { ...entry, line: null, column: null };
  return entry;
}

// Type noise that hides the point of a C++ message.
function cleanMessage(message) {
  return String(message || "")
    .replace(/\s*\{aka '[^']*'\}/g, "")
    .replace(/std::__cxx11::basic_string<char>/g, "std::string")
    .replace(/std::basic_string<char>/g, "std::string")
    .replace(/std::basic_ostream<char>/g, "std::ostream")
    .replace(/std::basic_istream<char>/g, "std::istream")
    .replace(/, std::allocator<[^<>]*(?:<[^<>]*>)?>/g, "")
    .replace(/std::_Rb_tree_const_iterator<(\w+)>/g, "set<$1>::iterator")
    .replace(/\s*\[-W[\w=+-]+\]\s*$/, "") // GCC's warning-flag name
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
}

const ERROR_TYPE_KIND = { runtime: "runtime", timeout: "timeout", memory_limit: "memory" };

/**
 * The same for a judge result in this platform's own shape (Run responses and stored
 * submissions: { status, stderr, details: [{ errorType, stderr, traceback, exitCode }] }).
 * Returns a copy with paths removed and a `diagnostics` array. A Python syntax error, which the
 * judge reports as a runtime error on every test, becomes one Compilation Error.
 */
export function explainJudgeResult(result, { language, code, trustLines = false }) {
  if (!result || typeof result !== "object") return result;
  const lang = String(language || "").toLowerCase();
  const out = { ...result };
  if (typeof out.stderr === "string") out.stderr = stripWorkspacePaths(out.stderr);
  if (Array.isArray(out.details)) {
    out.details = out.details.map((d) => ({
      ...d,
      ...(typeof d.stderr === "string" ? { stderr: stripWorkspacePaths(d.stderr) } : {}),
      ...(typeof d.traceback === "string" ? { traceback: stripWorkspacePaths(d.traceback) } : {})
    }));
  }
  const details = Array.isArray(out.details) ? out.details : [];

  if (lang === "python" && out.status !== "Compilation Error") {
    const syntax = details.find((d) => d.errorType === "runtime" && isPythonSyntaxError(d.stderr || d.traceback));
    if (syntax) {
      out.status = "Compilation Error";
      out.stderr = syntax.stderr || syntax.traceback;
      out.details = [];
      out.passed = out.passedCount = 0;
    }
  }

  let diagnostics = [];
  if (out.status === "Compilation Error") {
    diagnostics = analyze({ language: lang, code, compileOutput: out.stderr || out.error || "", kind: "compile", trustLines });
  } else {
    const failed = (out.details || []).find((d) => ERROR_TYPE_KIND[d.errorType]);
    if (failed) {
      diagnostics = analyze({ language: lang, code, stderr: failed.stderr || failed.traceback || "", kind: ERROR_TYPE_KIND[failed.errorType], exitCode: failed.exitCode, trustLines });
    }
  }
  out.diagnostics = diagnostics;
  return out;
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {object} p
 * @param {string} p.language        judge language key (python, cpp, java, ...)
 * @param {string} p.code            the student's source
 * @param {string} [p.compileOutput] compiler output, when compilation failed
 * @param {string} [p.stderr]        the program's stderr (or traceback)
 * @param {"compile"|"runtime"|"timeout"|"memory"} p.kind
 * @param {number} [p.exitCode]
 * @param {boolean} [p.trustLines]   true when the code ran exactly as written (stdin problems,
 *                                   the GO Judge API); false when it was wrapped in a harness
 * @returns {{ line:number|null, column:number|null, kind:string, message:string, hint:string|null }[]}
 */
export function analyze({ language, code = "", compileOutput = "", stderr = "", kind, exitCode, trustLines = true }) {
  const lang = String(language || "").toLowerCase();
  if (kind === "timeout") {
    return [{ line: null, column: null, kind, message: "Time limit exceeded", hint: "The program took too long. Look for a loop that never ends (a counter that never changes, or a condition that stays true), or a slower algorithm than the input size allows." }];
  }
  const text = stripWorkspacePaths(kind === "compile" ? compileOutput || stderr : stderr || compileOutput);
  const codeLines = String(code).replace(/\r\n/g, "\n").split("\n");
  const ctx = { language: lang, code: String(code), codeLines, trustLines, identifiers: identifiersIn(String(code), lang) };

  let entries = [];
  if (kind === "runtime" && lang === "java") entries = javaRuntimeEntries(text);
  else if (kind === "runtime" && lang === "kotlin") entries = kotlinRuntimeEntries(text);
  if (!entries.length) entries = (PARSERS[lang] || (() => []))(text);

  let errors = entries.filter((e) => e.severity !== "warning");
  if (!errors.length) errors = entries; // only warnings: show them rather than nothing

  let out = errors
    .map((e) => relocateUnclosed(e, ctx))
    .map((e) => resolveLine(e, ctx))
    .map((e) => relocate(e, ctx))
    .map((e) => ({ line: e.line ?? null, column: e.line ? e.column ?? null : null, kind: kind === "memory" ? "memory" : kind, message: cleanMessage(e.message), hint: e.hint ?? hintFor(e, ctx) }));

  if (kind === "runtime" || kind === "memory") {
    const sig = signalEntry(exitCode, text);
    if (sig && !out.length) out.push({ line: null, column: null, kind, message: sig.message, hint: kind === "memory" ? "The program used more memory than allowed. Check the sizes of the arrays and containers you create." : sig.hint });
  }
  if (!out.length && kind === "memory") {
    out.push({ line: null, column: null, kind, message: "Memory limit exceeded", hint: "The program used more memory than allowed. Check the sizes of the arrays and containers you create." });
  }
  if (!out.length && text.trim()) {
    // Nothing recognisable: the first meaningful line, so the student still sees the start.
    const first = text.split("\n").map((l) => l.trim()).find((l) => l && !/^In function|^In file included|^\s*\|/.test(l));
    if (first) out.push({ line: null, column: null, kind, message: cleanMessage(first), hint: null });
  }

  // One diagnostic per line and message; errors with a line first (they're the actionable ones),
  // keeping the tool's order otherwise.
  const seen = new Set();
  out = out.filter((d) => {
    const key = `${d.line}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const located = out.filter((d) => d.line != null);
  const unlocated = out.filter((d) => d.line == null);
  return [...located, ...unlocated].slice(0, MAX_DIAGNOSTICS);
}
