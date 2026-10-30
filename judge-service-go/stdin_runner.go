package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
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

// runSubmissionStdinDetailed executes a ProblemType: stdin submission
// (pkg/models/problem_type.go): one exec per test case, piping the test's
// raw stdin text into the user's program and exact-text comparing raw stdout
// via comparator.CompareText. No wrapper, no batching — structurally
// modeled on runSubmissionCentralPerTest (central_runner.go), which has the
// function-mode equivalent of every step here; see
// docs/arventiq-integration/PLAN.md §3.3's stage table for why the two
// diverge at each one.
func runSubmissionStdinDetailed(ctx context.Context, exec *executor.Executor, pooledContainer *pool.PooledContainer, submissionMsg models.SubmissionMessage, problem models.Problem) (result *models.SubmissionResult, cleanupFailed bool, err error) {
	stdinAdapter, ok := adapters.GetStdinAdapter(submissionMsg.Language)
	if !ok {
		return nil, false, fmt.Errorf("language %q is not supported for stdin-mode problems", submissionMsg.Language)
	}

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

	source := stdinSourceFor(submissionMsg)
	baseFiles, err := stdinAdapter.PrepareFiles(submissionWorkspace.HostPath, source)
	if err != nil {
		return nil, cleanupFailed, err
	}

	result = startedResult(problem)

	var compileCmd []string
	if compilingAdapter, ok := stdinAdapter.(adapters.CompilingStdinLanguageAdapter); ok {
		compileCmd = compilingAdapter.CompileCommand()
		if err := compileStdinSubmission(ctx, exec, pooledContainer, submissionWorkspace, compileCmd, baseFiles, problem); err != nil {
			return finalizeExecutionFailure(result, err), cleanupFailed, nil
		}
	}
	compiled := len(compileCmd) > 0

	testTimeout := perTestTimeout(problem)
	runCmd := stdinAdapter.RunCommand()

	// Once per submission rather than once per test case: the run-phase memory limit (each
	// per-test set + reset was two docker updates) and, for interpreted languages, the source
	// upload. finishWithContainer restores the default limit when the container is released.
	if problem.MemoryLimitMb > 0 {
		if err := exec.UpdateContainerResources(ctx, pooledContainer.ID, problem.MemoryLimitMb); err != nil {
			slog.Warn("failed to apply execution memory limit", "containerId", pooledContainer.ID, "error", err)
		}
	}
	// All tests in one exec (JUDGE_FIX_PLAN T5) unless switched off or a test is malformed (the
	// per-test loop below reports those one by one). The inputs go up with the source.
	batched := stdinBatchEnabled() && stdinTestsWellFormed(problem)
	var upload []string
	if !compiled {
		upload = append(upload, baseFiles...)
	}
	if batched {
		inputFiles, err := writeStdinInputs(submissionWorkspace.HostPath, problem)
		if err != nil {
			return finalizeExecutionFailure(result, err), cleanupFailed, nil
		}
		upload = append(upload, inputFiles...)
	}
	if len(upload) > 0 {
		if err := exec.CopyFiles(ctx, pooledContainer.ID, submissionWorkspace.HostPath, submissionWorkspace.ContainerPath, upload); err != nil {
			return finalizeExecutionFailure(result, err), cleanupFailed, nil
		}
	}
	if batched {
		launch := func(runCtx context.Context, rest models.Problem, offset int, runTimeout time.Duration) (*executor.ExecStream, error) {
			cmd := append([]string{"sh", "-c", stdinRunnerScript, "judge-runner",
				strconv.Itoa(offset + 1), strconv.Itoa(offset + len(rest.TestCases)),
				strconv.Itoa(maxTestOutputBytes + 1), strconv.Itoa(maxLogOutputBytes)}, runCmd...)
			return exec.RunInContainerStream(runCtx, pooledContainer.ID, nil, submissionWorkspace.HostPath, submissionWorkspace.ContainerPath,
				nil, cmd, runTimeout, 0) // memory limit applied once above
		}
		if err := runBatchedTests(ctx, exec, pooledContainer, submissionMsg, problem, result, launch, stdinBatchedResult, true); err != nil {
			return finalizeExecutionFailure(result, err), cleanupFailed, nil
		}
		return result, cleanupFailed, nil
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

		// ValidateBasic already enforces this shape for stdin problems (see
		// pkg/models/problem.go); re-checked here so a caller that skipped
		// validation (e.g. a future direct-call path) fails a single test
		// cleanly instead of panicking the whole submission.
		stdinText, inputOk := stdinTestInput(tc)
		expectedText, hasExpected, expectedOk := stdinTestExpected(tc)
		if !inputOk || !expectedOk {
			markTestFailed(&tr, models.SubmissionStatusRuntimeError)
			tr.Error = "invalid stdin test case shape (expected string input/expected)"
			tr.TimeMs = time.Since(testStart).Milliseconds()
			result.AddTestResult(tr)
			continue
		}


		var stdout, stderr string
		var exitCode int
		timing, runErr := runWithCPULimit(ctx, exec, pooledContainer.ID, testTimeout, func(runCtx context.Context, wallTimeout time.Duration) error {
			testCtx, cancel := context.WithTimeout(runCtx, wallTimeout)
			defer cancel()
			var err error
			stdout, stderr, exitCode, err = exec.RunInContainerWithStdin(
				testCtx,
				pooledContainer.ID,
				nil, // uploaded once above
				submissionWorkspace.HostPath,
				submissionWorkspace.ContainerPath,
				nil,
				runCmd,
				stdinText,
				wallTimeout,
				0, // limit applied once above
			)
			return err
		})
		if timing.Exceeded {
			runErr = executor.NewExecutionError(executor.ErrTimeLimitExceeded, fmt.Sprintf("CPU time limit of %v exceeded", testTimeout), -1)
		}

		stdoutForResult, stdoutTruncated := truncateString(stdout, maxTestOutputBytes)
		stderrForLog, stderrTruncated := truncateString(strings.TrimSpace(stderr), maxLogOutputBytes)
		tr.Stdout = stdoutForResult
		tr.Stderr = stderrForLog
		// Reported as GO Judge exit_code on the public surface, which a caller uses to
		// distinguish a crash from a wrong answer.
		tr.ExitCode = exitCode

		if runErr != nil {
			errStr := strings.ToLower(runErr.Error())
			switch {
			case errors.Is(runErr, executor.ErrTimeLimitExceeded) || errors.Is(runErr, context.DeadlineExceeded) || strings.Contains(errStr, "deadline exceeded") || strings.Contains(errStr, "timed out"):
				markTestFailed(&tr, models.SubmissionStatusTimeLimitExceeded)
			case errors.Is(runErr, executor.ErrMemoryLimitExceeded) || strings.Contains(errStr, "memory limit exceeded"):
				markTestFailed(&tr, models.SubmissionStatusMemoryLimitExceeded)
			default:
				// Unlike function mode, a non-zero exit here is the user's own
				// program failing — there's no wrapper to blame, so
				// result.InternalError stays unset.
				markTestFailed(&tr, models.SubmissionStatusRuntimeError)
				if stderrForLog != "" {
					tr.Error = "Runtime Error"
					tr.Traceback = stderrForLog
				}
			}
			slog.Error("stdin runtime error", "submissionId", submissionMsg.SubmissionID, "test", i+1, "error", runErr)
			if stderrForLog != "" {
				slog.Error("stdin runtime stderr", "submissionId", submissionMsg.SubmissionID, "test", i+1, "stderr", stderrForLog, "truncated", stderrTruncated)
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

		tr.Output = stdout
		if hasExpected {
			tr.Passed = comparator.CompareText(stdout, expectedText)
			if !tr.Passed {
				tr.ErrorType = models.ErrorTypeWrongAnswer
			}
		} else {
			// No expected output: the test exists only to run the program and
			// capture what it wrote. Having run to completion IS the pass
			// condition — a non-zero exit was already handled as a runtime error
			// above — so stdout is reported without being judged.
			tr.Passed = true
		}
		tr.Ok = tr.Passed
		tr.TimeMs = timing.TimeMs()
		result.AddTestResult(tr)
	}

	finished := time.Now().UTC()
	result.FinishedAt = &finished
	result.ElapsedMs = finished.Sub(*result.StartedAt).Milliseconds()
	result.UpdateStatus()

	return result, cleanupFailed, nil
}

// compileStdinSubmission mirrors compileCentralSubmission (central_runner.go)
// for the StdinLanguageAdapter type — same behavior, different adapter
// interface, so it can't share the same function without a common
// compile-command supertype that doesn't otherwise exist.
func compileStdinSubmission(ctx context.Context, exec *executor.Executor, pooledContainer *pool.PooledContainer, submissionWorkspace *workspace.SubmissionWorkspace, compileCmd []string, files []string, problem models.Problem) error {
	stdout, stderr, err := exec.CompileInContainer(
		ctx,
		pooledContainer.ID,
		files,
		submissionWorkspace.HostPath,
		submissionWorkspace.ContainerPath,
		compileCmd,
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

func stdinTestInput(tc models.TestCase) (string, bool) {
	if len(tc.Input) != 1 {
		return "", false
	}
	s, ok := tc.Input[0].(string)
	return s, ok
}

// stdinTestExpected reports the expected stdout text for a stdin test case.
// It distinguishes three states, because "absent" and "malformed" must not be
// treated alike: hasExpected is false when the test carries no expected output
// at all (run and report, do not judge — see the call site), while ok is false
// only when an expected output is present but is not a string, which is bad
// test data and fails the test.
func stdinTestExpected(tc models.TestCase) (text string, hasExpected bool, ok bool) {
	if tc.Expected == nil {
		return "", false, true
	}
	s, isString := tc.Expected.(string)
	return s, true, isString
}

// stdinSourceFor returns the program text to write for a stdin submission: exactly what
// the student wrote. Source used to go through UnescapeCode, which turned the two
// characters backslash-n into a real newline and broke programs that print one.
// It was removed on 2026-10-24 after production showed no client sends pre-escaped
// code (JUDGE_FIX_PLAN F1).
func stdinSourceFor(msg models.SubmissionMessage) string {
	return msg.Code
}

// stdinRunnerScript runs a stdin program once per test input in a single exec (JUDGE_FIX_PLAN
// T5), instead of one exec per test. Arguments: first and last test number, the stdout and
// stderr caps, then the run command. The inputs are files judge-input-N in the workspace.
// Each run's stdout and stderr go through head, so a program that writes without end is cut
// off (and gets SIGPIPE) instead of filling memory-backed storage. After each run it writes
// one line to its own stderr, which the judge reads as it comes (streamBatchedResults):
// {"test":k,"exit":code,"out":base64,"err":base64}, k counted from 1 within this run.
const stdinRunnerScript = `first=$1; last=$2; oc=$3; ec=$4; shift 4
i=$first
while [ "$i" -le "$last" ]; do
	( ( "$@" < "judge-input-$i" 2>&3; echo $? > .judge-code ) | head -c "$oc" > .judge-out ) 3>&1 | head -c "$ec" > .judge-err
	code=$(cat .judge-code 2>/dev/null); [ -n "$code" ] || code=255
	printf '{"test":%d,"exit":%d,"out":"%s","err":"%s"}\n' $((i - first + 1)) "$code" "$(base64 -w 0 < .judge-out)" "$(base64 -w 0 < .judge-err)" >&2
	rm -f .judge-code .judge-out .judge-err
	i=$((i + 1))
done`

// stdinBatchEnabled is the switch for the single-exec stdin path: JUDGE_STDIN_BATCH=0 goes back
// to one exec per test.
func stdinBatchEnabled() bool {
	return strings.TrimSpace(os.Getenv("JUDGE_STDIN_BATCH")) != "0"
}

func stdinTestsWellFormed(problem models.Problem) bool {
	for _, tc := range problem.TestCases {
		_, inputOk := stdinTestInput(tc)
		_, _, expectedOk := stdinTestExpected(tc)
		if !inputOk || !expectedOk {
			return false
		}
	}
	return len(problem.TestCases) > 0
}

// writeStdinInputs writes each test's input as judge-input-N in the host workspace.
func writeStdinInputs(dir string, problem models.Problem) ([]string, error) {
	files := make([]string, 0, len(problem.TestCases))
	for i, tc := range problem.TestCases {
		text, _ := stdinTestInput(tc)
		name := "judge-input-" + strconv.Itoa(i+1)
		if err := workspace.WriteFile(dir, name, []byte(text), 0644); err != nil {
			return nil, fmt.Errorf("failed to write %s: %w", name, err)
		}
		files = append(files, name)
	}
	return files, nil
}

// stdinBatchedResult judges one test from a stdinRunnerScript line, the way the per-test loop
// in runSubmissionStdinDetailed judges one exec.
func stdinBatchedResult(out batchedTestExecOutput, problem models.Problem) models.TestResult {
	tc := problem.TestCases[out.Test-1]
	tr := models.TestResult{Test: out.Test, Input: tc.Input, Expected: tc.Expected}
	stdoutBytes, err1 := base64.StdEncoding.DecodeString(out.Out)
	stderrBytes, err2 := base64.StdEncoding.DecodeString(out.Err)
	if out.Exit == nil || err1 != nil || err2 != nil {
		markTestFailed(&tr, models.SubmissionStatusRuntimeError)
		tr.Error = "unreadable result from the stdin runner"
		return tr
	}
	stdout := string(stdoutBytes)
	stdoutForResult, stdoutTruncated := truncateString(stdout, maxTestOutputBytes)
	stderrForLog, _ := truncateString(strings.TrimSpace(string(stderrBytes)), maxLogOutputBytes)
	tr.Stdout = stdoutForResult
	tr.Stderr = stderrForLog
	tr.ExitCode = *out.Exit

	switch {
	case stdoutTruncated:
		// Checked before the exit code: the runner cuts the output off, so the program's
		// next write fails with SIGPIPE (exit 141).
		markTestFailed(&tr, models.SubmissionStatusWrongAnswer)
		tr.Error = "Output Limit Exceeded"
		return tr
	case tr.ExitCode == 137:
		markTestFailed(&tr, models.SubmissionStatusMemoryLimitExceeded)
		return tr
	case tr.ExitCode != 0:
		markTestFailed(&tr, models.SubmissionStatusRuntimeError)
		if stderrForLog != "" {
			tr.Error = "Runtime Error"
			tr.Traceback = stderrForLog
		}
		return tr
	}

	tr.Output = stdout
	if expectedText, hasExpected, _ := stdinTestExpected(tc); hasExpected {
		tr.Passed = comparator.CompareText(stdout, expectedText)
		if !tr.Passed {
			tr.ErrorType = models.ErrorTypeWrongAnswer
		}
	} else {
		// No expected output: running to completion is the pass condition (see the per-test loop).
		tr.Passed = true
	}
	tr.Ok = tr.Passed
	return tr
}
