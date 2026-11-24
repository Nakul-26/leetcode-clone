//go:build integration

package main

import (
	"context"
	"testing"
	"time"

	"judge-service-go/pkg/central/adapters"
	"judge-service-go/pkg/models"
)

func runGoTest(t *testing.T, problem models.Problem, code string, expectedStatus string) {
	exec, p, pc, lang := setupIntegration(t, "go")
	defer p.Release(pc)

	msg := models.SubmissionMessage{
		SubmissionID:  "go-test-" + problem.Title,
		ProblemID:     "go-problem-" + problem.Title,
		Language:      lang.ID,
		FunctionName:  problem.FunctionName,
		Code:          code,
		SchemaVersion: "v2",
	}
	adapter, ok := adapters.GetAdapter(lang.ID)
	if !ok {
		t.Fatalf("adapter not found for language %q", lang.ID)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	result, err := runSubmissionCentral(ctx, exec, pc, msg, problem, adapter)
	if err != nil {
		t.Fatalf("runSubmissionCentral failed: %v", err)
	}
	if result.Status != expectedStatus {
		t.Fatalf("[%s] expected %s, got %s. Stderr: %q", problem.Title, expectedStatus, result.Status, result.Stderr)
	}
}

func TestGoIntegration_Primitive(t *testing.T) {
	problem := models.Problem{
		Title: "Add", FunctionName: "add", ReturnType: "number",
		Parameters: []models.Parameter{{Name: "a", Type: "number"}, {Name: "b", Type: "number"}},
		TestCases:  []models.TestCase{{Input: []interface{}{float64(1), float64(2)}, Expected: int64(3)}},
	}
	code := `package main
func add(a, b int) int { return a + b }`
	runGoTest(t, problem, code, models.SubmissionStatusAccepted)
}

func TestGoIntegration_Array(t *testing.T) {
	problem := models.Problem{
		Title: "SumArray", FunctionName: "sum", ReturnType: "number",
		Parameters: []models.Parameter{{Name: "nums", Type: "array<number>"}},
		TestCases:  []models.TestCase{{Input: []interface{}{[]interface{}{float64(1), float64(2), float64(3)}}, Expected: int64(6)}},
	}
	code := `package main
func sum(nums []int) int {
	s := 0
	for _, n := range nums { s += n }
	return s
}`
	runGoTest(t, problem, code, models.SubmissionStatusAccepted)
}

func TestGoIntegration_LinkedList(t *testing.T) {
	problem := models.Problem{
		Title: "ReverseList", FunctionName: "reverseList", ReturnType: "linkedlist<number>",
		Parameters: []models.Parameter{{Name: "head", Type: "linkedlist<number>"}},
		TestCases:  []models.TestCase{{Input: []interface{}{[]interface{}{float64(1), float64(2)}}, Expected: []interface{}{int64(2), int64(1)}}},
	}
	code := `package main
func reverseList(head *ListNode) *ListNode {
	var prev *ListNode
	curr := head
	for curr != nil {
		next := curr.Next
		curr.Next = prev
		prev = curr
		curr = next
	}
	return prev
}`
	runGoTest(t, problem, code, models.SubmissionStatusAccepted)
}

func TestGoIntegration_Tree(t *testing.T) {
	problem := models.Problem{
		Title: "MaxDepth", FunctionName: "maxDepth", ReturnType: "number",
		Parameters: []models.Parameter{{Name: "root", Type: "tree<number>"}},
		TestCases:  []models.TestCase{{Input: []interface{}{[]interface{}{float64(1), float64(2), float64(3)}}, Expected: int64(2)}},
	}
	code := `package main
func maxDepth(root *TreeNode) int {
	if root == nil { return 0 }
	l, r := maxDepth(root.Left), maxDepth(root.Right)
	if l > r { return 1 + l }
	return 1 + r
}`
	runGoTest(t, problem, code, models.SubmissionStatusAccepted)
}

func TestGoIntegration_CompileError(t *testing.T) {
	problem := models.Problem{
		Title: "SyntaxError", FunctionName: "f", ReturnType: "void",
		Parameters: []models.Parameter{{Name: "n", Type: "number"}},
		TestCases:  []models.TestCase{{Input: []interface{}{float64(1)}, Expected: nil}},
	}
	code := `package main
func f(n int) { return 1 + }`
	runGoTest(t, problem, code, models.SubmissionStatusCompilationError)
}

func TestGoIntegration_RuntimeError(t *testing.T) {
	problem := models.Problem{
		Title: "Panic", FunctionName: "panicFunc", ReturnType: "void",
		Parameters: []models.Parameter{{Name: "n", Type: "number"}},
		TestCases:  []models.TestCase{{Input: []interface{}{float64(1)}, Expected: nil}},
	}
	code := `package main
func panicFunc(n int) { panic("boom") }`
	runGoTest(t, problem, code, models.SubmissionStatusRuntimeError)
}

func TestGoIntegration_Timeout(t *testing.T) {
	problem := models.Problem{
		Title: "InfiniteLoop", FunctionName: "loop", ReturnType: "void", TimeLimitMs: 500,
		Parameters: []models.Parameter{{Name: "n", Type: "number"}},
		TestCases:  []models.TestCase{{Input: []interface{}{float64(1)}, Expected: nil}},
	}
	code := `package main
func loop(n int) { for {} }`
	runGoTest(t, problem, code, models.SubmissionStatusTimeLimitExceeded)
}
