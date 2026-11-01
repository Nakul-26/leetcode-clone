//go:build integration

package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"judge-service-go/pkg/central/adapters"
	"judge-service-go/pkg/executor"
	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/pool"
)

const (
	stressPoolSize       = 4
	defaultStressRuns    = 24
	defaultStressTests   = 10
	stressAcquireTimeout = 60 * time.Second
	stressRunTimeout     = 45 * time.Second
)

func TestCentralRunnerStress(t *testing.T) {
	t.Run("python", func(t *testing.T) {
		runCentralRunnerStress(t, "python", "two_sum", pythonTwoSumCode())
	})

	t.Run("javascript", func(t *testing.T) {
		runCentralRunnerStress(t, "javascript", "twoSum", jsTwoSumCode())
	})
}

func runCentralRunnerStress(t *testing.T, languageID string, functionName string, code string) {
	t.Helper()

	exec, p, lang, adapter := setupCentralStress(t, languageID)
	stressSubmissionRuns := getenvInt("JUDGE_STRESS_SUBMISSIONS", defaultStressRuns)
	stressTestCases := getenvInt("JUDGE_STRESS_TESTS", defaultStressTests)
	problem := makeStressProblem(functionName, stressTestCases)

	errCh := make(chan error, stressSubmissionRuns)
	var wg sync.WaitGroup
	start := make(chan struct{})

	for i := 0; i < stressSubmissionRuns; i++ {
		wg.Add(1)

		go func(idx int) {
			defer wg.Done()
			<-start

			runErr := runOneStressSubmission(exec, p, lang, adapter, problem, stressTestCases, languageID, functionName, code, idx)
			if runErr != nil {
				errCh <- runErr
			}
		}(i)
	}

	close(start)
	wg.Wait()
	close(errCh)

	for err := range errCh {
		t.Error(err)
	}
}

func getenvInt(name string, fallback int) int {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func setupCentralStress(t *testing.T, languageID string) (*executor.Executor, *pool.ContainerPool, *languages.Language, adapters.LanguageAdapter) {
	t.Helper()

	exec, err := executor.NewExecutor()
	if err != nil {
		t.Skipf("docker client unavailable: %v", err)
	}

	lang := languages.GetLanguage(languageID)
	if lang == nil {
		t.Fatalf("language config not found for %q", languageID)
	}

	adapter, ok := adapters.GetAdapter(languageID)
	if !ok {
		t.Fatalf("adapter not found for %q", languageID)
	}

	p := newTestPool(t, exec.Client(), stressPoolSize)
	t.Cleanup(func() {
		p.Shutdown(context.Background())
	})
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := p.WarmUp(ctx, lang.ID, lang.Image, stressPoolSize, stressPoolSize); err != nil {
		t.Skipf("%s container warm-up failed (is %q image available?): %v", lang.ID, lang.Image, err)
	}

	return exec, p, lang, adapter
}

func runOneStressSubmission(exec *executor.Executor, p *pool.ContainerPool, lang *languages.Language, adapter adapters.LanguageAdapter, problem models.Problem, expectedTests int, languageID string, functionName string, code string, idx int) error {
	acquireCtx, cancelAcquire := context.WithTimeout(context.Background(), stressAcquireTimeout)
	defer cancelAcquire()

	pc, err := acquirePooledContainer(acquireCtx, p, lang.ID)
	if err != nil {
		return fmt.Errorf("[%s submission=%d] failed to acquire container: %w", languageID, idx, err)
	}
	defer p.Release(pc)

	msg := models.SubmissionMessage{
		SubmissionID: fmt.Sprintf("stress-%s-%03d", languageID, idx),
		ProblemID:    fmt.Sprintf("stress-problem-%s", languageID),
		Language:     languageID,
		FunctionName: functionName,
		Code:         code,
	}

	runCtx, cancelRun := context.WithTimeout(context.Background(), stressRunTimeout)
	defer cancelRun()

	result, err := runSubmissionCentral(runCtx, exec, pc, msg, problem, adapter)
	if err != nil {
		return fmt.Errorf("[%s submission=%d] runSubmissionCentral failed: %w", languageID, idx, err)
	}

	if result == nil {
		return fmt.Errorf("[%s submission=%d] nil result", languageID, idx)
	}
	if result.Status != models.SubmissionStatusAccepted {
		return fmt.Errorf("[%s submission=%d] unexpected status %q", languageID, idx, result.Status)
	}
	if result.Total != expectedTests {
		return fmt.Errorf("[%s submission=%d] expected %d tests, got %d", languageID, idx, expectedTests, result.Total)
	}
	if result.Passed != result.Total {
		return fmt.Errorf("[%s submission=%d] expected all tests to pass, got %d/%d", languageID, idx, result.Passed, result.Total)
	}

	for _, detail := range result.Details {
		if !detail.Ok {
			return fmt.Errorf("[%s submission=%d] test %d failed unexpectedly: error=%q output=%v", languageID, idx, detail.Test, detail.Error, detail.Output)
		}
	}

	return nil
}

func acquirePooledContainer(ctx context.Context, p *pool.ContainerPool, langID string) (*pool.PooledContainer, error) {
	pc := p.Acquire(ctx, langID)
	if pc == nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("failed to acquire container for %s", langID)
	}
	return pc, nil
}

func makeStressProblem(functionName string, testCount int) models.Problem {
	testCases := make([]models.TestCase, 0, testCount)
	for i := 0; i < testCount; i++ {
		a := i + 2
		b := i + 7
		nums := []interface{}{float64(a), float64(b), float64(a + b), float64(i)}
		target := float64(a + b)
		testCases = append(testCases, models.TestCase{
			Input:    []interface{}{nums, target},
			Expected: []interface{}{int64(0), int64(1)},
		})
	}

	return models.Problem{
		Title:         "Stress Two Sum",
		Description:   "central runner stress integration test",
		FunctionName:  functionName,
		ReturnType:    "array",
		TestCases:     testCases,
		CompareConfig: models.CompareConfig{Mode: "EXACT"},
	}
}

func pythonTwoSumCode() string {
	return `
def two_sum(nums, target):
    for i in range(len(nums)):
        for j in range(i + 1, len(nums)):
            if nums[i] + nums[j] == target:
                return [i, j]
`
}

func jsTwoSumCode() string {
	return `
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
}
