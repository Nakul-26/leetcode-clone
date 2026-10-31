//go:build integration

package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"judge-service-go/pkg/models"
)

// JUDGE_FIX_PLAN T5: stdin submissions run every test in one exec (stdinRunnerScript). Each
// test still gets its own verdict, a test that hangs is stopped and the tests after it still
// run, and the result matches the one-exec-per-test path (JUDGE_STDIN_BATCH=0).
func TestStdinBatchedVerdicts(t *testing.T) {
	programs := map[string]string{
		"python": "import sys\n" +
			"n = int(input())\n" +
			"if n == 3:\n    raise ValueError('boom')\n" +
			"if n == 4:\n    while True: pass\n" +
			"if n == 5:\n    sys.stdout.write('x' * 100000)\n    sys.exit(0)\n" +
			"print(n * 2)\n",
		"cpp": "#include <bits/stdc++.h>\nint main(){ long long n; std::cin >> n;\n" +
			" if (n == 3) { std::cerr << \"boom\"; return 3; }\n" +
			" if (n == 4) { volatile long long x = 0; while (true) x++; }\n" +
			" if (n == 5) { std::string s(100000, 'x'); std::cout << s; return 0; }\n" +
			" std::cout << n * 2 << \"\\n\"; }\n",
		"go": "package main\nimport (\"fmt\"; \"os\"; \"strings\")\nfunc main(){ var n int; fmt.Scan(&n)\n" +
			" if n == 3 { fmt.Fprint(os.Stderr, \"boom\"); os.Exit(3) }\n" +
			" if n == 4 { x := 0; for { x++ } }\n" +
			" if n == 5 { fmt.Print(strings.Repeat(\"x\", 100000)); return }\n" +
			" fmt.Println(n * 2) }\n",
		"java": "import java.util.*;\npublic class Main { public static void main(String[] a) {\n" +
			" int n = new Scanner(System.in).nextInt();\n" +
			" if (n == 3) throw new RuntimeException(\"boom\");\n" +
			" if (n == 4) { long x = 0; while (true) x++; }\n" +
			" if (n == 5) { System.out.print(\"x\".repeat(100000)); return; }\n" +
			" System.out.println(n * 2); } }\n",
	}
	programs["kotlin"] = "fun main() {\n" +
		" val n = readLine()!!.trim().toInt()\n" +
		" if (n == 3) { System.err.print(\"boom\"); kotlin.system.exitProcess(3) }\n" +
		" if (n == 4) { var x = 0L; while (true) x++ }\n" +
		" if (n == 5) { print(\"x\".repeat(100000)); return }\n" +
		" println(n * 2) }\n"
	programs["csharp"] = "using System;\npublic class Program { public static void Main() {\n" +
		" int n = int.Parse(Console.ReadLine()!.Trim());\n" +
		" if (n == 3) { Console.Error.Write(\"boom\"); Environment.Exit(3); }\n" +
		" if (n == 4) { long x = 0; while (true) x++; }\n" +
		" if (n == 5) { Console.Write(new string('x', 100000)); return; }\n" +
		" Console.WriteLine(n * 2); } }\n"
	problem := models.Problem{
		Title: "stdin-batch", Type: models.StdinProblem, TimeLimitMs: 1000,
		TestCases: []models.TestCase{
			{Input: []interface{}{"1\n"}, Expected: "2\n"},
			{Input: []interface{}{"2\n"}, Expected: "5\n"},  // wrong answer
			{Input: []interface{}{"3\n"}, Expected: "6\n"},  // crash
			{Input: []interface{}{"4\n"}, Expected: "8\n"},  // never ends
			{Input: []interface{}{"5\n"}, Expected: "10\n"}, // too much output
			{Input: []interface{}{"6\n"}, Expected: "12\n"},
			{Input: []interface{}{"7\n"}, Expected: nil}, // run and report only
		},
	}
	wantRun := []string{"ok", models.ErrorTypeWrongAnswer, models.ErrorTypeRuntime, models.ErrorTypeTimeout, models.ErrorTypeWrongAnswer, "ok", "ok"}

	for _, langID := range []string{"python", "cpp", "go", "java", "kotlin", "csharp"} {
		t.Run(langID, func(t *testing.T) {
			exec, p, pc, _ := setupIntegration(t, langID)
			defer p.Release(pc)
			run := func(stop bool) *models.SubmissionResult {
				t.Helper()
				ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
				defer cancel()
				msg := models.SubmissionMessage{SubmissionID: "stdin-batch-" + langID, ProblemID: "stdin-batch",
					Language: langID, Code: programs[langID], ProblemType: models.StdinProblem, StopOnFirstFailure: stop}
				res, _, err := runSubmissionStdinDetailed(ctx, exec, pc, msg, problem)
				if err != nil {
					t.Fatalf("run: %v", err)
				}
				if err := exec.ResetContainer(ctx, pc.ID); err != nil {
					t.Fatalf("reset: %v", err)
				}
				return res
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

			started := time.Now()
			res := run(false)
			got := verdicts(res)
			if strings.Join(got, ",") != strings.Join(wantRun, ",") {
				for _, d := range res.Details {
					t.Logf("test %d: passed=%v %s %s exit=%d out=%.60q tb=%.120q", d.Test, d.Passed, d.ErrorType, d.Error, d.ExitCode, d.Stdout, d.Traceback)
				}
				t.Fatalf("Run: verdicts %v, want %v (status %s, stderr %.300s)", got, wantRun, res.Status, res.Stderr)
			}
			if d := res.Details[2]; !strings.Contains(d.Traceback+d.Stderr, "boom") {
				t.Errorf("crash: the program's stderr is missing: %+v", d)
			}
			if d := res.Details[4]; d.Error != "Output Limit Exceeded" {
				t.Errorf("test 5: want Output Limit Exceeded, got %q", d.Error)
			}
			if d := res.Details[6]; d.Output != "14\n" {
				t.Errorf("test 7: output %q, want the program's stdout", d.Output)
			}
			for i, d := range res.Details {
				if d.Test != i+1 {
					t.Fatalf("result %d is numbered %d", i, d.Test)
				}
				if d.TimeMs < 0 {
					t.Fatalf("test %d: negative time %d", d.Test, d.TimeMs)
				}
			}
			t.Logf("Run: %v in %v", got, time.Since(started).Round(time.Millisecond))

			got = verdicts(run(true))
			want := []string{"ok", models.ErrorTypeWrongAnswer, models.ErrorTypeNotRun, models.ErrorTypeNotRun, models.ErrorTypeNotRun, models.ErrorTypeNotRun, models.ErrorTypeNotRun}
			if strings.Join(got, ",") != strings.Join(want, ",") {
				t.Fatalf("Submit: verdicts %v, want %v", got, want)
			}
		})
	}
}
