//go:build integration

package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"judge-service-go/pkg/central/adapters"
	"judge-service-go/pkg/models"
)

// JUDGE_FIX_PLAN T5: C and Go function-mode submissions run all their tests in one process too.
// Same checks as TestBatchedRunResumesAfterATestKillsTheProcess, plus each test's own stdout
// and Output Limit Exceeded for a test that prints too much.
func TestBatchedCompiledLanguages(t *testing.T) {
	type program struct{ resume, prints string }
	programs := map[string]program{
		"c": {
			resume: "#include <stdlib.h>\n#include <string.h>\n" +
				"int f(int n) {\n" +
				"  if (n == 2) { volatile int x = 0; while (1) x++; }\n" +
				"  if (n == 3) exit(3);\n" +
				// The asm keeps gcc -O2 from dropping the unused allocation.
				"  if (n == 4) { char* p = malloc(1 << 30); memset(p, 1, 1 << 30); asm volatile(\"\" : : \"r\"(p) : \"memory\"); return p[5]; }\n" +
				"  return n;\n}\n",
			prints: "#include <stdio.h>\n" +
				"int f(int n) {\n" +
				"  if (n == 1) { for (int i = 0; i < 100000; i++) putchar('x'); return 1; }\n" +
				"  printf(\"hi %d\", n); return n;\n}\n",
		},
		"go": {
			resume: "import \"os\"\n" +
				"func f(n int) int {\n" +
				"  if n == 2 { x := 0; for { x++ } }\n" +
				"  if n == 3 { os.Exit(3) }\n" +
				"  if n == 4 { b := make([]byte, 1<<30); for i := 0; i < len(b); i += 4096 { b[i] = 1 }; return int(b[5]) }\n" +
				"  return n\n}\n",
			prints: "import (\"fmt\"; \"strings\")\n" +
				"func f(n int) int {\n" +
				"  if n == 1 { fmt.Print(strings.Repeat(\"x\", 100000)); return 1 }\n" +
				"  fmt.Printf(\"hi %d\", n); return n\n}\n",
		},
	}
	programs["typescript"] = program{
		resume: "function f(n: number): number {\n" +
			"  if (n === 2) { while (true) {} }\n" +
			"  if (n === 3) { process.exit(3); }\n" +
			"  if (n === 4) { const b = Buffer.alloc(1 << 30, 1); return b[5]; }\n" +
			"  return n;\n}\n",
		prints: "function f(n: number): number {\n" +
			"  if (n === 1) { console.log('x'.repeat(100000)); return 1; }\n" +
			"  process.stdout.write('hi ' + n); return n;\n}\n",
	}
	programs["kotlin"] = program{
		resume: "class Solution {\n" +
			"  fun f(n: Int): Int {\n" +
			"    if (n == 2) { var x = 0L; while (true) x++ }\n" +
			"    if (n == 3) kotlin.system.exitProcess(3)\n" +
			"    if (n == 4) { val a = ArrayList<LongArray>(); while (true) a.add(LongArray(1 shl 20) { 1L }) }\n" +
			"    return n\n  }\n}\n",
		prints: "class Solution {\n" +
			"  fun f(n: Int): Int {\n" +
			"    if (n == 1) { print(\"x\".repeat(100000)); return 1 }\n" +
			"    print(\"hi $n\"); return n\n  }\n}\n",
	}
	programs["csharp"] = program{
		resume: "public class Solution {\n" +
			"  public int f(int n) {\n" +
			"    if (n == 2) { long x = 0; while (true) x++; }\n" +
			"    if (n == 3) System.Environment.Exit(3);\n" +
			"    if (n == 4) { var a = new System.Collections.Generic.List<long[]>(); while (true) { var b = new long[1 << 20]; System.Array.Fill(b, 1L); a.Add(b); } }\n" +
			"    return n;\n  }\n}\n",
		prints: "public class Solution {\n" +
			"  public int f(int n) {\n" +
			"    if (n == 1) { System.Console.Write(new string('x', 100000)); return 1; }\n" +
			"    System.Console.Write(\"hi \" + n); return n;\n  }\n}\n",
	}
	programs["ruby"] = program{
		resume: "def f(n)\n" +
			"  if n == 2\n    x = 0\n    loop { x += 1 }\n  end\n" +
			"  exit!(3) if n == 3\n" +
			"  if n == 4\n    s = 'x' * (1 << 30)\n    return s.size\n  end\n" +
			"  n\nend\n",
		prints: "def f(n)\n" +
			"  if n == 1\n    print('x' * 100000)\n    return 1\n  end\n" +
			"  print(\"hi #{n}\")\n  n\nend\n",
	}
	programs["php"] = program{
		resume: "function f($n) {\n" +
			"  if ($n == 2) { $x = 0; while (true) { $x++; } }\n" +
			"  if ($n == 3) { exit(3); }\n" +
			"  if ($n == 4) { $s = str_repeat('x', 1 << 30); return strlen($s); }\n" +
			"  return $n;\n}\n",
		prints: "function f($n) {\n" +
			"  if ($n == 1) { echo str_repeat('x', 100000); return 1; }\n" +
			"  echo \"hi $n\"; return $n;\n}\n",
	}
	programs["rust"] = program{
		resume: "struct Solution;\nimpl Solution {\n" +
			"  fn f(&self, n: i32) -> i32 {\n" +
			"    if n == 2 { let mut x: u64 = 0; loop { x = std::hint::black_box(x + 1); } }\n" +
			"    if n == 3 { std::process::exit(3); }\n" +
			"    if n == 4 { let v = vec![1u8; 1 << 30]; return std::hint::black_box(&v)[5] as i32; }\n" +
			"    n\n  }\n}\n",
		prints: "struct Solution;\nimpl Solution {\n" +
			"  fn f(&self, n: i32) -> i32 {\n" +
			"    if n == 1 { print!(\"{}\", \"x\".repeat(100000)); return 1; }\n" +
			"    print!(\"hi {}\", n); n\n  }\n}\n",
	}
	resumeProblem := models.Problem{
		Title: "resume", FunctionName: "f", ReturnType: "number", TimeLimitMs: 1000, MemoryLimitMb: 256,
		Parameters: []models.Parameter{{Name: "n", Type: "number"}},
		TestCases: []models.TestCase{
			{Input: []interface{}{float64(1)}, Expected: float64(1)},
			{Input: []interface{}{float64(2)}, Expected: float64(2)}, // loops forever
			{Input: []interface{}{float64(3)}, Expected: float64(3)}, // exits
			{Input: []interface{}{float64(4)}, Expected: float64(4)}, // runs out of memory
			{Input: []interface{}{float64(5)}, Expected: float64(5)},
			{Input: []interface{}{float64(6)}, Expected: float64(0)}, // wrong answer
		},
	}
	printsProblem := models.Problem{
		Title: "prints", FunctionName: "f", ReturnType: "number", TimeLimitMs: 2000,
		Parameters: []models.Parameter{{Name: "n", Type: "number"}},
		TestCases: []models.TestCase{
			{Input: []interface{}{float64(1)}, Expected: float64(1)}, // prints 100 KB
			{Input: []interface{}{float64(2)}, Expected: float64(2)},
			{Input: []interface{}{float64(3)}, Expected: float64(3)},
		},
	}
	verdicts := func(res *models.SubmissionResult) []string {
		var v []string
		for _, d := range res.Details {
			if d.Passed {
				v = append(v, "ok")
			} else {
				v = append(v, d.ErrorType)
			}
		}
		return v
	}

	for _, langID := range []string{"c", "go", "typescript", "kotlin", "csharp", "ruby", "php", "rust"} {
		t.Run(langID, func(t *testing.T) {
			if !shouldUseBatchedExecution(langID, 1) {
				t.Fatalf("%s is not batched", langID)
			}
			exec, p, pc, lang := setupIntegration(t, langID)
			defer p.Release(pc)
			adapter, _ := adapters.GetAdapter(lang.ID)
			run := func(problem models.Problem, code string) *models.SubmissionResult {
				t.Helper()
				ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
				defer cancel()
				msg := models.SubmissionMessage{SubmissionID: "batch-" + langID, ProblemID: problem.Title, Language: lang.ID,
					FunctionName: "f", Code: code}
				res, err := runSubmissionCentral(ctx, exec, pc, msg, problem, adapter)
				if err != nil {
					t.Fatalf("run: %v", err)
				}
				if err := exec.ResetContainer(ctx, pc.ID); err != nil {
					t.Fatalf("reset: %v", err)
				}
				return res
			}

			res := run(resumeProblem, programs[langID].resume)
			want := []string{"ok", models.ErrorTypeTimeout, models.ErrorTypeRuntime, models.ErrorTypeMemoryLimit, "ok", models.ErrorTypeWrongAnswer}
			if langID == "php" {
				// PHP stops at its own memory_limit with a fatal error before the container's limit.
				want[3] = models.ErrorTypeRuntime
			}
			if got := verdicts(res); strings.Join(got, ",") != strings.Join(want, ",") {
				for _, d := range res.Details {
					t.Logf("test %d: %s %s tb=%.200q", d.Test, d.ErrorType, d.Error, d.Traceback)
				}
				t.Fatalf("resume: verdicts %v, want %v (stderr %.400s)", got, want, res.Stderr)
			}

			res = run(printsProblem, programs[langID].prints)
			want = []string{models.ErrorTypeWrongAnswer, "ok", "ok"}
			if got := verdicts(res); strings.Join(got, ",") != strings.Join(want, ",") {
				t.Fatalf("prints: verdicts %v, want %v (stderr %.400s)", got, want, res.Stderr)
			}
			if d := res.Details[0]; d.Error != "Output Limit Exceeded" {
				t.Errorf("test 1: want Output Limit Exceeded, got %q", d.Error)
			}
			for i, wantOut := range []string{"", "hi 2", "hi 3"} {
				if i > 0 && res.Details[i].Stdout != wantOut {
					t.Errorf("test %d: stdout %q, want %q", i+1, res.Details[i].Stdout, wantOut)
				}
			}
		})
	}
}
