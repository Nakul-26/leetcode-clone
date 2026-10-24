package main

import (
	"bytes"
	"io"
	"strings"
	"testing"
	"time"

	"judge-service-go/pkg/models"
)

// JUDGE_FIX_PLAN F6: a batched run is watched test by test.

func batchProblem(n int) models.Problem {
	p := models.Problem{TestCases: make([]models.TestCase, n)}
	for i := range p.TestCases {
		p.TestCases[i] = models.TestCase{Input: []interface{}{float64(i)}, Expected: float64(i)}
	}
	return p
}

// fakeBatch writes result lines with a pause before each, like a wrapper running tests.
func fakeBatch(t *testing.T, w *io.PipeWriter, lines []string, pauses []time.Duration) {
	t.Helper()
	go func() {
		for i, l := range lines {
			time.Sleep(pauses[i])
			if _, err := w.Write([]byte(l + "\n")); err != nil {
				return
			}
		}
		_ = w.Close()
	}()
}

func TestBatchWatchdogStopsALateTest(t *testing.T) {
	r, w := io.Pipe()
	cancelled := make(chan struct{})
	// Test 1 answers at once, test 2 never does (an infinite loop).
	fakeBatch(t, w, []string{`{"test":1,"output":0}`, `{"test":2,"output":1}`}, []time.Duration{0, 5 * time.Second})

	result := models.NewSubmissionResult()
	var stderrCopy bytes.Buffer
	start := time.Now()
	processed, timedOut, stopped, err := streamBatchedResults(result, strings.NewReader(""), r, &stderrCopy, batchProblem(3), batchWatch{
		testTimeout: 200 * time.Millisecond,
		cancelRun:   func() { close(cancelled); _ = w.Close() },
	})
	if err != nil || !timedOut || stopped || processed != 1 {
		t.Fatalf("processed=%d timedOut=%v stopped=%v err=%v", processed, timedOut, stopped, err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("watchdog took %v; it should fire after about the 200 ms limit", elapsed)
	}
	select {
	case <-cancelled:
	default:
		t.Fatal("the run was not cancelled")
	}
}

func TestBatchStopsAtFirstFailureWhenGraded(t *testing.T) {
	r, w := io.Pipe()
	// Test 2 is wrong; tests 3 and 4 would follow.
	fakeBatch(t, w, []string{`{"test":1,"output":0}`, `{"test":2,"output":99}`, `{"test":3,"output":2}`, `{"test":4,"output":3}`},
		[]time.Duration{0, 0, time.Second, 0})

	result := models.NewSubmissionResult()
	var stderrCopy bytes.Buffer
	start := time.Now()
	processed, timedOut, stopped, err := streamBatchedResults(result, strings.NewReader(""), r, &stderrCopy, batchProblem(4), batchWatch{
		testTimeout:   5 * time.Second,
		stopOnFailure: true,
		cancelRun:     func() { _ = w.Close() },
	})
	if err != nil || timedOut || !stopped || processed != 2 {
		t.Fatalf("processed=%d timedOut=%v stopped=%v err=%v", processed, timedOut, stopped, err)
	}
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("did not stop as soon as test 2 failed")
	}
	if result.Details[1].ErrorType != models.ErrorTypeWrongAnswer {
		t.Fatalf("test 2: %+v", result.Details[1])
	}
}

func TestBatchRecordsPerTestTime(t *testing.T) {
	r, w := io.Pipe()
	fakeBatch(t, w, []string{`{"test":1,"output":0}`, `{"test":2,"output":1}`}, []time.Duration{0, 150 * time.Millisecond})

	result := models.NewSubmissionResult()
	var stderrCopy bytes.Buffer
	processed, timedOut, _, err := streamBatchedResults(result, strings.NewReader("user print\n"), r, &stderrCopy, batchProblem(2), batchWatch{testTimeout: 2 * time.Second})
	if err != nil || timedOut || processed != 2 {
		t.Fatalf("processed=%d timedOut=%v err=%v", processed, timedOut, err)
	}
	if got := result.Details[1].TimeMs; got < 100 || got > 1000 {
		t.Fatalf("test 2 took %d ms; expected about 150", got)
	}
	if result.Status != models.SubmissionStatusAccepted {
		t.Fatalf("status %q", result.Status)
	}
	if result.Details[0].Stdout != "user print\n" {
		t.Fatalf("stdout not attached: %q", result.Details[0].Stdout)
	}
}

func TestBatchWithoutWatchdogReadsEverything(t *testing.T) {
	// A failure does not stop an ungraded run (Run, API callers, partner platforms).
	r, w := io.Pipe()
	fakeBatch(t, w, []string{`{"test":1,"output":5}`, `{"test":2,"output":1}`}, []time.Duration{0, 0})
	result := models.NewSubmissionResult()
	var stderrCopy bytes.Buffer
	processed, timedOut, stopped, err := streamBatchedResults(result, strings.NewReader(""), r, &stderrCopy, batchProblem(2), batchWatch{testTimeout: time.Second})
	if err != nil || timedOut || stopped || processed != 2 {
		t.Fatalf("processed=%d timedOut=%v stopped=%v err=%v", processed, timedOut, stopped, err)
	}
}
