package main

import (
	"strings"
	"testing"

	"judge-service-go/pkg/models"
)

// A function problem whose code fails before any test runs: the failed test carries Python's
// own error, not the wrapper's JSON lines.
func TestAttachCrashOutputKeepsTheProgramsErrorOnly(t *testing.T) {
	result := &models.SubmissionResult{}
	result.AddTestResult(models.TestResult{Test: 1, Error: "Runtime Error"})
	result.AddTestResult(models.TestResult{Test: 2, Error: "Runtime Error"})

	stderr := "{\"ready\":true}\n  File \"/app/wrapper.py\", line 9\n    return sum(nums)\n    ^\nIndentationError: expected an indented block after function definition on line 8\n"
	attachCrashOutput(result, 1, stderr)

	got := result.Details[0].Traceback
	if !strings.HasPrefix(got, "File \"/app/wrapper.py\", line 9") || !strings.HasSuffix(got, "on line 8") {
		t.Fatalf("traceback = %q", got)
	}
	if strings.Contains(got, "ready") {
		t.Fatalf("protocol line kept: %q", got)
	}
	if result.Details[1].Traceback != "" {
		t.Fatalf("only the test the process was on gets the output, got %q on test 2", result.Details[1].Traceback)
	}

	attachCrashOutput(result, 1, "later output")
	if result.Details[0].Traceback != got {
		t.Fatal("an existing traceback is not overwritten")
	}
}
