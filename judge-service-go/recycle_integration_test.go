//go:build integration

package main

import (
	"context"
	"testing"
	"time"

	"judge-service-go/pkg/executor"
	"judge-service-go/pkg/languages"
)

// TestRecycleHasNoGap drives a one-container pool through several run limits and checks that
// the next submission never waits for a replacement: each container's successor is prepared
// before its limit and takes its place when it retires.
func TestRecycleHasNoGap(t *testing.T) {
	exec, err := executor.NewExecutor()
	if err != nil {
		t.Skipf("docker client unavailable: %v", err)
	}
	lang := languages.GetLanguage("python")
	p := newTestPool(t, exec.Client(), 4)
	t.Cleanup(func() { p.Shutdown(context.Background()) })
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if err := p.WarmUp(ctx, lang.ID, lang.ImageRef(), 1, 1); err != nil {
		t.Skipf("warm-up failed (is %q available?): %v", lang.ImageRef(), err)
	}
	// Limits of 36-40 runs: the successor is prepared 3-4 runs ahead, ~2 s at 600 ms a run.
	p.SetMaxExecutions(40)

	const runs = 130 // at least three retirements
	var retired []string
	var worst time.Duration
	for i := 0; i < runs; i++ {
		start := time.Now()
		acqCtx, acqCancel := context.WithTimeout(context.Background(), 30*time.Second)
		pc := p.Acquire(acqCtx, lang.ID)
		acqCancel()
		wait := time.Since(start)
		if pc == nil {
			t.Fatalf("run %d: no container within 30 s", i)
		}
		if wait > worst {
			worst = wait
		}
		time.Sleep(600 * time.Millisecond) // the submission
		if _, retire := p.CountExecution(pc); retire {
			retired = append(retired, pc.ID)
			p.Discard(context.Background(), pc, "max executions reached")
		} else {
			p.Release(pc)
		}
	}
	if len(retired) < 3 {
		t.Fatalf("only %d containers retired in %d runs", len(retired), runs)
	}
	t.Logf("%d retirements, longest wait for a container %v", len(retired), worst)
	if worst > 500*time.Millisecond {
		t.Fatalf("a submission waited %v for a container across a retirement", worst)
	}
}
