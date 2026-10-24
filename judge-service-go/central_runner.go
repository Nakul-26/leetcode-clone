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
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		_, _ = io.Copy(&stderrBuf, stream.Stderr)
		_ = stream.Stderr.Close()
	}()

	processed, parseErr := appendBatchedResults(result, stream.Stdout, &stderrBuf, problem)
	_ = stream.Stdout.Close()

	exitCode, waitErr := stream.Wait()
	<-stderrDone

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
		// The batch has already run every test in one process; this only reports the same
		// shape as the per-test path. Stopping a batch early needs per-test limits inside
		// the wrappers (JUDGE_FIX_PLAN F6).
		markNotRunAfterFirstFailure(result)
	}

	finished := time.Now().UTC()
	result.FinishedAt = &finished
	result.ElapsedMs = finished.Sub(*result.StartedAt).Milliseconds()
	result.UpdateStatus()

	return result, nil
}

func appendBatchedResults(result *models.SubmissionResult, stdout io.Reader, stderr io.Reader, problem models.Problem) (int, error) {
	stdoutFull, err := io.ReadAll(stdout)
	if err != nil {
		return 0, err
	}
	stderrFull, err := io.ReadAll(stderr)
	if err != nil {
		return 0, err
	}

	rawStdout := string(stdoutFull)
	rawStderr := string(stderrFull)
	processed := 0

	// User prints go to stdout. Judge metadata goes to stderr as JSON lines.
	// We'll parse stderr line by line for JSON objects.
	lines := strings.Split(rawStderr, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}

		var out batchedTestExecOutput
		if err := json.Unmarshal([]byte(line), &out); err != nil {
			continue
		}

		if out.Fatal != "" {
			return processed, fmt.Errorf("wrapper fatal error: %s", out.Fatal)
		}
		if out.Test <= 0 || out.Test > len(problem.TestCases) {
			continue
		}

		tc := problem.TestCases[out.Test-1]
		testStart := time.Now()
		tr := models.TestResult{
			Test:     out.Test,
			Input:    tc.Input,
			Expected: tc.Expected,
			Output:   out.Output,
			// In batch mode, correlating per-test stdout is harder if it's all in one stream.
			// However, usually we can just put the whole stdout in if needed, 
			// or assume students don't print in batch mode.
			// For now, let's just use the raw stdout if it's the only test, 
			// or leave it as is if we can't easily split it.
			Stdout: rawStdout,
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
		} else {
			tr.Passed = comparator.Compare(tc.Expected, out.Output, problem.CompareConfig)
			tr.Ok = tr.Passed
			if !tr.Passed {
				tr.ErrorType = models.ErrorTypeWrongAnswer
			}
		}
		tr.TimeMs = time.Since(testStart).Milliseconds()
		result.AddTestResult(tr)
		processed++
	}

	return processed, nil
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
