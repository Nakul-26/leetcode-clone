//go:build integration

package main

import (
	"runtime"
	"testing"

	"judge-service-go/pkg/testutil"
)

func TestPythonCentralIntegration_TimeoutDoesNotLeakGoroutines(t *testing.T) {
	exec, p, pc, lang := setupPythonIntegration(t)
	defer p.Release(pc)

	problem := twoSumProblem()
	problem.TimeLimitMs = 100
	code := `
def twoSum(nums, target):
    while True:
        pass
`

	const runs = 20
	const tolerance = 5

	// The baseline is taken after one run: a container's first use starts what lives as long as
	// the container (the pool's watchers and, with JUDGE_AGENT_LANGS, the sandbox agent's two
	// connections), which is not a leak. A leak per run grows with the runs below.
	runCentralOnce(t, exec, pc, lang, problem, code)
	testutil.StabilizeRuntime()
	before := runtime.NumGoroutine()

	for i := 0; i < runs; i++ {
		result := runCentralOnce(t, exec, pc, lang, problem, code)
		if result == nil {
			t.Fatalf("unexpected nil result during timeout run %d", i)
		}
		if len(result.Details) == 0 {
			t.Fatalf("expected timeout detail during run %d", i)
		}
		if result.Details[0].Error != "Time Limit Exceeded" {
			t.Fatalf("expected Time Limit Exceeded during run %d, got %+v", i, result.Details[0])
		}
	}

	testutil.StabilizeRuntime()

	after := runtime.NumGoroutine()
	t.Logf("goroutines before=%d after=%d", before, after)
	if after > before+tolerance {
		t.Fatalf("possible goroutine leak: before=%d after=%d tolerance=%d", before, after, tolerance)
	}
}
