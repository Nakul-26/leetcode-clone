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

func setupCppIntegration(t *testing.T) (*executor.Executor, *pool.ContainerPool, *pool.PooledContainer, *languages.Language) {
	t.Helper()

	exec, err := executor.NewExecutor()
	if err != nil {
		t.Skipf("docker client unavailable: %v", err)
	}

	lang := languages.GetLanguage("cpp")
	if lang == nil {
		t.Fatal("cpp language config not found")
	}

	p := newTestPool(t, exec.Client(), 1)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := p.WarmUp(ctx, lang.ID, lang.Image, 1, 1); err != nil {
		t.Skipf("cpp container warm-up failed (is %q image available?): %v", lang.Image, err)
	}

	pc := p.Acquire(ctx, lang.ID)
	if pc == nil {
		t.Fatal("failed to acquire pooled cpp container")
	}

	return exec, p, pc, lang
}

func twoSumProblemCpp() models.Problem {
	return models.Problem{
		Title:        "Two Sum",
		Description:  "integration test",
		FunctionName: "twoSum",
		ReturnType:   "array<number>",
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

func runCentralCppOnce(t *testing.T, exec *executor.Executor, pc *pool.PooledContainer, lang *languages.Language, problem models.Problem, code string) *models.SubmissionResult {
	t.Helper()

	msg := models.SubmissionMessage{
		SubmissionID: "integration-test-cpp",
		ProblemID:    "integration-problem-cpp",
		Language:     "cpp",
		FunctionName: problem.FunctionName,
		Code:         code,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
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

func TestCppCentralIntegration_CorrectSolution(t *testing.T) {
	exec, p, pc, lang := setupCppIntegration(t)
	defer p.Release(pc)
	problem := twoSumProblemCpp()
	code := `
#include <vector>
#include <unordered_map>

class Solution {
public:
    std::vector<int> twoSum(std::vector<int>& nums, int target) {
        std::unordered_map<int, int> map;
        for (int i = 0; i < nums.size(); i++) {
            int complement = target - nums[i];
            if (map.find(complement) != map.end()) {
                return {map[complement], i};
            }
            map[nums[i]] = i;
        }
        return {};
    }
};
`

	result := runCentralCppOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total || result.Total != 1 {
		t.Fatalf("expected accepted result, got %+v", result)
	}
	if result.ExecutionPath != models.ExecutionPathCentral {
		t.Fatalf("expected central executionPath, got %+v", result)
	}
}

func TestCppCentralIntegration_BatchedCorrectSolution(t *testing.T) {
	t.Setenv("JUDGE_BATCH_THRESHOLD_CPP", "2")

	exec, p, pc, lang := setupCppIntegration(t)
	defer p.Release(pc)

	problem := models.Problem{
		Title:        "Two Sum",
		Description:  "integration test",
		FunctionName: "twoSum",
		ReturnType:   "array<number>",
		Parameters: []models.Parameter{
			{Name: "nums", Type: "array<number>"},
			{Name: "target", Type: "number"},
		},
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
#include <vector>

class Solution {
public:
    std::vector<int> twoSum(std::vector<int>& nums, int target) {
        for (int i = 0; i < nums.size(); i++) {
            for (int j = i + 1; j < nums.size(); j++) {
                if (nums[i] + nums[j] == target) {
                    return {i, j};
                }
            }
        }
        return {};
    }
};
`

	result := runCentralCppOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != 2 || result.Total != 2 {
		t.Fatalf("expected accepted batched result, got %+v", result)
	}
}
