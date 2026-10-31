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

	for _, langID := range []string{"c", "go", "typescript"} {
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
