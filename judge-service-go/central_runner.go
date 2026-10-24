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
	"time"

	"judge-service-go/pkg/central/adapters"
	"judge-service-go/pkg/comparator"
	"judge-service-go/pkg/executor"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/pool"
	"judge-service-go/pkg/workspace"
)

const (
	defaultPythonBatchThreshold     = 20
	defaultJavaScriptBatchThreshold = 20
	defaultJavaBatchThreshold       = 20
	defaultCppBatchThreshold        = 20
)

type batchedTestExecOutput struct {
	Test      int         `json:"test"`
	Output    interface{} `json:"output"`
	Error     string      `json:"error,omitempty"`
	Traceback string      `json:"traceback,omitempty"`
	Fatal     string      `json:"fatal,omitempty"`
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
		testCtx, cancel := context.WithTimeout(ctx, testTimeout)
		stdout, stderr, runErr := exec.RunInContainer(
			testCtx,
			pooledContainer.ID,
			nil, // uploaded once above
			submissionWorkspace.HostPath,
			submissionWorkspace.ContainerPath,
			nil,
			adapter.RunCommand(inputB64),
			testTimeout,
			0, // limit applied once above
		)
		cancel()

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
			tr.TimeMs = time.Since(testStart).Milliseconds()
			result.AddTestResult(tr)
			continue
		}

		if stdoutTruncated {
			markTestFailed(&tr, models.SubmissionStatusWrongAnswer)
			tr.Error = "Output Limit Exceeded"
			tr.TimeMs = time.Since(testStart).Milliseconds()
			result.AddTestResult(tr)
			continue
		}

		out, userLogs, parseErr := parseSingleTestOutput(stdoutTrimmed, stderrTrimmed)
		if parseErr != nil {
			markTestFailed(&tr, models.SubmissionStatusRuntimeError)
			result.InternalError = models.InternalErrorJudge
			tr.TimeMs = time.Since(testStart).Milliseconds()
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
			tr.TimeMs = time.Since(testStart).Milliseconds()
			result.AddTestResult(tr)
			continue
		}

		tr.Output = out.Output
		tr.Passed = comparator.Compare(tc.Expected, out.Output, problem.CompareConfig)
		tr.Ok = tr.Passed
		if !tr.Passed {
			tr.ErrorType = models.ErrorTypeWrongAnswer
		}
		tr.TimeMs = time.Since(testStart).Milliseconds()
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

	testsPayload := make([]map[string]interface{}, 0, len(problem.TestCases))
	for _, tc := range problem.TestCases {
		testsPayload = append(testsPayload, map[string]interface{}{"inputs": tc.Input})
	}
	testsJSON, err := json.Marshal(testsPayload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal batched tests: %w", err)
	}
	if len(testsJSON) > maxTestsBytes {
		return nil, fmt.Errorf("batched tests JSON too large: %d bytes", len(testsJSON))
	}

	testTimeout := perTestTimeout(problem)
	runTimeout := time.Duration(len(problem.TestCases)+1) * testTimeout
	runCtx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()

	stream, err := exec.RunInContainerStream(
		runCtx,
		pooledContainer.ID,
		func() []string {
			if _, ok := adapter.(adapters.CompilingLanguageAdapter); ok {
				return nil
			}
			return append([]string{}, baseFiles...)
		}(),
		submissionWorkspace.HostPath,
		submissionWorkspace.ContainerPath,
		nil,
		adapter.BatchRunCommand(base64.StdEncoding.EncodeToString(testsJSON)),
		runTimeout,
		problem.MemoryLimitMb,
	)
	if err != nil {
		return nil, err
	}

	var stderrBuf bytes.Buffer
	watch := batchWatch{
		testTimeout:   testTimeout,
		startup:       batchStartupAllowance,
		stopOnFailure: submissionMsg.StopOnFirstFailure,
		cancelRun:     cancel,
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

	remainingReason := ""
	switch {
	case stoppedEarly:
		// Graded submission stopped at its first failure (T1); the rest never ran.
		appendNotRunTests(result, problem, processed)
	case timedOut:
		// The test the watchdog was waiting for ran past its limit (F6). Tests after it never
		// ran; a graded submission reports them as not run (below), anything else keeps the
		// earlier behaviour of reporting them as timed out too.
		remainingReason = models.SubmissionStatusTimeLimitExceeded
	case errors.Is(parseErr, errBatchedOutputLimitExceeded):
		remainingReason = "Output Limit Exceeded"
	case runErr != nil:
		runErrText := strings.ToLower(runErr.Error())
		if strings.Contains(runErrText, "timed out") || strings.Contains(runErrText, "deadline exceeded") {
			remainingReason = "Time Limit Exceeded"
		} else if errors.Is(runErr, executor.ErrMemoryLimitExceeded) {
			remainingReason = models.SubmissionStatusMemoryLimitExceeded
		} else {
			// The student's program exited non-zero (see the per-test path, T3).
			remainingReason = "Runtime Error"
		}
	case parseErr != nil:
		remainingReason = "Runtime Error"
		result.InternalError = models.InternalErrorJudge
	case processed < len(problem.TestCases):
		remainingReason = "Runtime Error"
		result.InternalError = models.InternalErrorWrapper
	}
	if parseErr != nil {
		slog.Error("batched output parse error", "submissionId", submissionMsg.SubmissionID, "processed", processed, "error", parseErr)
	}
	if runErr != nil {
		slog.Error("batched execution error", "submissionId", submissionMsg.SubmissionID, "processed", processed, "error", runErr)
	}
	if remainingReason != "" {
		appendMissingBatchedResults(result, problem, processed, remainingReason)
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

	return result, nil
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
}

// The first result also pays for starting the program, which a per-test run pays on every test.
const batchStartupAllowance = 2 * time.Second

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
			if out.Test <= 0 || out.Test > len(problem.TestCases) {
				continue
			}

			tr := batchedTestResult(out, problem)
			tr.TimeMs = ev.at.Sub(last).Milliseconds()
			last = ev.at
			result.AddTestResult(tr)
			processed++

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
	for i := len(result.Details) - processed; i < len(result.Details); i++ {
		if i >= 0 {
			result.Details[i].Stdout = rawStdout
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
	if out.Error != "" {
		reason := models.SubmissionStatusRuntimeError
		if strings.Contains(strings.ToLower(out.Error), "outofmemory") {
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
	default:
		return false
	}
	return testCount >= threshold
}
