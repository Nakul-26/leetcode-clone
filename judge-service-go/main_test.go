package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"judge-service-go/pkg/executor"
	"judge-service-go/pkg/models"
)

func TestParseSingleTestOutput_ValidJSON(t *testing.T) {
	out, remaining, err := parseSingleTestOutput("", `{"output":[1,2]}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if remaining != "" {
		t.Errorf("expected empty remaining stdout, got %q", remaining)
	}
	if out.Output == nil {
		t.Fatalf("expected output to be present")
	}
}

func TestParseSingleTestOutput_LastLineFallback(t *testing.T) {
	out, remaining, err := parseSingleTestOutput("hello", "{\"output\":42}\n")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(remaining, "hello") {
		t.Errorf("expected remaining to contain 'hello', got %q", remaining)
	}
	if out.Output == nil {
		t.Fatalf("expected parsed output from last line")
	}
}

func TestParseSingleTestOutput_Invalid(t *testing.T) {
	_, _, err := parseSingleTestOutput("", "not-json")
	if err == nil {
		t.Fatalf("expected parse error")
	}
}

func TestPerTestTimeout_DefaultAndProblemValue(t *testing.T) {
	if got := perTestTimeout(models.Problem{}); got != defaultSandboxTimeout {
		t.Fatalf("expected default timeout %v, got %v", defaultSandboxTimeout, got)
	}

	problem := models.Problem{TimeLimitMs: 1500}
	if got := perTestTimeout(problem); got != 1500*time.Millisecond {
		t.Fatalf("expected 1500ms timeout, got %v", got)
	}
}

func TestStartedResultMarksCentralExecutionPath(t *testing.T) {
	result := startedResult(models.Problem{})
	if result.ExecutionPath != models.ExecutionPathCentral {
		t.Fatalf("expected executionPath %q, got %+v", models.ExecutionPathCentral, result)
	}
	if result.InternalError != "" {
		t.Fatalf("expected empty internalError, got %+v", result)
	}
	if result.StartedAt == nil {
		t.Fatalf("expected startedAt to be set")
	}
}

func TestFallbackResultForExecutionFailureClassification(t *testing.T) {
	tests := []struct {
		name         string
		execErr      error
		stdout       string
		wantInternal string
		wantStatus   string
	}{
		{
			name:         "invalid judge output becomes judge error",
			stdout:       "not-json",
			wantInternal: models.InternalErrorJudge,
			wantStatus:   models.SubmissionStatusRuntimeError,
		},
		{
			name:         "non-timeout exec error becomes wrapper error",
			execErr:      errors.New("execution failed with exit code 2"),
			wantInternal: models.InternalErrorWrapper,
			wantStatus:   models.SubmissionStatusRuntimeError,
		},
		{
			name:         "timeout exec error is not internal",
			execErr:      executor.NewExecutionError(executor.ErrTimeLimitExceeded, "", 0),
			wantInternal: "",
			wantStatus:   models.SubmissionStatusTimeLimitExceeded,
		},
		{
			name:         "compilation failure is not internal",
			execErr:      executor.NewExecutionError(executor.ErrCompilationFailed, "", 1),
			wantInternal: "",
			wantStatus:   models.SubmissionStatusCompilationError,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := fallbackResultForExecutionFailure(models.ExecutionPathLegacy, tt.execErr, tt.stdout)
			if result.ExecutionPath != models.ExecutionPathLegacy {
				t.Fatalf("expected legacy executionPath, got %+v", result)
			}
			if result.Status != tt.wantStatus {
				t.Fatalf("expected status %q, got %+v", tt.wantStatus, result)
			}
			if result.InternalError != tt.wantInternal {
				t.Fatalf("expected internalError %q, got %+v", tt.wantInternal, result)
			}
		})
	}
}

func TestShouldDiscardContainer(t *testing.T) {
	tests := []struct {
		name          string
		execErr       error
		result        *models.SubmissionResult
		cleanupFailed bool
		wantDiscard   bool
	}{
		{
			name:          "cleanup failure discards",
			cleanupFailed: true,
			wantDiscard:   true,
		},
		{
			name:        "timeout execution error keeps the container (reset kills leftovers)",
			execErr:     executor.NewExecutionError(executor.ErrTimeLimitExceeded, "", -1),
			wantDiscard: false,
		},
		{
			name:        "memory execution error keeps the container",
			execErr:     executor.NewExecutionError(executor.ErrMemoryLimitExceeded, "", 137),
			wantDiscard: false,
		},
		{
			name:        "runtime exit error keeps the container",
			execErr:     executor.NewExecutionError(executor.ErrRuntimeError, "exit code 2", 2),
			wantDiscard: false,
		},
		{
			name:        "memory reset failure discards",
			execErr:     executor.NewExecutionError(executor.ErrContainerUnhealthy, "failed to reset memory limit", -1),
			wantDiscard: true,
		},
		{
			name:        "normal compilation error does not discard",
			execErr:     executor.NewExecutionError(executor.ErrCompilationFailed, "syntax error", 1),
			wantDiscard: false,
		},
		{
			name:        "compile timeout keeps the container",
			execErr:     executor.NewExecutionError(executor.ErrCompilationFailed, "context deadline exceeded", -1),
			wantDiscard: false,
		},
		{
			name:        "compile against a stopped container discards",
			execErr:     executor.NewExecutionError(executor.ErrCompilationFailed, "Container abc is not running", -1),
			wantDiscard: true,
		},
		{
			name: "captured user runtime error does not discard",
			result: &models.SubmissionResult{
				Status: models.SubmissionStatusRuntimeError,
				Details: []models.TestResult{{
					Test:      1,
					Error:     models.SubmissionStatusRuntimeError,
					ErrorType: models.ErrorTypeRuntime,
				}},
			},
			wantDiscard: false,
		},
		{
			name: "central timeout result keeps the container",
			result: &models.SubmissionResult{
				Status: models.SubmissionStatusTimeLimitExceeded,
			},
			wantDiscard: false,
		},
		{
			name: "wrapper internal error discards",
			result: &models.SubmissionResult{
				Status:        models.SubmissionStatusRuntimeError,
				InternalError: models.InternalErrorWrapper,
			},
			wantDiscard: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, reason := shouldDiscardContainer(tt.execErr, tt.result, tt.cleanupFailed)
			if got != tt.wantDiscard {
				t.Fatalf("expected discard=%v, got discard=%v reason=%q", tt.wantDiscard, got, reason)
			}
			if got && reason == "" {
				t.Fatalf("expected discard reason")
			}
		})
	}
}

func TestIsCentralCompareEnabled_DefaultsAndOverrides(t *testing.T) {
	t.Run("python defaults enabled", func(t *testing.T) {
		restoreEnv(t, centralComparePythonEnv)
		os.Unsetenv(centralComparePythonEnv)
		if !isCentralCompareEnabled("python") {
			t.Fatalf("expected python central compare enabled by default")
		}
	})

	t.Run("javascript defaults enabled", func(t *testing.T) {
		restoreEnv(t, centralCompareJSEnv)
		os.Unsetenv(centralCompareJSEnv)
		if !isCentralCompareEnabled("javascript") {
			t.Fatalf("expected javascript central compare enabled by default")
		}
	})

	t.Run("java defaults enabled", func(t *testing.T) {
		restoreEnv(t, centralCompareJavaEnv)
		os.Unsetenv(centralCompareJavaEnv)
		if !isCentralCompareEnabled("java") {
			t.Fatalf("expected java central compare enabled by default")
		}
	})

	t.Run("cpp defaults enabled", func(t *testing.T) {
		restoreEnv(t, centralCompareCppEnv)
		os.Unsetenv(centralCompareCppEnv)
		if !isCentralCompareEnabled("cpp") {
			t.Fatalf("expected cpp central compare enabled by default")
		}
	})

	t.Run("python explicit false disables", func(t *testing.T) {
		t.Setenv(centralComparePythonEnv, "false")
		if isCentralCompareEnabled("python") {
			t.Fatalf("expected python central compare disabled when env=false")
		}
	})

	t.Run("javascript explicit false disables", func(t *testing.T) {
		t.Setenv(centralCompareJSEnv, "false")
		if isCentralCompareEnabled("javascript") {
			t.Fatalf("expected javascript central compare disabled when env=false")
		}
	})

	t.Run("java explicit false disables", func(t *testing.T) {
		t.Setenv(centralCompareJavaEnv, "false")
		if isCentralCompareEnabled("java") {
			t.Fatalf("expected java central compare disabled when env=false")
		}
	})

	t.Run("cpp explicit false disables", func(t *testing.T) {
		t.Setenv(centralCompareCppEnv, "false")
		if isCentralCompareEnabled("cpp") {
			t.Fatalf("expected cpp central compare disabled when env=false")
		}
	})

	t.Run("unsupported language stays legacy", func(t *testing.T) {
		// c and ruby both gained real central-compare adapters (see
		// pkg/central/adapters.AdapterRegistry) and are covered by their own
		// cases/defaults above and in "modern languages always enabled" — use a
		// language absent from both isCentralCompareEnabled and the adapter registry
		// to exercise the actual default:false fallback.
		if isCentralCompareEnabled("cobol") {
			t.Fatalf("expected cobol to remain on legacy path")
		}
		if isCentralCompareEnabled("haskell") {
			t.Fatalf("expected haskell to remain on legacy path")
		}
	})

	t.Run("modern languages always enabled", func(t *testing.T) {
		if !isCentralCompareEnabled("go") {
			t.Fatalf("expected go to be enabled")
		}
		if !isCentralCompareEnabled("csharp") {
			t.Fatalf("expected csharp to be enabled")
		}
		if !isCentralCompareEnabled("typescript") {
			t.Fatalf("expected typescript to be enabled")
		}
	})
}

func restoreEnv(t *testing.T, key string) {
	t.Helper()

	value, ok := os.LookupEnv(key)
	t.Cleanup(func() {
		var err error
		if ok {
			err = os.Setenv(key, value)
		} else {
			err = os.Unsetenv(key)
		}
		if err != nil {
			t.Fatalf("failed to restore env %s: %v", key, err)
		}
	})
}

func TestReadBoundedLineRejectsOversizedLine(t *testing.T) {
	reader := bufio.NewReader(strings.NewReader("123456\n"))
	_, err := readBoundedLine(reader, 4)
	if !errors.Is(err, errBatchedOutputLimitExceeded) {
		t.Fatalf("expected output limit error, got %v", err)
	}
}

func TestAppendBatchedResultsParsesJSONLines(t *testing.T) {
	result := models.NewSubmissionResult()
	problem := models.Problem{
		TestCases: []models.TestCase{
			{Expected: float64(3)},
			{Expected: float64(5)},
		},
		CompareConfig: models.CompareConfig{Mode: "EXACT"},
	}

	// Judge metadata (the JSON lines the wrapper emits) goes to stderr, not stdout —
	// see central_runner.go's appendBatchedResults comment and the wrapper templates'
	// `fmt.Fprintln(os.Stderr, ...)`. stdout is reserved for the student's own prints.
	stderr := "{\"test\":1,\"output\":3}\n{\"test\":2,\"error\":\"boom\"}\n"
	processed, err := appendBatchedResults(result, strings.NewReader(""), strings.NewReader(stderr), problem)
	if err != nil {
		t.Fatalf("appendBatchedResults failed: %v", err)
	}
	if processed != 2 {
		t.Fatalf("expected 2 processed tests, got %d", processed)
	}
	if result.Passed != 1 || result.Total != 2 {
		t.Fatalf("unexpected totals: passed=%d total=%d", result.Passed, result.Total)
	}
	if result.PassedCount != 1 || result.TotalCount != 2 {
		t.Fatalf("unexpected count aliases: passedCount=%d totalCount=%d", result.PassedCount, result.TotalCount)
	}
	if result.FirstFailedTest != 2 {
		t.Fatalf("expected first failed test 2, got %d", result.FirstFailedTest)
	}
	if result.Details[1].Error != "Runtime Error" {
		t.Fatalf("expected runtime error for second test, got %+v", result.Details[1])
	}
	if result.Details[0].Passed != result.Details[0].Ok || result.Details[1].Passed != result.Details[1].Ok {
		t.Fatalf("expected passed/ok aliases kept in sync, got %+v", result.Details)
	}
	if result.Details[0].ErrorType != "" {
		t.Fatalf("expected empty errorType for passing test, got %+v", result.Details[0])
	}
	if result.Details[1].ErrorType != models.ErrorTypeRuntime {
		t.Fatalf("expected runtime errorType for second test, got %+v", result.Details[1])
	}
	if result.Status != models.SubmissionStatusRuntimeError {
		t.Fatalf("expected overall status %q, got %q", models.SubmissionStatusRuntimeError, result.Status)
	}
	if result.Details[0].TimeMs < 0 || result.Details[1].TimeMs < 0 {
		t.Fatalf("expected non-negative timeMs for batched tests, got %+v", result.Details)
	}
	if result.MaxTimeMs < 0 {
		t.Fatalf("expected non-negative maxTimeMs for batched tests, got %d", result.MaxTimeMs)
	}
}

func TestAppendMissingBatchedResultsMarksRemainingFailed(t *testing.T) {
	result := models.NewSubmissionResult()
	result.AddTestResult(models.TestResult{Test: 1, Ok: true})

	problem := models.Problem{
		TestCases: []models.TestCase{
			{Expected: float64(3)},
			{Expected: float64(5)},
			{Expected: float64(8)},
		},
	}

	appendMissingBatchedResults(result, problem, 1, "Runtime Error")
	if result.Total != 3 {
		t.Fatalf("expected 3 total tests, got %d", result.Total)
	}
	if result.Details[1].Error != "Runtime Error" || result.Details[2].Error != "Runtime Error" {
		t.Fatalf("expected remaining tests marked failed, got %+v", result.Details)
	}
	if result.Details[1].ErrorType != models.ErrorTypeRuntime || result.Details[2].ErrorType != models.ErrorTypeRuntime {
		t.Fatalf("expected remaining tests marked runtime errorType, got %+v", result.Details)
	}
	if result.FirstFailedTest != 2 {
		t.Fatalf("expected first failed test 2, got %d", result.FirstFailedTest)
	}
}

func TestTestResultJSONIncludesTimeMsWhenZero(t *testing.T) {
	tr := models.TestResult{Test: 1, Passed: true, Ok: true, TimeMs: 0}
	tr.Normalize()
	payload, err := json.Marshal(tr)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if !strings.Contains(string(payload), "\"timeMs\":0") {
		t.Fatalf("expected timeMs in json payload, got %s", payload)
	}
	if !strings.Contains(string(payload), "\"passed\":true") {
		t.Fatalf("expected passed in json payload, got %s", payload)
	}
	if strings.Contains(string(payload), "\"errorType\"") {
		t.Fatalf("expected passed test payload to omit errorType, got %s", payload)
	}
}

func TestTestResultNormalizeBackfillsErrorType(t *testing.T) {
	tests := []struct {
		name          string
		tr            models.TestResult
		wantPassed    bool
		wantErrorType string
	}{
		{
			name:          "passed test clears error type",
			tr:            models.TestResult{Ok: true, Error: models.SubmissionStatusRuntimeError},
			wantPassed:    true,
			wantErrorType: "",
		},
		{
			name:          "runtime from legacy error",
			tr:            models.TestResult{Error: models.SubmissionStatusRuntimeError},
			wantPassed:    false,
			wantErrorType: models.ErrorTypeRuntime,
		},
		{
			name:          "timeout from legacy error",
			tr:            models.TestResult{Error: models.SubmissionStatusTimeLimitExceeded},
			wantPassed:    false,
			wantErrorType: models.ErrorTypeTimeout,
		},
		{
			name:          "wrong answer default",
			tr:            models.TestResult{},
			wantPassed:    false,
			wantErrorType: models.ErrorTypeWrongAnswer,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.tr.Normalize()
			if tt.tr.Passed != tt.wantPassed || tt.tr.Ok != tt.wantPassed {
				t.Fatalf("expected passed/ok=%v, got %+v", tt.wantPassed, tt.tr)
			}
			if tt.tr.ErrorType != tt.wantErrorType {
				t.Fatalf("expected errorType %q, got %+v", tt.wantErrorType, tt.tr)
			}
		})
	}
}

func TestSubmissionResultJSONIncludesCountAliases(t *testing.T) {
	result := models.NewSubmissionResult()
	result.ExecutionPath = models.ExecutionPathCentral
	result.InternalError = models.InternalErrorJudge
	result.AddTestResult(models.TestResult{Test: 1, Ok: true, TimeMs: 7})
	result.AddTestResult(models.TestResult{Test: 2, Ok: false, TimeMs: 12})

	payload, err := result.ToJSON()
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}

	jsonStr := string(payload)
	if !strings.Contains(jsonStr, "\"passedCount\":1") {
		t.Fatalf("expected passedCount in json payload, got %s", jsonStr)
	}
	if !strings.Contains(jsonStr, "\"totalCount\":2") {
		t.Fatalf("expected totalCount in json payload, got %s", jsonStr)
	}
	if !strings.Contains(jsonStr, "\"firstFailedTest\":2") {
		t.Fatalf("expected firstFailedTest in json payload, got %s", jsonStr)
	}
	if !strings.Contains(jsonStr, "\"status\":\"Wrong Answer\"") {
		t.Fatalf("expected Wrong Answer status in json payload, got %s", jsonStr)
	}
	if !strings.Contains(jsonStr, "\"maxTimeMs\":12") {
		t.Fatalf("expected maxTimeMs in json payload, got %s", jsonStr)
	}
	if !strings.Contains(jsonStr, "\"executionPath\":\"central\"") {
		t.Fatalf("expected executionPath in json payload, got %s", jsonStr)
	}
	if !strings.Contains(jsonStr, "\"internalError\":\"judge_error\"") {
		t.Fatalf("expected internalError in json payload, got %s", jsonStr)
	}
}

func TestSubmissionResultUpdateStatusPriority(t *testing.T) {
	tests := []struct {
		name            string
		details         []models.TestResult
		want            string
		wantFirstFailed int
	}{
		{
			name: "accepted",
			details: []models.TestResult{
				{Test: 1, Ok: true},
				{Test: 2, Ok: true},
			},
			want:            models.SubmissionStatusAccepted,
			wantFirstFailed: -1,
		},
		{
			name: "wrong answer",
			details: []models.TestResult{
				{Test: 1, Ok: true},
				{Test: 2, Ok: false},
			},
			want:            models.SubmissionStatusWrongAnswer,
			wantFirstFailed: 2,
		},
		{
			name: "runtime error overrides wrong answer",
			details: []models.TestResult{
				{Test: 1, Ok: false},
				{Test: 2, Ok: false, Error: models.SubmissionStatusRuntimeError},
			},
			want:            models.SubmissionStatusRuntimeError,
			wantFirstFailed: 1,
		},
		{
			name: "timeout overrides runtime error",
			details: []models.TestResult{
				{Test: 1, Ok: false, Error: models.SubmissionStatusRuntimeError},
				{Test: 2, Ok: false, Error: models.SubmissionStatusTimeLimitExceeded},
			},
			want:            models.SubmissionStatusTimeLimitExceeded,
			wantFirstFailed: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := models.NewSubmissionResult()
			for _, detail := range tt.details {
				result.AddTestResult(detail)
			}
			if result.Status != tt.want {
				t.Fatalf("expected status %q, got %q", tt.want, result.Status)
			}
			if result.FirstFailedTest != tt.wantFirstFailed {
				t.Fatalf("expected firstFailedTest %d, got %d", tt.wantFirstFailed, result.FirstFailedTest)
			}
		})
	}
}

func TestSubmissionResultUnmarshalBackfillsCountAliases(t *testing.T) {
	var result models.SubmissionResult
	if err := json.Unmarshal([]byte(`{"status":"finished","passed":2,"total":3}`), &result); err != nil {
		t.Fatalf("unmarshal failed: %v", err)
	}
	if result.PassedCount != 2 || result.TotalCount != 3 {
		t.Fatalf("expected count aliases from legacy fields, got passedCount=%d totalCount=%d", result.PassedCount, result.TotalCount)
	}
	if result.FirstFailedTest != -1 {
		t.Fatalf("expected firstFailedTest default -1 for no details, got %d", result.FirstFailedTest)
	}

	var aliasOnly models.SubmissionResult
	if err := json.Unmarshal([]byte(`{"status":"finished","passedCount":4,"totalCount":5}`), &aliasOnly); err != nil {
		t.Fatalf("unmarshal alias-only failed: %v", err)
	}
	if aliasOnly.Passed != 4 || aliasOnly.Total != 5 {
		t.Fatalf("expected legacy fields backfilled from aliases, got passed=%d total=%d", aliasOnly.Passed, aliasOnly.Total)
	}
	if aliasOnly.FirstFailedTest != -1 {
		t.Fatalf("expected firstFailedTest default -1 for alias-only payload, got %d", aliasOnly.FirstFailedTest)
	}
}

func TestSubmissionResultNormalizeCountsDerivesFirstFailedFromDetails(t *testing.T) {
	result := models.SubmissionResult{
		Status: models.SubmissionStatusAccepted,
		Details: []models.TestResult{
			{Ok: true, TimeMs: 4},
			{Ok: false, TimeMs: 9},
			{Test: 3, Ok: false, TimeMs: 7},
		},
	}

	result.NormalizeCounts()

	if result.FirstFailedTest != 2 {
		t.Fatalf("expected first failed fallback index 2, got %d", result.FirstFailedTest)
	}
	if result.MaxTimeMs != 9 {
		t.Fatalf("expected maxTimeMs 9, got %d", result.MaxTimeMs)
	}
}
