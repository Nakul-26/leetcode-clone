package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"judge-service-go/pkg/central/adapters"
	"judge-service-go/pkg/comparator"
	"judge-service-go/pkg/executor"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/pool"
	"judge-service-go/pkg/workspace"
)

// Function-mode submissions in these languages run all their tests in one process from the
// first test (JUDGE_FIX_PLAN T5). It used to take 20 tests: below that each test was its own
// exec, about 0.2-0.6 s of Docker calls and process start per test. A test that kills the
// process no longer takes the tests after it down with it (runSubmissionCentralBatched
// starts a new process after it), which was the cost of batching small Run submissions.
// JUDGE_BATCH_THRESHOLD_* can still raise them.
const (
	defaultPythonBatchThreshold     = 1
	defaultJavaScriptBatchThreshold = 1
	defaultJavaBatchThreshold       = 1
	defaultCppBatchThreshold        = 1
)

type batchedTestExecOutput struct {
	Test      int         `json:"test"`
	Output    interface{} `json:"output"`
	Error     string      `json:"error,omitempty"`
	Message   string      `json:"message,omitempty"` // C# and C++ put the exception text here
	Traceback string      `json:"traceback,omitempty"`
	Fatal     string      `json:"fatal,omitempty"`
	Ready     bool        `json:"ready,omitempty"` // start-up is over (see batchStartupAllowanceFor)
	// What the student's code printed during this test, captured by the batch wrapper (cut
	// off just past maxTestOutputBytes). A wrapper that does not capture leaves it nil and
	// the test shows the process's whole stdout instead.
	Stdout *string `json:"stdout,omitempty"`

	// Stdin mode (stdinRunnerScript): the program's exit code and its stdout and stderr, base64.
	Exit *int  `json:"exit,omitempty"`
	Out  string `json:"out,omitempty"`
	Err  string `json:"err,omitempty"`
}

var errBatchedOutputLimitExceeded = fmt.Errorf("batched wrapper output exceeded limit")

//lint:ignore U1000 helper for tests
func runSubmissionCentral(ctx context.Context, exec *executor.Executor, pooledContainer *pool.PooledContainer, submissionMsg models.SubmissionMessage, problem models.Problem, adapter adapters.LanguageAdapter) (*models.SubmissionResult, error) {
	result, _, err := runSubmissionCentralDetailed(ctx, exec, pooledContainer, submissionMsg, problem, adapter)
	return result, err
}

func runSubmissionCentralDetailed(ctx context.Context, exec *executor.Executor, pooledContainer *pool.PooledContainer, submissionMsg models.SubmissionMessage, problem models.Problem, adapter adapters.LanguageAdapter) (result *models.SubmissionResult, cleanupFailed bool, err error) {
	submissionWorkspace, err := workspace.NewSubmissionWorkspace(pooledContainer.WorkDir, submissionMsg.SubmissionID)
	if err != nil {
		return nil, false, err
	}
	defer func() {
		if cleanupErr := workspace.CleanupSubmissionWorkspace(submissionWorkspace.HostPath); cleanupErr != nil {
			cleanupFailed = true
			slog.Error("failed to cleanup workspace", "submissionId", submissionMsg.SubmissionID, "path", submissionWorkspace.HostPath, "error", cleanupErr)
		}
	}()

	if batchAdapter, ok := adapter.(adapters.BatchLanguageAdapter); ok && shouldUseBatchedExecution(submissionMsg.Language, len(problem.TestCases)) {
		result, err = runSubmissionCentralBatched(ctx, exec, pooledContainer, submissionMsg, problem, batchAdapter, submissionWorkspace, startedResult(problem))
		return result, cleanupFailed, err
	}

	result = startedResult(problem)
	result, err = runSubmissionCentralPerTest(ctx, exec, pooledContainer, submissionMsg, problem, adapter, submissionWorkspace, result)
	return result, cleanupFailed, err
}

func startedResult(problem models.Problem) *models.SubmissionResult {
	started := time.Now().UTC()
	result := models.NewSubmissionResult()
	result.StartedAt = &started
	result.ExecutionPath = models.ExecutionPathCentral
	return result
}

func finalizeExecutionFailure(result *models.SubmissionResult, execErr error) *models.SubmissionResult {
	failure := fallbackResultForExecutionFailure(models.ExecutionPathCentral, execErr, "")
	result.Status = failure.Status
	result.InternalError = failure.InternalError
	result.Stderr = execErr.Error()
	finished := time.Now().UTC()
	result.FinishedAt = &finished
	result.ElapsedMs = finished.Sub(*result.StartedAt).Milliseconds()
	return result
}

func compileCentralSubmission(ctx context.Context, exec *executor.Executor, pooledContainer *pool.PooledContainer, submissionWorkspace *workspace.SubmissionWorkspace, adapter adapters.LanguageAdapter, files []string, problem models.Problem) error {
	compilingAdapter, ok := adapter.(adapters.CompilingLanguageAdapter)
	if !ok {
		return nil
	}

	stdout, stderr, err := exec.CompileInContainer(
		ctx,
		pooledContainer.ID,
		files,
		submissionWorkspace.HostPath,
		submissionWorkspace.ContainerPath,
		compilingAdapter.CompileCommand(),
		120*time.Second,
		problem.MemoryLimitMb,
	)
	if err != nil {
		msg := err.Error()
		if strings.TrimSpace(stdout) != "" {
			msg += " | stdout=" + strings.TrimSpace(stdout)
		}
		if strings.TrimSpace(stderr) != "" {
			msg += " | stderr=" + strings.TrimSpace(stderr)
		}
		return fmt.Errorf("%w | %s", err, msg)
	}

	return nil
}

func runSubmissionCentralPerTest(ctx context.Context, exec *executor.Executor, pooledContainer *pool.PooledContainer, submissionMsg models.SubmissionMessage, problem models.Problem, adapter adapters.LanguageAdapter, submissionWorkspace *workspace.SubmissionWorkspace, result *models.SubmissionResult) (*models.SubmissionResult, error) {
	testTimeout := perTestTimeout(problem)
	baseFiles, err := adapter.PrepareFiles(submissionWorkspace.HostPath, submissionMsg, problem)
	if err != nil {
		return nil, err
	}
	if err := compileCentralSubmission(ctx, exec, pooledContainer, submissionWorkspace, adapter, baseFiles, problem); err != nil {
		return finalizeExecutionFailure(result, err), nil
	}

	_, compiling := adapter.(adapters.CompilingLanguageAdapter)
	// Once per submission rather than once per test case: the run-phase memory limit (each
	// per-test set + reset was two docker updates) and, for interpreted languages, the source
	// upload. finishWithContainer restores the default limit when the container is released.
	if problem.MemoryLimitMb > 0 {
		if err := exec.UpdateContainerResources(ctx, pooledContainer.ID, problem.MemoryLimitMb); err != nil {
			slog.Warn("failed to apply execution memory limit", "containerId", pooledContainer.ID, "error", err)
		}
	}
	if !compiling {
		if err := exec.CopyFiles(ctx, pooledContainer.ID, submissionWorkspace.HostPath, submissionWorkspace.ContainerPath, baseFiles); err != nil {
			return finalizeExecutionFailure(result, err), nil
		}
	}

	for i, tc := range problem.TestCases {
		if submissionMsg.StopOnFirstFailure && result.FirstFailedTest != -1 {
			appendNotRunTests(result, problem, i)
			break
		}
		testStart := time.Now()
		tr := models.TestResult{
			Test:     i + 1,
			Input:    tc.Input,
			Expected: tc.Expected,
		}

		payload := map[string]interface{}{"inputs": tc.Input}
		inputJSON, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			markTestFailed(&tr, models.SubmissionStatusRuntimeError)
			tr.Error = fmt.Sprintf("failed to marshal test input: %v", marshalErr)
			tr.TimeMs = time.Since(testStart).Milliseconds()
			result.AddTestResult(tr)
			continue
		}

		inputB64 := base64.StdEncoding.EncodeToString(inputJSON)
		var stdout, stderr string
		timing, runErr := runWithCPULimit(ctx, exec, pooledContainer.ID, testTimeout, func(runCtx context.Context, wallTimeout time.Duration) error {
			testCtx, cancel := context.WithTimeout(runCtx, wallTimeout)
			defer cancel()
			var err error
			stdout, stderr, err = exec.RunInContainer(
				testCtx,
				pooledContainer.ID,
				nil, // uploaded once above
				submissionWorkspace.HostPath,
				submissionWorkspace.ContainerPath,
				nil,
				adapter.RunCommand(inputB64),
				wallTimeout,
				0, // limit applied once above
			)
			return err
		})
		if timing.Exceeded {
			runErr = executor.NewExecutionError(executor.ErrTimeLimitExceeded, fmt.Sprintf("CPU time limit of %v exceeded", testTimeout), -1)
		}

		stdoutTrimmed := strings.TrimSpace(stdout)
		stderrTrimmed := strings.TrimSpace(stderr)
		stdoutForResult, stdoutTruncated := truncateString(stdoutTrimmed, maxTestOutputBytes)
		stderrForLog, stderrTruncated := truncateString(stderrTrimmed, maxLogOutputBytes)
		tr.Stdout = stdoutForResult
		tr.Stderr = stderrForLog

		if runErr != nil {
			errStr := strings.ToLower(runErr.Error())
			switch {
			case errors.Is(runErr, executor.ErrTimeLimitExceeded) || errors.Is(runErr, context.DeadlineExceeded) || strings.Contains(errStr, "deadline exceeded") || strings.Contains(errStr, "timed out"):
				markTestFailed(&tr, models.SubmissionStatusTimeLimitExceeded)
			case errors.Is(runErr, executor.ErrMemoryLimitExceeded) || strings.Contains(errStr, "memory limit exceeded"):
				markTestFailed(&tr, models.SubmissionStatusMemoryLimitExceeded)
			default:
				// A non-zero exit is the student's program failing (a segfault, sys.exit(1),
				// a Go panic): the wrappers catch exceptions and exit 0. Not a wrapper error,
				// so InternalError stays unset (JUDGE_FIX_PLAN T3). A broken wrapper shows up
				// as unparseable output below, which is still InternalErrorJudge.
				markTestFailed(&tr, models.SubmissionStatusRuntimeError)
				if stderrForLog != "" {
					tr.Error = "Runtime Error"
					tr.Traceback = stderrForLog
				}
			}
			slog.Error("runtime error", "submissionId", submissionMsg.SubmissionID, "test", i+1, "error", runErr)
			if stderrForLog != "" {
				slog.Error("runtime stderr", "submissionId", submissionMsg.SubmissionID, "test", i+1, "stderr", stderrForLog, "truncated", stderrTruncated)
			}
			tr.TimeMs = timing.TimeMs()
			result.AddTestResult(tr)
			continue
		}

		if stdoutTruncated {
			markTestFailed(&tr, models.SubmissionStatusWrongAnswer)
			tr.Error = "Output Limit Exceeded"
			tr.TimeMs = timing.TimeMs()
			result.AddTestResult(tr)
			continue
		}

		out, userLogs, parseErr := parseSingleTestOutput(stdoutTrimmed, stderrTrimmed)
		if parseErr != nil {
			markTestFailed(&tr, models.SubmissionStatusRuntimeError)
			result.InternalError = models.InternalErrorJudge
			tr.TimeMs = timing.TimeMs()
			tr.Stdout = userLogs
			tr.Traceback = userLogs
			if tr.Traceback == "" && stderrForLog != "" {
				tr.Traceback = stderrForLog
			}
			slog.Error("invalid wrapper output", "submissionId", submissionMsg.SubmissionID, "test", i+1, "error", parseErr, "stdout", stdoutForResult, "stderr", stderrForLog)
			result.AddTestResult(tr)
			continue
		}

		tr.Stdout = userLogs
		tr.Stderr = "" // Clear stderr since it contains internal judge metadata if parsing succeeded
		
		if out.Error != "" {
			reason := models.SubmissionStatusRuntimeError
			if strings.Contains(strings.ToLower(out.Error), "outofmemory") || strings.Contains(strings.ToLower(out.Traceback), "outofmemory") {
				reason = models.SubmissionStatusMemoryLimitExceeded
			}
			markTestFailed(&tr, reason)
			if out.Traceback != "" {
				tracebackForLog, tbTruncated := truncateString(out.Traceback, maxLogOutputBytes)
				slog.Error("wrapper traceback", "submissionId", submissionMsg.SubmissionID, "test", i+1, "traceback", tracebackForLog, "truncated", tbTruncated)
			}
			tr.TimeMs = timing.TimeMs()
			result.AddTestResult(tr)
			continue
		}

		tr.Output = out.Output
		tr.Passed = comparator.Compare(tc.Expected, out.Output, problem.CompareConfig)
		tr.Ok = tr.Passed
		if !tr.Passed {
			tr.ErrorType = models.ErrorTypeWrongAnswer
		}
		tr.TimeMs = timing.TimeMs()
		result.AddTestResult(tr)
	}

	finished := time.Now().UTC()
	result.FinishedAt = &finished
	result.ElapsedMs = finished.Sub(*result.StartedAt).Milliseconds()
	result.UpdateStatus()

	return result, nil
}

func runSubmissionCentralBatched(ctx context.Context, exec *executor.Executor, pooledContainer *pool.PooledContainer, submissionMsg models.SubmissionMessage, problem models.Problem, adapter adapters.BatchLanguageAdapter, submissionWorkspace *workspace.SubmissionWorkspace, result *models.SubmissionResult) (*models.SubmissionResult, error) {
	baseFiles, err := adapter.PrepareBatchFiles(submissionWorkspace.HostPath, submissionMsg, problem)
	if err != nil {
		return nil, err
	}
	if err := compileCentralSubmission(ctx, exec, pooledContainer, submissionWorkspace, adapter, baseFiles, problem); err != nil {
		return finalizeExecutionFailure(result, err), nil
	}

	upload := []string(nil)
	if _, ok := adapter.(adapters.CompilingLanguageAdapter); !ok {
		upload = append([]string{}, baseFiles...)
	}
	launch := func(runCtx context.Context, rest models.Problem, _ int, runTimeout time.Duration) (*executor.ExecStream, error) {
		testsPayload := make([]map[string]interface{}, 0, len(rest.TestCases))
		for _, tc := range rest.TestCases {
			testsPayload = append(testsPayload, map[string]interface{}{"inputs": tc.Input})
		}
		testsJSON, err := json.Marshal(testsPayload)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal batched tests: %w", err)
		}
		if len(testsJSON) > maxTestsBytes {
			return nil, fmt.Errorf("batched tests JSON too large: %d bytes", len(testsJSON))
		}
		files := upload
		upload = nil // uploaded by the first attempt
		return exec.RunInContainerStream(runCtx, pooledContainer.ID, files, submissionWorkspace.HostPath, submissionWorkspace.ContainerPath,
			nil, adapter.BatchRunCommand(base64.StdEncoding.EncodeToString(testsJSON)), runTimeout, problem.MemoryLimitMb)
	}
	if err := runBatchedTests(ctx, exec, pooledContainer, submissionMsg, problem, result, launch, batchedTestResult, false); err != nil {
		return nil, err
	}
	return result, nil
}

// batchLauncher starts one process that runs rest's tests (rest is the problem from test
// offset+1 on) and reports their results as batchWatch expects.
type batchLauncher func(runCtx context.Context, rest models.Problem, offset int, runTimeout time.Duration) (*executor.ExecStream, error)

// runBatchedTests runs a submission's tests in as few processes as possible (JUDGE_FIX_PLAN
// T5): one exec for the whole submission instead of three or more Docker calls per test. When
// the process dies on a test (time or memory limit, a crash, an exit), that test gets the
// verdict and, unless the submission stops at its first failure, a new process runs the tests
// after it, so every test still gets its own result as it did with one exec per test.
func runBatchedTests(ctx context.Context, exec *executor.Executor, pooledContainer *pool.PooledContainer, submissionMsg models.SubmissionMessage, problem models.Problem, result *models.SubmissionResult, launch batchLauncher, toResult func(batchedTestExecOutput, models.Problem) models.TestResult, keepStdout bool) error {
	lastStartupCrash := noStartupCrash
	for offset := 0; offset < len(problem.TestCases); {
		rest := problem
		rest.TestCases = problem.TestCases[offset:]
		attempt, err := runBatchAttempt(ctx, exec, pooledContainer, submissionMsg, rest, offset, launch, toResult, keepStdout)
		if err != nil {
			if offset == 0 {
				return err
			}
			// A later attempt could not start: report the tests it would have run.
			slog.Error("batched rerun could not start", "submissionId", submissionMsg.SubmissionID, "offset", offset, "error", err)
			appendMissingBatchedResults(result, problem, offset, "Runtime Error")
			result.InternalError = models.InternalErrorJudge
			break
		}
		for _, tr := range attempt.result.Details {
			tr.Test += offset
			result.AddTestResult(tr)
		}
		if attempt.result.Stderr != "" && result.Stderr == "" {
			result.Stderr = attempt.result.Stderr
		}
		if attempt.internalError != "" {
			result.InternalError = attempt.internalError
		}
		done := offset + attempt.processed
		switch {
		case attempt.stoppedEarly:
			// Graded submission stopped at its first failure (T1); the rest never ran.
			appendNotRunTests(result, problem, done)
			offset = len(problem.TestCases)
		case attempt.remainingReason == "":
			offset = len(problem.TestCases)
		case attempt.resumable && !submissionMsg.StopOnFirstFailure && done+1 < len(problem.TestCases) &&
			!(startupCrash(attempt) && attempt.stderr == lastStartupCrash):
			// The test the process died on gets the verdict; the next attempt starts after it.
			// A process that crashes before its first result twice in a row with the same error
			// output is failing on start (a syntax error, say), not on a test: stop retrying then.
			appendFailedTest(result, problem, done, attempt.remainingReason)
			lastStartupCrash = noStartupCrash
			if startupCrash(attempt) {
				lastStartupCrash = attempt.stderr
			}
			offset = done + 1
		default:
			appendMissingBatchedResults(result, problem, done, attempt.remainingReason)
			offset = len(problem.TestCases)
		}
	}
	if submissionMsg.StopOnFirstFailure {
		// Covers failures the watchdog could not stop on (a crash or bad output ends the run by
		// itself): everything after the first failure is reported as not run.
		markNotRunAfterFirstFailure(result)
	}

	finished := time.Now().UTC()
	result.FinishedAt = &finished
	result.ElapsedMs = finished.Sub(*result.StartedAt).Milliseconds()
	result.UpdateStatus()
	return nil
}

// batchAttempt is the outcome of one process running some of a submission's tests.
type batchAttempt struct {
	result          *models.SubmissionResult // the tests it ran, numbered from 1
	processed       int
	stoppedEarly    bool
	remainingReason string // the verdict for the test it died on, "" when every test ran
	resumable       bool   // the process died on one test; the tests after it can run in a new one
	internalError   string
	stderr          string
}

// noStartupCrash never equals an attempt's stderr (which is trimmed).
const noStartupCrash = " none "

// startupCrash reports an attempt that crashed before its first result with an error message.
// Tests that each end the process on purpose (a time or memory limit, an exit with nothing on
// stderr) are not startup crashes, however many come in a row.
func startupCrash(a batchAttempt) bool {
	return a.processed == 0 && a.remainingReason == "Runtime Error" && a.stderr != ""
}

// runBatchAttempt runs problem's tests in one process and reads their results as they come.
func runBatchAttempt(ctx context.Context, exec *executor.Executor, pooledContainer *pool.PooledContainer, submissionMsg models.SubmissionMessage, problem models.Problem, offset int, launch batchLauncher, toResult func(batchedTestExecOutput, models.Problem) models.TestResult, keepStdout bool) (batchAttempt, error) {
	testTimeout := perTestTimeout(problem)
	runTimeout := time.Duration(len(problem.TestCases)+1) * testTimeout

	// Each test is judged on CPU time (F5) when the container's usage can be read. The
	// per-test watchdog below enforces the limits; the whole-run timeout is only a backstop,
	// so it allows for the wall-clock cap.
	var cpuMeter func() (time.Duration, error)
	cpuStart, cpuErr := exec.ContainerCPUTime(ctx, pooledContainer.ID)
	if cpuErr == nil {
		cpuMeter = func() (time.Duration, error) { return exec.ContainerCPUTime(ctx, pooledContainer.ID) }
		runTimeout *= wallCapFactor
	} else if !cpuReadFailureLogged.Swap(true) {
		slog.Warn("cannot read container CPU time; time limits fall back to wall-clock", "containerId", pooledContainer.ID, "error", cpuErr)
	}

	runCtx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()

	stream, err := launch(runCtx, problem, offset, runTimeout)
	if err != nil {
		return batchAttempt{}, err
	}

	result := models.NewSubmissionResult()
	var stderrBuf bytes.Buffer
	watch := batchWatch{
		testTimeout:   testTimeout,
		startup:       batchStartupAllowanceFor(submissionMsg.Language),
		stopOnFailure: submissionMsg.StopOnFirstFailure,
		cancelRun:     cancel,
		cpu:           cpuMeter,
		cpuStart:      cpuStart,
		toResult:      toResult,
		keepStdout:    keepStdout,
	}
	processed, timedOut, stoppedEarly, parseErr := streamBatchedResults(result, stream.Stdout, stream.Stderr, &stderrBuf, problem, watch)
	_ = stream.Stdout.Close()
	_ = stream.Stderr.Close()

	exitCode, waitErr := stream.Wait()
	if timedOut || stoppedEarly {
		// The watchdog cancelled the run on purpose; the cancellation is not a failure.
		waitErr, exitCode = nil, 0
	}

	// If metadata parsing failed, check if there's error info in stderr
	if parseErr != nil {
		result.Stderr = stderrBuf.String()
	}

	var runErr error
	switch {
	case waitErr != nil:
		runErr = fmt.Errorf("execution command failed: %w", waitErr)
	case exitCode != 0:
		runErr = fmt.Errorf("execution failed with exit code %d", exitCode)
	}

	stderrTrimmed := strings.TrimSpace(stderrBuf.String())
	if stderrTrimmed != "" {
		stderrForLog, stderrTruncated := truncateString(stderrTrimmed, maxLogOutputBytes)
		slog.Error("batched stderr", "submissionId", submissionMsg.SubmissionID, "stderr", stderrForLog, "truncated", stderrTruncated)
	}

	attempt := batchAttempt{result: result, processed: processed, stoppedEarly: stoppedEarly, stderr: stderrTrimmed}
	switch {
	case stoppedEarly:
	case timedOut:
		// The test the watchdog was waiting for ran past its limit (F6).
		attempt.remainingReason, attempt.resumable = models.SubmissionStatusTimeLimitExceeded, true
	case errors.Is(parseErr, errBatchedOutputLimitExceeded):
		attempt.remainingReason, attempt.resumable = "Output Limit Exceeded", true
	case runErr != nil:
		runErrText := strings.ToLower(runErr.Error())
		if strings.Contains(runErrText, "timed out") || strings.Contains(runErrText, "deadline exceeded") {
			attempt.remainingReason = "Time Limit Exceeded"
		} else if errors.Is(runErr, executor.ErrMemoryLimitExceeded) {
			attempt.remainingReason = models.SubmissionStatusMemoryLimitExceeded
		} else {
			// The student's program exited non-zero (see the per-test path, T3).
			attempt.remainingReason = "Runtime Error"
		}
		attempt.resumable = true
	case parseErr != nil:
		attempt.remainingReason = "Runtime Error"
		attempt.internalError = models.InternalErrorJudge
	case processed < len(problem.TestCases):
		attempt.remainingReason = "Runtime Error"
		attempt.internalError = models.InternalErrorWrapper
	}
	if parseErr != nil {
		slog.Error("batched output parse error", "submissionId", submissionMsg.SubmissionID, "processed", processed, "error", parseErr)
	}
	if runErr != nil {
		slog.Error("batched execution error", "submissionId", submissionMsg.SubmissionID, "processed", processed, "error", runErr)
	}
	return attempt, nil
}

// batchWatch bounds a batched run test by test (JUDGE_FIX_PLAN F6). The batch wrappers print one
// result line per test to stderr as each test finishes, so a test that runs past its limit
// shows up as a result line that does not arrive. Before this, a batch only had a whole-run
// timeout of (tests + 1) x the limit: an infinite loop on test 1 held the container for that
// long, and per-test time was not measured at all.
type batchWatch struct {
	testTimeout   time.Duration // 0 disables the watchdog
	startup       time.Duration // extra time for the first result (process start, JVM, parsing input)
	stopOnFailure bool          // stop at the first failed test (graded submissions, T1)
	cancelRun     func()        // stops the run

	// CPU time (F5): when cpu is set, a test whose wall-clock time is up but which has used
	// less CPU than its limit (the server was busy) gets more time, up to wallCapFactor times
	// the limit, and each test reports the CPU time between its result line and the one
	// before. nil judges on wall-clock time alone.
	cpu      func() (time.Duration, error)
	cpuStart time.Duration // the container's CPU time when the run started

	// toResult turns a result line into a test result (batchedTestResult when nil). keepStdout
	// keeps each test's own Stdout instead of the process's whole stdout (stdin mode, where
	// each test is a program run of its own).
	toResult   func(batchedTestExecOutput, models.Problem) models.TestResult
	keepStdout bool
}

// cpuMark is the container's CPU time read when a batched test's result line arrived. It is
// read in the background so the line reader never waits for the Docker API.
type cpuMark struct {
	v     time.Duration
	err   error
	ready chan struct{}
}

// cpuSampler takes the readings for one batched run one at a time, so they come back in
// order: concurrent reads could finish out of order and give a test a negative time. A
// mark requested while a read is in flight shares the next read, so a burst of quick
// results costs one read; the tests in that burst before the last then show 0 ms and the
// last one carries their CPU time.
type cpuSampler struct {
	read     func() (time.Duration, error)
	mu       sync.Mutex
	inFlight bool
	pending  *cpuMark // waits for the read in flight to finish
}

func (s *cpuSampler) mark() *cpuMark {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inFlight {
		if s.pending == nil {
			s.pending = &cpuMark{ready: make(chan struct{})}
		}
		return s.pending
	}
	m := &cpuMark{ready: make(chan struct{})}
	s.inFlight = true
	go s.run(m)
	return m
}

func (s *cpuSampler) run(m *cpuMark) {
	for m != nil {
		m.v, m.err = s.read()
		close(m.ready)
		s.mu.Lock()
		m, s.pending = s.pending, nil
		s.inFlight = m != nil
		s.mu.Unlock()
	}
}

// value waits up to wait for the reading.
func (m *cpuMark) value(wait time.Duration) (time.Duration, bool) {
	select {
	case <-m.ready:
		return m.v, m.err == nil
	case <-time.After(wait):
		return 0, false
	}
}

// batchCPUWait decides, when a batched test's wall-clock time is up, whether it may run on
// because it has used less CPU than its budget, and for how long until the next check.
func batchCPUWait(watch batchWatch, since *cpuMark, budget time.Duration, wallUsed time.Duration) (time.Duration, bool) {
	capLeft := budget*wallCapFactor - wallUsed
	if capLeft <= 0 {
		return 0, false
	}
	base, ok := since.value(time.Second)
	if !ok {
		return 0, false
	}
	now, err := watch.cpu()
	if err != nil {
		return 0, false
	}
	used := now - base
	if used >= budget {
		return 0, false
	}
	wait := budget - used
	if wait > capLeft {
		wait = capLeft
	}
	if wait < cpuPollMin {
		wait = cpuPollMin
	}
	return wait, true
}

// The first result also pays for starting the program, which a per-test run pays on every test.
const batchStartupAllowance = 2 * time.Second

// batchStartupAllowanceFor is the start-up allowance for a language. tsx compiles the
// TypeScript before anything runs, 2-3.5 s on one core. A wrapper that prints {"ready":true}
// once it has started has the first test's limit counted from that line, so a long allowance
// does not give test 1 extra time.
func batchStartupAllowanceFor(language string) time.Duration {
	if language == "typescript" {
		return 10 * time.Second
	}
	return batchStartupAllowance
}

const (
	maxBatchedLineBytes   = 4 << 20
	maxBatchedStdoutBytes = 1 << 20
	maxBatchedStderrCopy  = 64 << 10
)

type batchedLine struct {
	text []byte
	at   time.Time
	err  error
}

// appendBatchedResults reads a finished batched run's output with no watchdog.
func appendBatchedResults(result *models.SubmissionResult, stdout io.Reader, stderr io.Reader, problem models.Problem) (int, error) {
	var discard bytes.Buffer
	processed, _, _, err := streamBatchedResults(result, stdout, stderr, &discard, problem, batchWatch{})
	return processed, err
}

// streamBatchedResults records each test's result as its line arrives. It returns early, after
// cancelling the run, when a test runs past its limit (timedOut) or, for a graded submission,
// when a test fails and more remain (stoppedEarly). stderrCopy receives the start of stderr
// for logging.
func streamBatchedResults(result *models.SubmissionResult, stdout io.Reader, stderr io.Reader, stderrCopy *bytes.Buffer, problem models.Problem, watch batchWatch) (processed int, timedOut bool, stoppedEarly bool, err error) {
	// The student's own prints. Kept whole, as before, up to a bound.
	var stdoutBuf bytes.Buffer
	stdoutDone := make(chan struct{})
	go func() {
		defer close(stdoutDone)
		_, _ = io.Copy(&stdoutBuf, io.LimitReader(stdout, maxBatchedStdoutBytes))
		_, _ = io.Copy(io.Discard, stdout)
	}()

	quit := make(chan struct{})
	defer close(quit)
	lines := make(chan batchedLine)
	go func() {
		defer close(lines)
		reader := bufio.NewReaderSize(stderr, 64*1024)
		for {
			text, readErr := readBoundedLine(reader, maxBatchedLineBytes)
			ev := batchedLine{text: text, at: time.Now(), err: readErr}
			if readErr == io.EOF {
				return
			}
			select {
			case lines <- ev:
			case <-quit:
				return
			}
			if readErr != nil {
				return
			}
		}
	}()

	var deadline <-chan time.Time
	var timer *time.Timer
	if watch.testTimeout > 0 {
		timer = time.NewTimer(watch.testTimeout + watch.startup)
		defer timer.Stop()
		deadline = timer.C
	}
	stop := func() {
		if watch.cancelRun != nil {
			watch.cancelRun()
		}
	}

	last := time.Now()
	ready := false // the program said it has started (out.Ready)
	// marks[k] is the CPU time when the k-th result arrived; marks[0] is the run's start.
	var marks []*cpuMark
	var sampler *cpuSampler
	if watch.cpu != nil {
		sampler = &cpuSampler{read: watch.cpu}
		start := &cpuMark{v: watch.cpuStart, ready: make(chan struct{})}
		close(start.ready)
		marks = append(marks, start)
	}
loop:
	for {
		select {
		case ev, ok := <-lines:
			if !ok {
				break loop
			}
			if ev.err != nil {
				err = ev.err
				break loop
			}
			if stderrCopy.Len() < maxBatchedStderrCopy {
				stderrCopy.Write(ev.text)
			}
			line := strings.TrimSpace(string(ev.text))
			if line == "" || !strings.HasPrefix(line, "{") {
				continue
			}
			var out batchedTestExecOutput
			if json.Unmarshal([]byte(line), &out) != nil {
				continue
			}
			if out.Fatal != "" {
				err = fmt.Errorf("wrapper fatal error: %s", out.Fatal)
				break loop
			}
			if out.Ready {
				// Start-up is over: the first test's limit and CPU time start now.
				if processed == 0 && !ready {
					ready = true
					last = ev.at
					if watch.cpu != nil {
						marks[0] = sampler.mark()
					}
					if timer != nil {
						if !timer.Stop() {
							select {
							case <-timer.C:
							default:
							}
						}
						timer.Reset(watch.testTimeout)
					}
				}
				continue
			}
			// Only the next test's line counts. Student code can write to the same stream, so
			// a repeated or out-of-order line (a copy of a passing test's) must not count again.
			if out.Test != processed+1 || out.Test > len(problem.TestCases) {
				continue
			}

			toResult := watch.toResult
			if toResult == nil {
				toResult = batchedTestResult
			}
			tr := toResult(out, problem)
			tr.TimeMs = ev.at.Sub(last).Milliseconds()
			last = ev.at
			result.AddTestResult(tr)
			processed++
			if watch.cpu != nil {
				marks = append(marks, sampler.mark())
			}

			if watch.stopOnFailure && !tr.Passed && processed < len(problem.TestCases) {
				stoppedEarly = true
				stop()
				break loop
			}
			if timer != nil {
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
				timer.Reset(watch.testTimeout)
			}
		case <-deadline:
			if processed < len(problem.TestCases) {
				if watch.cpu != nil {
					budget := watch.testTimeout
					if processed == 0 && !ready {
						budget += watch.startup
					}
					if wait, ok := batchCPUWait(watch, marks[len(marks)-1], budget, time.Since(last)); ok {
						timer.Reset(wait)
						continue
					}
				}
				timedOut = true
				stop()
				break loop
			}
		}
	}

	// Once the run has ended or been cancelled the pipes close, so this does not wait long.
	select {
	case <-stdoutDone:
	case <-time.After(5 * time.Second):
	}
	rawStdout := stdoutBuf.String()
	for i := len(result.Details) - processed; i < len(result.Details) && !watch.keepStdout; i++ {
		if i >= 0 && result.Details[i].Stdout == "" {
			result.Details[i].Stdout = rawStdout
		}
	}
	// Report each test's CPU time in place of its wall-clock time where both readings exist.
	for k := 1; k < len(marks); k++ {
		i := len(result.Details) - processed + k - 1
		prev, okPrev := marks[k-1].value(time.Second)
		cur, okCur := marks[k].value(time.Second)
		if i >= 0 && okPrev && okCur {
			result.Details[i].TimeMs = (cur - prev).Milliseconds()
		}
	}
	return processed, timedOut, stoppedEarly, err
}

// batchedTestResult turns one wrapper result line into a test result.
func batchedTestResult(out batchedTestExecOutput, problem models.Problem) models.TestResult {
	tc := problem.TestCases[out.Test-1]
	tr := models.TestResult{
		Test:     out.Test,
		Input:    tc.Input,
		Expected: tc.Expected,
		Output:   out.Output,
	}
	if out.Stdout != nil {
		// As in the per-test path: a test that prints more than maxTestOutputBytes fails with
		// Output Limit Exceeded, whatever it returned.
		stdout, truncated := truncateString(strings.TrimSpace(*out.Stdout), maxTestOutputBytes)
		tr.Stdout = stdout
		if truncated {
			markTestFailed(&tr, models.SubmissionStatusWrongAnswer)
			tr.Error = "Output Limit Exceeded"
			return tr
		}
	}
	if out.Error != "" {
		reason := models.SubmissionStatusRuntimeError
		// Java and Kotlin name OutOfMemoryError in error, C# in message.
		if strings.Contains(strings.ToLower(out.Error+" "+out.Message+" "+out.Traceback), "outofmemory") {
			reason = models.SubmissionStatusMemoryLimitExceeded
		}
		markTestFailed(&tr, reason)
		if out.Traceback != "" {
			tr.Traceback = out.Traceback
		}
		return tr
	}
	tr.Passed = comparator.Compare(tc.Expected, out.Output, problem.CompareConfig)
	tr.Ok = tr.Passed
	if !tr.Passed {
		tr.ErrorType = models.ErrorTypeWrongAnswer
	}
	return tr
}

func appendMissingBatchedResults(result *models.SubmissionResult, problem models.Problem, processed int, reason string) {
	for i := processed; i < len(problem.TestCases); i++ {
		tr := models.TestResult{
			Test:     i + 1,
			Expected: problem.TestCases[i].Expected,
		}
		markTestFailed(&tr, reason)
		result.AddTestResult(tr)
	}
}

// appendFailedTest records test index i (0-based) as failed with reason.
func appendFailedTest(result *models.SubmissionResult, problem models.Problem, i int, reason string) {
	tr := models.TestResult{Test: i + 1, Input: problem.TestCases[i].Input, Expected: problem.TestCases[i].Expected}
	markTestFailed(&tr, reason)
	result.AddTestResult(tr)
}

// appendNotRunTests records tests from index `from` on as skipped after an earlier failure
// (JUDGE_FIX_PLAN T1). Scoring is all-or-nothing, so running them would only cost time: a
// TLE on test 1 of 10 used to hold the container for ten time limits.
func appendNotRunTests(result *models.SubmissionResult, problem models.Problem, from int) {
	for i := from; i < len(problem.TestCases); i++ {
		result.AddTestResult(notRunTest(i+1, problem.TestCases[i].Expected))
	}
}

func notRunTest(test int, expected interface{}) models.TestResult {
	return models.TestResult{Test: test, Expected: expected, Error: models.TestNotRun, ErrorType: models.ErrorTypeNotRun}
}

// markNotRunAfterFirstFailure replaces every result after the first failed one with a
// not-run entry and recounts.
func markNotRunAfterFirstFailure(result *models.SubmissionResult) {
	first := -1
	for i, d := range result.Details {
		if !d.Passed {
			first = i
			break
		}
	}
	if first < 0 {
		return
	}
	passed := 0
	for i := range result.Details {
		if i > first {
			result.Details[i] = notRunTest(result.Details[i].Test, result.Details[i].Expected)
		}
		if result.Details[i].Passed {
			passed++
		}
	}
	result.Passed, result.PassedCount = passed, passed
	result.UpdateStatus()
}

func markTestFailed(tr *models.TestResult, reason string) {
	tr.Passed = false
	tr.Ok = false
	tr.Error = reason
	switch reason {
	case models.SubmissionStatusTimeLimitExceeded:
		tr.ErrorType = models.ErrorTypeTimeout
	case models.SubmissionStatusMemoryLimitExceeded:
		tr.ErrorType = models.ErrorTypeMemoryLimit
	case models.SubmissionStatusRuntimeError, models.SubmissionStatusCompilationError:
		tr.ErrorType = models.ErrorTypeRuntime
	default:
		tr.ErrorType = models.ErrorTypeWrongAnswer
	}
}

func readBoundedLine(reader *bufio.Reader, maxBytes int) ([]byte, error) {
	var line []byte
	for {
		chunk, err := reader.ReadSlice('\n')
		line = append(line, chunk...)
		if maxBytes > 0 && len(line) > maxBytes {
			return nil, errBatchedOutputLimitExceeded
		}
		if err == nil {
			return line, nil
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err == io.EOF {
			if len(line) == 0 {
				return nil, io.EOF
			}
			return line, nil
		}
		return nil, err
	}
}

func shouldUseBatchedExecution(language string, testCount int) bool {
	threshold := 0
	switch language {
	case "python":
		threshold = defaultPythonBatchThreshold
		if raw := strings.TrimSpace(os.Getenv("JUDGE_BATCH_THRESHOLD_PY")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				threshold = parsed
			}
		}
	case "javascript":
		threshold = defaultJavaScriptBatchThreshold
		if raw := strings.TrimSpace(os.Getenv("JUDGE_BATCH_THRESHOLD_JS")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				threshold = parsed
			}
		}
	case "java":
		threshold = defaultJavaBatchThreshold
		if raw := strings.TrimSpace(os.Getenv("JUDGE_BATCH_THRESHOLD_JAVA")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				threshold = parsed
			}
		}
	case "cpp":
		threshold = defaultCppBatchThreshold
		if raw := strings.TrimSpace(os.Getenv("JUDGE_BATCH_THRESHOLD_CPP")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				threshold = parsed
			}
		}
	case "c", "go", "typescript", "kotlin", "csharp", "ruby", "php", "rust":
		// Batch wrappers added with T5 step 2; no threshold override.
		threshold = 1
	default:
		return false
	}
	return testCount >= threshold
}
