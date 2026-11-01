//go:build integration

package main

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"judge-service-go/pkg/central/adapters"
	"judge-service-go/pkg/executor"
	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
)

func BenchmarkPerTestExecution50Tests(b *testing.B) {
	benchmarkCentralRunnerPython(b, "1000")
}

func BenchmarkBatchedExecution50Tests(b *testing.B) {
	benchmarkCentralRunnerPython(b, "1")
}

func benchmarkCentralRunnerPython(b *testing.B, threshold string) {
	prevThreshold, hadThreshold := os.LookupEnv("JUDGE_BATCH_THRESHOLD_PY")
	if err := os.Setenv("JUDGE_BATCH_THRESHOLD_PY", threshold); err != nil {
		b.Fatalf("failed to set batch threshold: %v", err)
	}
	defer func() {
		if hadThreshold {
			_ = os.Setenv("JUDGE_BATCH_THRESHOLD_PY", prevThreshold)
			return
		}
		_ = os.Unsetenv("JUDGE_BATCH_THRESHOLD_PY")
	}()

	exec, err := executor.NewExecutor()
	if err != nil {
		b.Skipf("docker client unavailable: %v", err)
	}

	lang := languages.GetLanguage("python")
	if lang == nil {
		b.Fatal("python language config not found")
	}

	adapter, ok := adapters.GetAdapter(lang.ID)
	if !ok {
		b.Fatalf("adapter not found for language %q", lang.ID)
	}

	p := newTestPool(b, exec.Client(), 1)
	warmCtx, warmCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer warmCancel()
	if err := p.WarmUp(warmCtx, lang.ID, lang.Image, 1, 1); err != nil {
		b.Skipf("python container warm-up failed (is %q image available?): %v", lang.Image, err)
	}

	problem := makeStressProblem("two_sum", 50)
	msg := models.SubmissionMessage{
		SubmissionID: "benchmark-python",
		ProblemID:    "benchmark-problem-python",
		Language:     "python",
		FunctionName: "two_sum",
		Code:         pythonTwoSumCode(),
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		runCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		pc, err := acquirePooledContainer(runCtx, p, lang.ID)
		if err != nil {
			cancel()
			b.Fatalf("failed to acquire pooled container: %v", err)
		}

		msg.SubmissionID = fmt.Sprintf("benchmark-python-%d", i)
		result, err := runSubmissionCentral(runCtx, exec, pc, msg, problem, adapter)
		p.Release(pc)
		cancel()
		if err != nil {
			b.Fatalf("runSubmissionCentral failed: %v", err)
		}
		if result == nil || result.Passed != result.Total || result.Total != len(problem.TestCases) {
			b.Fatalf("unexpected benchmark result: %+v", result)
		}
	}
}
