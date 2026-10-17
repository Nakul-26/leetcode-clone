package main

import (
	"testing"

	"judge-service-go/pkg/models"
)

// rawRunUsageStatus feeds the per-language statistics, so a /raw-run outcome has to land in the
// same status buckets the queue path uses. The order matters: a compile failure also has a
// non-zero exit code, and must count as a compile error, not a runtime error.
func TestRawRunUsageStatus(t *testing.T) {
	cases := []struct {
		name string
		resp rawRunResponse
		want string
	}{
		{"clean run", rawRunResponse{}, models.SubmissionStatusAccepted},
		{"non-zero exit", rawRunResponse{ExitCode: 1}, models.SubmissionStatusRuntimeError},
		{"compile error wins over exit code", rawRunResponse{CompileError: true, ExitCode: 1}, models.SubmissionStatusCompilationError},
		{"time limit", rawRunResponse{TimedOut: true, ExitCode: 137}, models.SubmissionStatusTimeLimitExceeded},
		{"memory limit", rawRunResponse{OomKilled: true, ExitCode: 137}, models.SubmissionStatusMemoryLimitExceeded},
		{"judge failure wins over everything", rawRunResponse{Error: "boom", CompileError: true}, models.StatusError},
	}
	for _, c := range cases {
		if got := rawRunUsageStatus(c.resp); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestRecordUsageAsyncIgnoresMissingCollection(t *testing.T) {
	// No database configured (some tests, local tools): must be a silent no-op, never a panic.
	recordUsageAsync(nil, nil)
}
