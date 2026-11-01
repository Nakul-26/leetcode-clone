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

func setupCIntegration(t *testing.T) (*executor.Executor, *pool.ContainerPool, *pool.PooledContainer, *languages.Language) {
	t.Helper()

	exec, err := executor.NewExecutor()
	if err != nil {
		t.Skipf("docker client unavailable: %v", err)
	}

	lang := languages.GetLanguage("c")
	if lang == nil {
		t.Fatal("c language config not found")
	}

	p := newTestPool(t, exec.Client(), 1)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := p.WarmUp(ctx, lang.ID, lang.Image, 1, 1); err != nil {
		t.Skipf("c container warm-up failed (is %q image available?): %v", lang.Image, err)
	}

	pc := p.Acquire(ctx, lang.ID)
	if pc == nil {
		t.Fatal("failed to acquire pooled c container")
	}

	return exec, p, pc, lang
}

func addProblemC() models.Problem {
	return models.Problem{
		Title:        "Add",
		Description:  "integration test",
		FunctionName: "add",
		ReturnType:   "number",
		Parameters: []models.Parameter{
			{Name: "a", Type: "number"},
			{Name: "b", Type: "number"},
		},
		TestCases: []models.TestCase{
			{
				Input:    []interface{}{float64(2), float64(3)},
				Expected: int64(5),
			},
		},
		CompareConfig: models.CompareConfig{Mode: "EXACT"},
	}
}

func runCentralCOnce(t *testing.T, exec *executor.Executor, pc *pool.PooledContainer, lang *languages.Language, problem models.Problem, code string) *models.SubmissionResult {
	t.Helper()

	msg := models.SubmissionMessage{
		SubmissionID: "integration-test-c",
		ProblemID:    "integration-problem-c",
		Language:     "c",
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

func TestCCentralIntegration_CorrectSolution(t *testing.T) {
	exec, p, pc, lang := setupCIntegration(t)
	defer p.Release(pc)
	problem := addProblemC()
	code := `
int add(int a, int b) {
    return a + b;
}
`

	result := runCentralCOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total || result.Total != 1 {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestCCentralIntegration_LinkedList(t *testing.T) {
	exec, p, pc, lang := setupCIntegration(t)
	defer p.Release(pc)
	
	problem := models.Problem{
		Title:        "Reverse List",
		FunctionName: "reverseList",
		ReturnType:   "linkedlist<number>",
		Parameters: []models.Parameter{
			{Name: "head", Type: "linkedlist<number>"},
		},
		TestCases: []models.TestCase{
			{
				Input:    []interface{}{[]interface{}{float64(1), float64(2), float64(3)}},
				Expected: []interface{}{int64(3), int64(2), int64(1)},
			},
		},
		CompareConfig: models.CompareConfig{Mode: "EXACT"},
	}
	
	code := `
struct ListNode* reverseList(struct ListNode* head) {
    struct ListNode* prev = NULL;
    struct ListNode* curr = head;
    while (curr) {
        struct ListNode* next = curr->next;
        curr->next = prev;
        prev = curr;
        curr = next;
    }
    return prev;
}
`

	result := runCentralCOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != 1 {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestCCentralIntegration_Array(t *testing.T) {
	exec, p, pc, lang := setupCIntegration(t)
	defer p.Release(pc)
	
	problem := models.Problem{
		Title:        "Sum Array",
		FunctionName: "sumArray",
		ReturnType:   "number",
		Parameters: []models.Parameter{
			{Name: "nums", Type: "array<number>"},
		},
		TestCases: []models.TestCase{
			{
				Input:    []interface{}{[]interface{}{float64(1), float64(2), float64(3), float64(4)}},
				Expected: int64(10),
			},
		},
		CompareConfig: models.CompareConfig{Mode: "EXACT"},
	}
	
	code := `
int sumArray(int* nums, int numsSize) {
    int sum = 0;
    for (int i = 0; i < numsSize; i++) {
        sum += nums[i];
    }
    return sum;
}
`

	result := runCentralCOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != 1 {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestCCentralIntegration_Matrix(t *testing.T) {
	exec, p, pc, lang := setupCIntegration(t)
	defer p.Release(pc)
	
	problem := models.Problem{
		Title:        "Diagonal Sum",
		FunctionName: "diagonalSum",
		ReturnType:   "number",
		Parameters: []models.Parameter{
			{Name: "mat", Type: "matrix<number>"},
		},
		TestCases: []models.TestCase{
			{
				Input:    []interface{}{[]interface{}{[]interface{}{float64(1), float64(2)}, []interface{}{float64(3), float64(4)}}},
				Expected: int64(5),
			},
		},
		CompareConfig: models.CompareConfig{Mode: "EXACT"},
	}
	
	code := `
int diagonalSum(int** mat, int matRows, int* matCols) {
    int sum = 0;
    for (int i = 0; i < matRows; i++) {
        if (i < matCols[i]) {
            sum += mat[i][i];
        }
    }
    return sum;
}
`

	result := runCentralCOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != 1 {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}
