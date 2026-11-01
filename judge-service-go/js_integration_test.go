//go:build integration

package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"judge-service-go/pkg/central/adapters"
	"judge-service-go/pkg/executor"
	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/pool"
)

func setupJSIntegration(t *testing.T) (*executor.Executor, *pool.ContainerPool, *pool.PooledContainer, *languages.Language) {
	t.Helper()

	exec, err := executor.NewExecutor()
	if err != nil {
		t.Skipf("docker client unavailable: %v", err)
	}

	lang := languages.GetLanguage("javascript")
	if lang == nil {
		t.Fatal("javascript language config not found")
	}

	p := newTestPool(t, exec.Client(), 1)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := p.WarmUp(ctx, lang.ID, lang.Image, 1, 1); err != nil {
		t.Skipf("javascript container warm-up failed (is %q image available?): %v", lang.Image, err)
	}

	pc := p.Acquire(ctx, lang.ID)
	if pc == nil {
		t.Fatal("failed to acquire pooled javascript container")
	}

	return exec, p, pc, lang
}

func twoSumProblemJS() models.Problem {
	return models.Problem{
		Title:        "Two Sum",
		Description:  "integration test",
		FunctionName: "twoSum",
		ReturnType:   "array",
		Parameters: []models.Parameter{
			{Name: "nums", Type: "array<number>"},
			{Name: "target", Type: "number"},
		},
		TestCases: []models.TestCase{
			{
				Input:    []interface{}{[]interface{}{float64(2), float64(7), float64(11), float64(15)}, float64(9)},
				Expected: []interface{}{int64(0), int64(1)},
			},
		},
		CompareConfig: models.CompareConfig{Mode: "EXACT"},
	}
}

func runCentralJSOnce(t *testing.T, exec *executor.Executor, pc *pool.PooledContainer, lang *languages.Language, problem models.Problem, code string) *models.SubmissionResult {
	t.Helper()

	msg := models.SubmissionMessage{
		SubmissionID: "integration-test-js",
		ProblemID:    "integration-problem-js",
		Language:     "javascript",
		FunctionName: problem.FunctionName,
		Code:         code,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
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
	return result
}

func TestJSCentralIntegration_CorrectSolution(t *testing.T) {
	exec, p, pc, lang := setupJSIntegration(t)
	defer p.Release(pc)
	problem := twoSumProblemJS()
	code := `
function twoSum(nums, target) {
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      if (nums[i] + nums[j] === target) {
        return [i, j];
      }
    }
  }
}
`

	result := runCentralJSOnce(t, exec, pc, lang, problem, code)
	if result.Passed != result.Total || result.Total != 1 {
		t.Fatalf("expected accepted-like result 1/1, got %d/%d detail=%+v", result.Passed, result.Total, result.Details)
	}
	if result.Status != models.SubmissionStatusAccepted {
		t.Fatalf("expected status %q, got %q", models.SubmissionStatusAccepted, result.Status)
	}
	if result.ExecutionPath != models.ExecutionPathCentral {
		t.Fatalf("expected central executionPath, got %+v", result)
	}
	if result.InternalError != "" {
		t.Fatalf("expected empty internalError for user-success path, got %+v", result)
	}
	if !result.Details[0].Passed || !result.Details[0].Ok {
		t.Fatalf("expected test to pass, detail=%+v", result.Details[0])
	}
	if result.Details[0].ErrorType != "" {
		t.Fatalf("expected empty errorType for passing test, detail=%+v", result.Details[0])
	}
	if result.Details[0].TimeMs < 0 {
		t.Fatalf("expected non-negative timeMs, detail=%+v", result.Details[0])
	}
}

func TestJSCentralIntegration_WrongAnswer(t *testing.T) {
	exec, p, pc, lang := setupJSIntegration(t)
	defer p.Release(pc)
	problem := twoSumProblemJS()
	code := `
function twoSum(nums, target) {
  return [0, 0];
}
`

	result := runCentralJSOnce(t, exec, pc, lang, problem, code)
	if result.Passed >= result.Total {
		t.Fatalf("expected wrong-answer-like result with partial/zero pass, got %d/%d", result.Passed, result.Total)
	}
	if result.Status != models.SubmissionStatusWrongAnswer {
		t.Fatalf("expected status %q, got %q", models.SubmissionStatusWrongAnswer, result.Status)
	}
	if result.Details[0].Passed || result.Details[0].Ok {
		t.Fatalf("expected test to fail, detail=%+v", result.Details[0])
	}
	if result.Details[0].ErrorType != models.ErrorTypeWrongAnswer {
		t.Fatalf("expected wrong_answer errorType, detail=%+v", result.Details[0])
	}
}

func TestJSCentralIntegration_RuntimeError(t *testing.T) {
	exec, p, pc, lang := setupJSIntegration(t)
	defer p.Release(pc)
	problem := twoSumProblemJS()
	code := `
function twoSum(nums, target) {
  throw new Error("boom");
}
`

	result := runCentralJSOnce(t, exec, pc, lang, problem, code)
	if result.Details[0].Error != "Runtime Error" {
		t.Fatalf("expected Runtime Error, got %q", result.Details[0].Error)
	}
	if result.Details[0].ErrorType != models.ErrorTypeRuntime {
		t.Fatalf("expected runtime errorType, detail=%+v", result.Details[0])
	}
	if result.Status != models.SubmissionStatusRuntimeError {
		t.Fatalf("expected status %q, got %q", models.SubmissionStatusRuntimeError, result.Status)
	}
	if result.Details[0].Stderr != "" {
		t.Fatalf("expected stderr hidden from client payload, got %q", result.Details[0].Stderr)
	}
}

func TestJSCentralIntegration_TimeLimitExceeded(t *testing.T) {
	exec, p, pc, lang := setupJSIntegration(t)
	defer p.Release(pc)
	problem := twoSumProblemJS()
	problem.TimeLimitMs = 100
	code := `
function twoSum(nums, target) {
  while (true) {}
}
`

	result := runCentralJSOnce(t, exec, pc, lang, problem, code)
	if result.Details[0].Error != "Time Limit Exceeded" {
		t.Fatalf("expected Time Limit Exceeded, got %q detail=%+v", result.Details[0].Error, result.Details[0])
	}
	if result.Details[0].ErrorType != models.ErrorTypeTimeout {
		t.Fatalf("expected timeout errorType, detail=%+v", result.Details[0])
	}
	if result.Status != models.SubmissionStatusTimeLimitExceeded {
		t.Fatalf("expected status %q, got %q", models.SubmissionStatusTimeLimitExceeded, result.Status)
	}
}

func TestJSCentralIntegration_OutputLimitExceeded(t *testing.T) {
	exec, p, pc, lang := setupJSIntegration(t)
	defer p.Release(pc)
	problem := twoSumProblemJS()
	code := `
function twoSum(nums, target) {
  console.log("A".repeat(100000));
  return [0, 1];
}
`

	result := runCentralJSOnce(t, exec, pc, lang, problem, code)
	if result.Details[0].Error != "Output Limit Exceeded" {
		t.Fatalf("expected Output Limit Exceeded, got %q detail=%+v", result.Details[0].Error, result.Details[0])
	}
	if result.Details[0].ErrorType != models.ErrorTypeWrongAnswer {
		t.Fatalf("expected wrong_answer errorType, detail=%+v", result.Details[0])
	}
	if result.Status != models.SubmissionStatusWrongAnswer {
		t.Fatalf("expected status %q, got %q", models.SubmissionStatusWrongAnswer, result.Status)
	}
	if !strings.Contains(result.Details[0].Stdout, "A") {
		t.Fatalf("expected captured stdout to contain user output")
	}
	if len(result.Details[0].Stdout) > 64*1024 {
		t.Fatalf("expected stdout in payload to be capped at 64KB, got %d bytes", len(result.Details[0].Stdout))
	}
}

func TestJSCentralIntegration_ContainerPoolReuse(t *testing.T) {
	exec, p, pc, lang := setupJSIntegration(t)
	released := false
	t.Cleanup(func() {
		if !released {
			p.Release(pc)
		}
	})
	problem := twoSumProblemJS()
	code := `
function twoSum(nums, target) {
  return [0, 1];
}
`

	_ = runCentralJSOnce(t, exec, pc, lang, problem, code)
	_ = runCentralJSOnce(t, exec, pc, lang, problem, code)

	shortCtx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	extra := p.Acquire(shortCtx, lang.ID)
	cancel()
	if extra != nil {
		t.Fatalf("expected no second container while one is in use, got %s", extra.ID)
	}

	p.Release(pc)
	reacquired := p.Acquire(context.Background(), lang.ID)
	if reacquired == nil {
		t.Fatal("expected to reacquire pooled container")
	}
	if reacquired.ID != pc.ID {
		t.Fatalf("expected pooled container reuse, got old=%s new=%s", pc.ID, reacquired.ID)
	}
	p.Release(reacquired)
	released = true
}

func TestJSCentralIntegration_BatchedCorrectSolution(t *testing.T) {
	t.Setenv("JUDGE_BATCH_THRESHOLD_JS", "2")

	exec, p, pc, lang := setupJSIntegration(t)
	defer p.Release(pc)

	problem := models.Problem{
		Title:        "Two Sum",
		Description:  "batched integration test",
		FunctionName: "twoSum",
		ReturnType:   "array",
		TestCases: []models.TestCase{
			{
				Input:    []interface{}{[]interface{}{float64(2), float64(7), float64(11), float64(15)}, float64(9)},
				Expected: []interface{}{int64(0), int64(1)},
			},
			{
				Input:    []interface{}{[]interface{}{float64(3), float64(2), float64(4)}, float64(6)},
				Expected: []interface{}{int64(1), int64(2)},
			},
		},
		CompareConfig: models.CompareConfig{Mode: "EXACT"},
	}

	code := `
function twoSum(nums, target) {
  const seen = new Map();
  for (let i = 0; i < nums.length; i++) {
    if (seen.has(target - nums[i])) {
      return [seen.get(target - nums[i]), i];
    }
    seen.set(nums[i], i);
  }
}
`

	result := runCentralJSOnce(t, exec, pc, lang, problem, code)
	if result.Passed != result.Total || result.Total != 2 {
		t.Fatalf("expected 2/2 batched result, got %d/%d detail=%+v", result.Passed, result.Total, result.Details)
	}
	if result.Status != models.SubmissionStatusAccepted {
		t.Fatalf("expected status %q, got %q", models.SubmissionStatusAccepted, result.Status)
	}
	for _, detail := range result.Details {
		if detail.TimeMs < 0 {
			t.Fatalf("expected non-negative timeMs, detail=%+v", detail)
		}
	}
}
