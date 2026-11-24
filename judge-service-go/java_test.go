//go:build integration

package main

import (
	"judge-service-go/pkg/models"
	"testing"
)

func TestJavaSimple(t *testing.T) {
	exec, p, pc, lang := setupIntegration(t, "java")
	defer p.Release(pc)

	problem := models.Problem{
		Title:        "Add",
		FunctionName: "add",
		ReturnType:   "number",
		Parameters: []models.Parameter{
			{Name: "a", Type: "number"},
			{Name: "b", Type: "number"},
		},
		TestCases: []models.TestCase{
			{Input: []interface{}{float64(1), float64(2)}, Expected: int64(3)},
		},
	}
	code := "public class Solution { public int add(int a, int b) { return a + b; } }"

	result := runCertificationTest(t, exec, pc, lang, problem, code, "test-java")
	if result.Status != models.SubmissionStatusAccepted {
		t.Fatalf("expected Accepted, got %q. Stderr: %q", result.Status, result.Stderr)
	}
}
