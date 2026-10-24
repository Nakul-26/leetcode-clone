//go:build integration

package main

import (
	"context"
	"testing"
	"time"

	"judge-service-go/pkg/central/adapters"
	"judge-service-go/pkg/executor"
	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/pool"
)

func setupIntegration(t *testing.T, languageID string) (*executor.Executor, *pool.ContainerPool, *pool.PooledContainer, *languages.Language) {
	t.Helper()

	exec, err := executor.NewExecutor()
	if err != nil {
		t.Skipf("docker client unavailable: %v", err)
	}

	lang := languages.GetLanguage(languageID)
	if lang == nil {
		t.Fatalf("%s language config not found", languageID)
	}

	p := pool.NewPool(exec.Client(), 1)
	t.Cleanup(func() {
		p.Shutdown(context.Background())
	})
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if err := p.WarmUp(ctx, lang.ID, lang.Image, 1, 1); err != nil {
		t.Skipf("%s container warm-up failed (is %q image available?): %v", lang.ID, lang.Image, err)
	}

	pc := p.Acquire(context.Background(), lang.ID)
	if pc == nil {
		t.Fatalf("failed to acquire pooled %s container", lang.ID)
	}

	return exec, p, pc, lang
}

func runCertificationTest(t *testing.T, exec *executor.Executor, pc *pool.PooledContainer, lang *languages.Language, problem models.Problem, code string, submissionID string) *models.SubmissionResult {
	t.Helper()

	msg := models.SubmissionMessage{
		SubmissionID: submissionID,
		ProblemID:    "cert-problem-" + problem.Title,
		Language:     lang.ID,
		FunctionName: problem.FunctionName,
		Code:         code,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	adapter, ok := adapters.GetAdapter(lang.ID)
	if !ok {
		t.Fatalf("adapter not found for language %q", lang.ID)
	}

	result, err := runSubmissionCentral(ctx, exec, pc, msg, problem, adapter)
	if err != nil {
		t.Fatalf("runSubmissionCentral failed: %v", err)
	}
	if result == nil {
		t.Fatal("nil result")
	}
	// Production resets a container when it is released (finishWithContainer); per-test steps
	// no longer clean up after a clean exit (JUDGE_FIX_PLAN T5), so do the same between runs here.
	if err := exec.ResetContainer(ctx, pc.ID); err != nil {
		t.Fatalf("container reset failed: %v", err)
	}
	return result
}
