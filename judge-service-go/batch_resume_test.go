//go:build integration

package main

import (
	"context"
	"testing"
	"time"

	"judge-service-go/pkg/central/adapters"
	"judge-service-go/pkg/models"
)

// JUDGE_FIX_PLAN T5: function-mode submissions run all their tests in one process. A test that
// kills the process gets the verdict and the tests after it still run, in a new process, so
// every test gets its own result as it did with one exec per test.
func TestBatchedRunResumesAfterATestKillsTheProcess(t *testing.T) {
	exec, p, pc, lang := setupIntegration(t, "python")
	defer p.Release(pc)
	adapter, _ := adapters.GetAdapter(lang.ID)

	problem := models.Problem{
		Title: "resume", FunctionName: "f", ReturnType: "number", TimeLimitMs: 1000, MemoryLimitMb: 256,
		Parameters: []models.Parameter{{Name: "n", Type: "number"}},
		TestCases: []models.TestCase{
			{Input: []interface{}{float64(1)}, Expected: float64(1)},
			{Input: []interface{}{float64(2)}, Expected: float64(2)}, // loops forever
			{Input: []interface{}{float64(3)}, Expected: float64(3)}, // kills the process
			{Input: []interface{}{float64(4)}, Expected: float64(4)}, // runs out of memory
			{Input: []interface{}{float64(5)}, Expected: float64(5)},
			{Input: []interface{}{float64(6)}, Expected: float64(0)}, // wrong answer
		},
	}
	code := "def f(n):\n" +
		"    if n == 2:\n        while True: pass\n" +
		"    if n == 3:\n        raise SystemExit(3)\n" +
		"    if n == 4:\n        x = bytearray(1 << 30)\n        return len(x)\n" +
		"    return n\n"

	run := func(stopOnFailure bool) *models.SubmissionResult {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()
		msg := models.SubmissionMessage{SubmissionID: "resume", ProblemID: "resume", Language: lang.ID,
			FunctionName: "f", Code: code, StopOnFirstFailure: stopOnFailure}
		res, err := runSubmissionCentral(ctx, exec, pc, msg, problem, adapter)
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
	want := []string{"ok", models.ErrorTypeTimeout, models.ErrorTypeRuntime, models.ErrorTypeMemoryLimit, "ok", models.ErrorTypeWrongAnswer}
	if len(got) != len(want) {
		t.Fatalf("Run: %d results %v, want %v", len(got), got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			for _, d := range res.Details {
				t.Logf("test %d: %s %s %.300s", d.Test, d.Error, d.Traceback, d.Stderr)
			}
			t.Fatalf("Run: verdicts %v, want %v (stderr %.500s)", got, want, res.Stderr)
		}
	}
	for i, d := range res.Details {
		if d.Test != i+1 {
			t.Fatalf("Run: result %d is numbered %d", i, d.Test)
		}
	}
	t.Logf("Run (all tests, three restarts): %v in %v", got, time.Since(started).Round(time.Millisecond))

	got = verdicts(run(true))
	want = []string{"ok", models.ErrorTypeTimeout, models.ErrorTypeNotRun, models.ErrorTypeNotRun, models.ErrorTypeNotRun, models.ErrorTypeNotRun}
	for i := range want {
		if i >= len(got) || got[i] != want[i] {
			t.Fatalf("Submit: verdicts %v, want %v", got, want)
		}
	}

	// A program that fails before any test runs is not restarted once per test.
	code = "def f(n):\n    return n +\n"
	started = time.Now()
	res = run(false)
	if res.Passed != 0 || len(res.Details) != len(problem.TestCases) {
		t.Fatalf("syntax error: %d passed of %d results", res.Passed, len(res.Details))
	}
	if took := time.Since(started); took > 10*time.Second {
		t.Fatalf("syntax error took %v: restarted for every test?", took)
	}
}
