package main

import (
	"testing"

	"judge-service-go/pkg/models"
)

// JUDGE_FIX_PLAN T1: after the first failure the rest are reported as not run, and the
// verdict comes from the real failure.
func TestNotRunAfterFirstFailure(t *testing.T) {
	problem := models.Problem{TestCases: make([]models.TestCase, 5)}

	t.Run("per-test path appends not-run entries", func(t *testing.T) {
		r := models.NewSubmissionResult()
		r.AddTestResult(models.TestResult{Test: 1, Passed: true})
		tle := models.TestResult{Test: 2}
		markTestFailed(&tle, models.SubmissionStatusTimeLimitExceeded)
		r.AddTestResult(tle)
		appendNotRunTests(r, problem, 2)

		if r.Total != 5 || r.Passed != 1 || r.FirstFailedTest != 2 {
			t.Fatalf("counts: total=%d passed=%d firstFailed=%d", r.Total, r.Passed, r.FirstFailedTest)
		}
		if r.Status != models.SubmissionStatusTimeLimitExceeded {
			t.Fatalf("status = %q, want TLE", r.Status)
		}
		for _, d := range r.Details[2:] {
			if d.ErrorType != models.ErrorTypeNotRun || d.Error != models.TestNotRun || d.Passed {
				t.Fatalf("test %d not marked not-run: %+v", d.Test, d)
			}
		}
	})

	t.Run("batch path replaces results after the first failure", func(t *testing.T) {
		r := models.NewSubmissionResult()
		r.AddTestResult(models.TestResult{Test: 1, Passed: true})
		wa := models.TestResult{Test: 2}
		markTestFailed(&wa, models.SubmissionStatusWrongAnswer)
		r.AddTestResult(wa)
		r.AddTestResult(models.TestResult{Test: 3, Passed: true})
		tle := models.TestResult{Test: 4}
		markTestFailed(&tle, models.SubmissionStatusTimeLimitExceeded)
		r.AddTestResult(tle)
		markNotRunAfterFirstFailure(r)

		if r.Passed != 1 || r.PassedCount != 1 {
			t.Fatalf("passed = %d, want 1 (test 3 is not counted once not run)", r.Passed)
		}
		if r.Status != models.SubmissionStatusWrongAnswer {
			t.Fatalf("status = %q, want the first failure's verdict (WA), not the later TLE", r.Status)
		}
		if r.Details[2].ErrorType != models.ErrorTypeNotRun || r.Details[3].ErrorType != models.ErrorTypeNotRun {
			t.Fatalf("later results not replaced: %+v", r.Details[2:])
		}
	})

	t.Run("all passing is unchanged", func(t *testing.T) {
		r := models.NewSubmissionResult()
		r.AddTestResult(models.TestResult{Test: 1, Passed: true})
		markNotRunAfterFirstFailure(r)
		if r.Status != models.SubmissionStatusAccepted || r.Passed != 1 {
			t.Fatalf("got %q passed=%d", r.Status, r.Passed)
		}
	})
}
