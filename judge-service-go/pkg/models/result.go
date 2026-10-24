package models

import (
	"encoding/json"
	"time"
)

const (
	SubmissionStatusAccepted            = "Accepted"
	SubmissionStatusWrongAnswer         = "Wrong Answer"
	SubmissionStatusRuntimeError        = "Runtime Error"
	SubmissionStatusTimeLimitExceeded   = "Time Limit Exceeded"
	SubmissionStatusCompilationError    = "Compilation Error"
	SubmissionStatusMemoryLimitExceeded = "Memory Limit Exceeded"
	ExecutionPathCentral                = "central"
	ExecutionPathLegacy                 = "legacy"
	InternalErrorJudge                  = "judge_error"
	InternalErrorWrapper                = "wrapper_error"
	ErrorTypeTimeout                    = "timeout"
	ErrorTypeRuntime                    = "runtime"
	ErrorTypeWrongAnswer                = "wrong_answer"
	ErrorTypeMemoryLimit                = "memory_limit"
	// A test skipped because an earlier one failed (SubmissionMessage.StopOnFirstFailure).
	ErrorTypeNotRun = "not_run"
	TestNotRun      = "Not Run"
)

// TestResult represents the result of a single test case.
type TestResult struct {
	Test      int         `json:"test" bson:"test"`                // test index (0-based)
	Passed    bool        `json:"passed" bson:"passed"`              // whether test passed
	Ok        bool        `json:"ok,omitempty" bson:"ok,omitempty"`        // legacy alias for whether test passed
	Input     interface{} `json:"input,omitempty" bson:"input,omitempty"`     // input used for this test
	Output    interface{} `json:"output,omitempty" bson:"output,omitempty"`    // actual output returned by user code
	Expected  interface{} `json:"expected,omitempty" bson:"expected,omitempty"`  // expected output (useful for UI diffs)
	Error     string      `json:"error,omitempty" bson:"error,omitempty"`     // short error message, if any
	ErrorType string      `json:"errorType,omitempty" bson:"errorType,omitempty"` // timeout / runtime / wrong_answer
	Stack     string      `json:"stack,omitempty" bson:"stack,omitempty"`     // optional stack trace (for languages that produce it)
	Traceback string      `json:"traceback,omitempty" bson:"traceback,omitempty"` // python-style traceback or similar
	Stdout    string      `json:"stdout,omitempty" bson:"stdout,omitempty"`    // captured stdout for this test
	Stderr    string      `json:"stderr,omitempty" bson:"stderr,omitempty"`    // captured stderr for this test
	ExitCode  int         `json:"exitCode,omitempty" bson:"exitCode,omitempty"`  // process exit code (if applicable)
	TimeMs    int64       `json:"timeMs" bson:"timeMs"`              // time taken for this test in milliseconds
	MemoryKB  int64       `json:"memoryKb,omitempty" bson:"memoryKb,omitempty"`  // memory used (best-effort)
	// Extra fields can be added as needed, but keep them small to avoid huge JSON payloads.
}

// SubmissionResult represents the overall result of a submission.
type SubmissionResult struct {
	Status          string       `json:"status" bson:"status"` // Accepted / Wrong Answer / Runtime Error / Time Limit Exceeded
	ExecutionPath   string       `json:"executionPath,omitempty" bson:"executionPath,omitempty"`
	InternalError   string       `json:"internalError,omitempty" bson:"internalError,omitempty"`
	Passed          int          `json:"passed" bson:"passed"`              // number of tests passed
	PassedCount     int          `json:"passedCount" bson:"passedCount"`         // alias for UI-facing pass count
	Total           int          `json:"total" bson:"total"`               // total tests executed
	TotalCount      int          `json:"totalCount" bson:"totalCount"`          // alias for UI-facing total count
	MaxTimeMs       int64        `json:"maxTimeMs" bson:"maxTimeMs"`           // slowest per-test execution time in milliseconds
	FirstFailedTest int          `json:"firstFailedTest" bson:"firstFailedTest"`     // 1-based index of first failed test, or -1 if all passed
	Details         []TestResult `json:"details,omitempty" bson:"details,omitempty"`   // per-test details
	Stdout          string       `json:"stdout,omitempty" bson:"stdout,omitempty"`    // aggregated stdout (if any)
	Stderr          string       `json:"stderr,omitempty" bson:"stderr,omitempty"`    // aggregated stderr (if any)
	StartedAt       *time.Time   `json:"startedAt,omitempty" bson:"startedAt,omitempty"` // optional timestamps
	FinishedAt      *time.Time   `json:"finishedAt,omitempty" bson:"finishedAt,omitempty"`
	ElapsedMs       int64        `json:"elapsedMs,omitempty" bson:"elapsedMs,omitempty"` // total elapsed time for submission
}

// NewSubmissionResult creates a new, empty SubmissionResult with a default status.
func NewSubmissionResult() *SubmissionResult {
	return &SubmissionResult{
		Status:          SubmissionStatusAccepted,
		ExecutionPath:   "",
		InternalError:   "",
		Passed:          0,
		PassedCount:     0,
		Total:           0,
		TotalCount:      0,
		FirstFailedTest: -1,
		Details:         make([]TestResult, 0),
	}
}

// AddTestResult appends a TestResult and updates Passed/Total counters.
// Use this to avoid off-by-one issues when building results.
func (sr *SubmissionResult) AddTestResult(tr TestResult) {
	tr.Normalize()
	sr.Details = append(sr.Details, tr)
	sr.Total++
	sr.TotalCount = sr.Total
	if tr.TimeMs > sr.MaxTimeMs {
		sr.MaxTimeMs = tr.TimeMs
	}
	if tr.Passed {
		sr.Passed++
	}
	sr.PassedCount = sr.Passed
	if !tr.Passed && sr.FirstFailedTest == -1 {
		sr.FirstFailedTest = tr.Test
	}
	sr.UpdateStatus()
}

// NormalizeCounts keeps legacy and UI-facing count aliases in sync.
func (sr *SubmissionResult) NormalizeCounts() {
	if sr == nil {
		return
	}

	switch {
	case sr.PassedCount == 0 && sr.Passed != 0:
		sr.PassedCount = sr.Passed
	case sr.Passed == 0 && sr.PassedCount != 0:
		sr.Passed = sr.PassedCount
	}

	switch {
	case sr.TotalCount == 0 && sr.Total != 0:
		sr.TotalCount = sr.Total
	case sr.Total == 0 && sr.TotalCount != 0:
		sr.Total = sr.TotalCount
	}

	sr.MaxTimeMs = 0
	sr.FirstFailedTest = -1
	for i, detail := range sr.Details {
		detail.Normalize()
		sr.Details[i] = detail
		if detail.TimeMs > sr.MaxTimeMs {
			sr.MaxTimeMs = detail.TimeMs
		}
		if detail.Passed {
			continue
		}
		if detail.Test > 0 {
			sr.FirstFailedTest = detail.Test
		} else {
			sr.FirstFailedTest = i + 1
		}
		break
	}

	sr.UpdateStatus()
}

// UpdateStatus derives the overall user-facing verdict from per-test results.
func (sr *SubmissionResult) UpdateStatus() {
	if sr == nil {
		return
	}

	hasRuntimeError := false
	hasMemoryLimitError := false
	for _, detail := range sr.Details {
		switch detail.ErrorType {
		case ErrorTypeTimeout:
			sr.Status = SubmissionStatusTimeLimitExceeded
			return
		case ErrorTypeMemoryLimit:
			hasMemoryLimitError = true
		case ErrorTypeRuntime:
			hasRuntimeError = true
		}
	}

	if hasMemoryLimitError {
		sr.Status = SubmissionStatusMemoryLimitExceeded
		return
	}
	if hasRuntimeError {
		sr.Status = SubmissionStatusRuntimeError
		return
	}
	if sr.TotalCount > 0 && sr.PassedCount == sr.TotalCount {
		sr.Status = SubmissionStatusAccepted
		return
	}

	if sr.TotalCount == 0 && (sr.Status == "" || sr.Status == SubmissionStatusAccepted) {
		// If no tests ran, keep current status if it's an error, otherwise it's likely a judge error or compilation failed
		// But usually sr.Status is already set by the caller in case of failure.
	} else if sr.TotalCount > 0 {
		sr.Status = SubmissionStatusWrongAnswer
	}
}

// ToJSON returns the JSON encoding (useful for logging or returning to caller).
func (sr *SubmissionResult) ToJSON() ([]byte, error) {
	sr.NormalizeCounts()
	return json.Marshal(sr)
}

// UnmarshalJSON backfills count aliases from either field naming scheme.
func (sr *SubmissionResult) UnmarshalJSON(data []byte) error {
	type submissionResultAlias SubmissionResult

	var aux submissionResultAlias
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}

	*sr = SubmissionResult(aux)
	sr.NormalizeCounts()
	return nil
}

// Normalize keeps result aliases and derived fields in sync.
func (tr *TestResult) Normalize() {
	if tr == nil {
		return
	}

	switch {
	case tr.Passed && !tr.Ok:
		tr.Ok = true
	case tr.Ok && !tr.Passed:
		tr.Passed = true
	}

	if tr.Passed {
		tr.ErrorType = ""
		return
	}

	if tr.ErrorType != "" {
		return
	}

	switch tr.Error {
	case SubmissionStatusTimeLimitExceeded:
		tr.ErrorType = ErrorTypeTimeout
	case SubmissionStatusMemoryLimitExceeded:
		tr.ErrorType = ErrorTypeMemoryLimit
	case SubmissionStatusRuntimeError:
		tr.ErrorType = ErrorTypeRuntime
	default:
		tr.ErrorType = ErrorTypeWrongAnswer
	}
}
