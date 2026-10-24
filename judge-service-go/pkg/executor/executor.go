package executor

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	docker "github.com/fsouza/go-dockerclient"

	"judge-service-go/pkg/workspace"
)

// Executor holds the Docker client
type Executor struct {
	cli *docker.Client
}

// maxCapturedOutputBytes caps how much of a single exec's stdout/stderr this process
// will buffer in memory, well above the 64KB/4KB limits main.go later truncates to for
// storage, but bounded so a submission that prints in a tight loop can't grow
// judge-service-go's own heap without limit for the full exec timeout window. The
// container's memory cgroup limits the child process, not this buffer — it lives here,
// in the judge service's process, so it needs its own cap.
const maxCapturedOutputBytes = 1 * 1024 * 1024

// boundedWriter buffers up to limit bytes and silently discards the rest, always
// reporting a full, successful write so the Docker output stream keeps draining
// (a short/failed write here would stall or error the exec mid-run) instead of
// buffering an unbounded amount of flood output.
type boundedWriter struct {
	buf   bytes.Buffer
	limit int
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	if remaining := w.limit - w.buf.Len(); remaining > 0 {
		if remaining > len(p) {
			remaining = len(p)
		}
		w.buf.Write(p[:remaining])
	}
	return len(p), nil
}

func (w *boundedWriter) String() string {
	return w.buf.String()
}

type ExecStream struct {
	Stdout io.ReadCloser
	Stderr io.ReadCloser

	waitOnce sync.Once
	waitCh   chan execWaitResult
	result   execWaitResult
}

type execWaitResult struct {
	exitCode int
	err      error
}

// NewExecutor creates a new Executor instance
func NewExecutor() (*Executor, error) {
	// Try to connect to Docker daemon via environment variables
	cli, err := docker.NewClientFromEnv()
	if err != nil {
		// Fallback to default Unix socket if environment variables are not set
		cli, err = docker.NewClient("unix:///var/run/docker.sock")
		if err != nil {
			return nil, fmt.Errorf("failed to create docker client: %w", err)
		}
	}
	return &Executor{cli: cli}, nil
}

// Client returns the underlying Docker client.
func (e *Executor) Client() *docker.Client {
	return e.cli
}

// compilationMemoryFloorMb returns the minimum memory (MB) to grant a container during
// compilation. kotlinc's JVM-based compiler daemon needs materially more than the usual
// 1024MB floor to compile even trivial submissions without being OOM-killed (observed:
// a plain two-argument function reliably OOMs at 1024MB once the wrapper it's compiled
// alongside registers a few Gson TypeAdapters).
func compilationMemoryFloorMb(compileCmd []string) int64 {
	for _, arg := range compileCmd {
		if strings.Contains(arg, "kotlinc") {
			return 2048
		}
	}
	return 1024
}

// UpdateContainerResources updates the resource limits of a running container.
func (e *Executor) UpdateContainerResources(ctx context.Context, containerID string, memoryMb int64) error {
	if memoryMb <= 0 {
		return nil
	}

	memoryBytes := memoryMb * 1024 * 1024
	slog.Info("Updating container resource limits", "containerId", containerID, "memoryMb", memoryMb)

	opts := docker.UpdateContainerOptions{
		Context:    ctx,
		Memory:     int(memoryBytes),
		MemorySwap: int(memoryBytes),
	}
	if err := e.cli.UpdateContainer(containerID, opts); err != nil {
		return fmt.Errorf("failed to update container memory limit: %w", err)
	}
	return nil
}

func (s *ExecStream) Wait() (int, error) {
	s.waitOnce.Do(func() {
		s.result = <-s.waitCh
	})
	return s.result.exitCode, s.result.err
}

// CopyFiles uploads files from a submission's host workspace into its container workspace.
// Runners use it to upload once per submission rather than once per test case.
func (e *Executor) CopyFiles(ctx context.Context, containerID string, hostWorkDir string, containerWorkDir string, files []string) error {
	return e.copyFilesToContainer(ctx, containerID, hostWorkDir, containerWorkDir, files)
}

// containerResetScript returns a pooled container to a clean state between submissions:
//   - any process the submission left running, killed first so nothing can recreate files
//     after they are removed;
//   - every submission directory under /app (they are world-readable, so leaving them let a later
//     submission in the same container read earlier students' source code, and /app is
//     memory-backed, so they also ate into the container's memory limit);
//   - everything in /tmp including hidden entries (a plain /tmp/* glob skips dot-files), except
//     .cache, which holds the Go build cache that makes repeat Go compiles fast.
//
// It then checks that no judge-user process survived, and exits non-zero if one did or if
// pkill is missing, so the caller discards the container instead of reusing it dirty. Because
// the reset is what makes reuse safe, a TLE, MLE or crash no longer discards the container
// (JUDGE_FIX_PLAN T2).
const containerResetScript = `command -v pkill >/dev/null || { echo "pkill missing"; exit 1; }; ` +
	`pkill -9 -u judge; ` +
	`rm -rf /app/sub-* 2>/dev/null; find /tmp -mindepth 1 -maxdepth 1 ! -name .cache -exec rm -rf {} \; 2>/dev/null; ` +
	`i=0; while pgrep -u judge >/dev/null && [ $i -lt 40 ]; do sleep 0.05; i=$((i+1)); done; ` +
	`if pgrep -u judge >/dev/null; then echo "judge processes survived the reset"; exit 1; fi; exit 0`

// ResetContainer cleans a container after a submission and restores its default memory limit,
// before it goes back to the pool. Once per submission, so per-test steps can skip both.
// An error means the container could not be trusted clean; the caller should discard it.
func (e *Executor) ResetContainer(ctx context.Context, containerID string) error {
	// Restore the limit first: after an MLE the container is still at the problem's limit with
	// the student's process holding memory, and the reset shell itself could be OOM-killed.
	if err := e.UpdateContainerResources(ctx, containerID, 1024); err != nil {
		return err
	}
	stdout, stderr, exitCode, err := e.runExecWithTimeout(ctx, containerID, "root", "/", []string{"sh", "-c", containerResetScript}, 10*time.Second)
	if err != nil {
		return fmt.Errorf("container reset failed: %w (exit=%d stdout=%s stderr=%s)", err, exitCode, stdout, stderr)
	}
	return nil
}

// runExecWithTimeout handles the full lifecycle of creating, running, and waiting for an exec instance.
func (e *Executor) runExecWithTimeout(ctx context.Context, containerID string, user string, workDir string, cmd []string, timeout time.Duration) (string, string, int, error) {
	stdoutBuf := &boundedWriter{limit: maxCapturedOutputBytes}
	stderrBuf := &boundedWriter{limit: maxCapturedOutputBytes}

	execOpts := docker.CreateExecOptions{
		Container:    containerID,
		User:         user,
		Cmd:          cmd,
		WorkingDir:   workDir,
		AttachStdout: true,
		AttachStderr: true,
		Context:      ctx,
	}
	execObj, err := e.cli.CreateExec(execOpts)
	if err != nil {
		return "", "", -1, fmt.Errorf("failed to create exec: %w", err)
	}

	// Use a child context with timeout so it cancels the StartExec if needed.
	childCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	startExecOptions := docker.StartExecOptions{
		OutputStream: stdoutBuf,
		ErrorStream:  stderrBuf,
		Context:      childCtx,
	}
	closeWaiter, err := e.cli.StartExecNonBlocking(execObj.ID, startExecOptions)
	if err != nil {
		return stdoutBuf.String(), stderrBuf.String(), -1, fmt.Errorf("failed to start exec: %w", err)
	}
	var closeOnce sync.Once
	closeExec := func() {
		closeOnce.Do(func() {
			_ = closeWaiter.Close()
		})
	}
	defer closeExec()

	done := make(chan error, 1)
	go func() {
		done <- closeWaiter.Wait()
	}()

	select {
	case err := <-done:
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) || childCtx.Err() == context.DeadlineExceeded || strings.Contains(strings.ToLower(err.Error()), "deadline exceeded") {
				return stdoutBuf.String(), stderrBuf.String(), -1, NewExecutionError(ErrTimeLimitExceeded, fmt.Sprintf("execution timed out after %v", timeout), -1)
			}
			return stdoutBuf.String(), stderrBuf.String(), -1, err
		}
	case <-childCtx.Done():
		// timed out or cancelled
		closeExec()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			slog.Warn("exec waiter did not exit promptly after cancellation", "containerId", containerID, "cmd", cmd)
		}
		if childCtx.Err() == context.DeadlineExceeded {
			slog.Warn("exec timed out", "containerId", containerID, "timeout", timeout, "cmd", cmd)
			return stdoutBuf.String(), stderrBuf.String(), -1, NewExecutionError(ErrTimeLimitExceeded, fmt.Sprintf("execution timed out after %v", timeout), -1)
		}
		return stdoutBuf.String(), stderrBuf.String(), -1, childCtx.Err()
	case <-ctx.Done():
		// caller cancelled
		closeExec()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			slog.Warn("exec waiter did not exit promptly after caller cancellation", "containerId", containerID, "cmd", cmd)
		}
		return stdoutBuf.String(), stderrBuf.String(), -1, ctx.Err()
	}

	// Inspect exec to get exit code
	inspect, err := e.cli.InspectExec(execObj.ID)
	if err != nil {
		return stdoutBuf.String(), stderrBuf.String(), -1, fmt.Errorf("failed to inspect exec: %w", err)
	}

	if inspect.ExitCode != 0 {
		return stdoutBuf.String(), stderrBuf.String(), inspect.ExitCode, exitError(inspect.ExitCode, stderrBuf.String())
	}

	return stdoutBuf.String(), stderrBuf.String(), inspect.ExitCode, nil
}

// runExecWithStdinTimeout is runExecWithTimeout's sibling for stdin-mode
// execution: it attaches stdin and streams stdinInput into the process
// instead of passing input as a CLI argument. Kept as a separate function
// (rather than adding a stdin parameter to runExecWithTimeout) so the
// function-mode path — covered by the existing test suite — is provably
// untouched.
func (e *Executor) runExecWithStdinTimeout(ctx context.Context, containerID string, user string, workDir string, cmd []string, stdinInput string, timeout time.Duration) (string, string, int, error) {
	stdoutBuf := &boundedWriter{limit: maxCapturedOutputBytes}
	stderrBuf := &boundedWriter{limit: maxCapturedOutputBytes}

	execOpts := docker.CreateExecOptions{
		Container:    containerID,
		User:         user,
		Cmd:          cmd,
		WorkingDir:   workDir,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		Context:      ctx,
	}
	execObj, err := e.cli.CreateExec(execOpts)
	if err != nil {
		return "", "", -1, fmt.Errorf("failed to create exec: %w", err)
	}

	childCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	startExecOptions := docker.StartExecOptions{
		InputStream:  strings.NewReader(stdinInput),
		OutputStream: stdoutBuf,
		ErrorStream:  stderrBuf,
		Context:      childCtx,
	}
	closeWaiter, err := e.cli.StartExecNonBlocking(execObj.ID, startExecOptions)
	if err != nil {
		return stdoutBuf.String(), stderrBuf.String(), -1, fmt.Errorf("failed to start exec: %w", err)
	}
	var closeOnce sync.Once
	closeExec := func() {
		closeOnce.Do(func() {
			_ = closeWaiter.Close()
		})
	}
	defer closeExec()

	done := make(chan error, 1)
	go func() {
		done <- closeWaiter.Wait()
	}()

	select {
	case err := <-done:
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) || childCtx.Err() == context.DeadlineExceeded || strings.Contains(strings.ToLower(err.Error()), "deadline exceeded") {
				return stdoutBuf.String(), stderrBuf.String(), -1, NewExecutionError(ErrTimeLimitExceeded, fmt.Sprintf("execution timed out after %v", timeout), -1)
			}
			return stdoutBuf.String(), stderrBuf.String(), -1, err
		}
	case <-childCtx.Done():
		closeExec()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			slog.Warn("stdin exec waiter did not exit promptly after cancellation", "containerId", containerID, "cmd", cmd)
		}
		if childCtx.Err() == context.DeadlineExceeded {
			slog.Warn("stdin exec timed out", "containerId", containerID, "timeout", timeout, "cmd", cmd)
			return stdoutBuf.String(), stderrBuf.String(), -1, NewExecutionError(ErrTimeLimitExceeded, fmt.Sprintf("execution timed out after %v", timeout), -1)
		}
		return stdoutBuf.String(), stderrBuf.String(), -1, childCtx.Err()
	case <-ctx.Done():
		closeExec()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			slog.Warn("stdin exec waiter did not exit promptly after caller cancellation", "containerId", containerID, "cmd", cmd)
		}
		return stdoutBuf.String(), stderrBuf.String(), -1, ctx.Err()
	}

	inspect, err := e.cli.InspectExec(execObj.ID)
	if err != nil {
		return stdoutBuf.String(), stderrBuf.String(), -1, fmt.Errorf("failed to inspect exec: %w", err)
	}

	if inspect.ExitCode != 0 {
		return stdoutBuf.String(), stderrBuf.String(), inspect.ExitCode, exitError(inspect.ExitCode, stderrBuf.String())
	}

	return stdoutBuf.String(), stderrBuf.String(), inspect.ExitCode, nil
}

func (e *Executor) copyFilesToContainer(ctx context.Context, containerID string, hostWorkDir string, containerWorkDir string, files []string) error {
	if len(files) == 0 {
		return nil
	}

	if err := workspace.ValidateNoExternalSymlinks(hostWorkDir); err != nil {
		return err
	}

	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, name := range files {
		path, err := workspace.SafeJoin(hostWorkDir, name)
		if err != nil {
			_ = tw.Close()
			return fmt.Errorf("invalid workspace path %s: %w", name, err)
		}
		data, info, err := workspace.ReadRegularFile(hostWorkDir, name)
		if err != nil {
			_ = tw.Close()
			return fmt.Errorf("failed to read %s: %w", path, err)
		}
		hdr := &tar.Header{
			Name:    name,
			Mode:    int64(info.Mode().Perm()),
			Size:    int64(len(data)),
			ModTime: info.ModTime(),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			_ = tw.Close()
			return fmt.Errorf("failed to write tar header for %s: %w", name, err)
		}
		if _, err := tw.Write(data); err != nil {
			_ = tw.Close()
			return fmt.Errorf("failed to write tar data for %s: %w", name, err)
		}
	}
	if err := tw.Close(); err != nil {
		return fmt.Errorf("failed to close tar writer: %w", err)
	}

	// Docker's archive-copy API (UploadToContainer, i.e. `docker cp`) does not work
	// against containers created with ReadonlyRootfs: true (see pool.go's
	// createContainer) — even onto an explicitly writable tmpfs mount like /app. The
	// daemon's PutContainerArchive path either rejects the copy outright ("container
	// rootfs is marked read-only", confirmed when the destination is the mount point
	// itself) or, for subdirectories of that mount, 404s ("Could not find the file ...
	// in container") even though a live `docker exec` confirms the directory exists.
	// So instead of asking the daemon to write the archive for us, extract it ourselves
	// inside the container via `docker exec` with the tar piped over stdin — a normal
	// process write to the live tmpfs, not subject to the archive-copy limitation.
	// chmod -R 0777 after extraction: the dir is created (and the tar extracted) as
	// root, but compilation/execution runs as the unprivileged "judge" user (see
	// getJudgeUser) — same world-writable-workspace approach NewSubmissionWorkspace
	// already uses for the host-side staging dir, just re-applied on the container side
	// since tar doesn't preserve that across the root-owned mkdir.
	extractCmd := []string{"sh", "-c", `mkdir -p "$1" && tar -xf - -C "$1" && chmod -R 0777 "$1"`, "sh", containerWorkDir}
	if _, stderr, _, err := e.runExecWithStdin(ctx, containerID, "root", "/", extractCmd, 20*time.Second, buf.Bytes()); err != nil {
		return fmt.Errorf("failed to extract files into container: %w (stderr=%s)", err, stderr)
	}
	return nil
}

func rewriteCommandForWorkspace(cmd []string, containerWorkDir string) []string {
	rewritten := make([]string, len(cmd))
	for i, part := range cmd {
		switch {
		case part == "/app":
			rewritten[i] = containerWorkDir
		case strings.HasPrefix(part, "/app/"):
			rewritten[i] = containerWorkDir + strings.TrimPrefix(part, "/app")
		default:
			rewritten[i] = part
		}
	}
	return rewritten
}

func (e *Executor) runExecStreamWithTimeout(ctx context.Context, containerID string, user string, workDir string, cmd []string, timeout time.Duration) (*ExecStream, error) {
	execOpts := docker.CreateExecOptions{
		Container:    containerID,
		User:         user,
		Cmd:          cmd,
		WorkingDir:   workDir,
		AttachStdout: true,
		AttachStderr: true,
		Context:      ctx,
	}
	execObj, err := e.cli.CreateExec(execOpts)
	if err != nil {
		return nil, fmt.Errorf("failed to create exec: %w", err)
	}

	childCtx, cancel := context.WithTimeout(ctx, timeout)
	stdoutReader, stdoutWriter := io.Pipe()
	stderrReader, stderrWriter := io.Pipe()

	startExecOptions := docker.StartExecOptions{
		OutputStream: stdoutWriter,
		ErrorStream:  stderrWriter,
		Context:      childCtx,
	}
	closeWaiter, err := e.cli.StartExecNonBlocking(execObj.ID, startExecOptions)
	if err != nil {
		cancel()
		_ = stdoutWriter.Close()
		_ = stderrWriter.Close()
		_ = stdoutReader.Close()
		_ = stderrReader.Close()
		return nil, fmt.Errorf("failed to start exec: %w", err)
	}

	stream := &ExecStream{
		Stdout: stdoutReader,
		Stderr: stderrReader,
		waitCh: make(chan execWaitResult, 1),
	}

	go func() {
		defer cancel()
		defer func() {
			_ = stdoutWriter.Close()
			_ = stderrWriter.Close()
		}()

		var closeOnce sync.Once
		closeExec := func() {
			closeOnce.Do(func() {
				_ = closeWaiter.Close()
			})
		}
		defer closeExec()

		done := make(chan error, 1)
		go func() {
			done <- closeWaiter.Wait()
		}()

		var waitResult execWaitResult
		select {
		case err := <-done:
			if err != nil {
				if errors.Is(err, context.DeadlineExceeded) || childCtx.Err() == context.DeadlineExceeded || strings.Contains(strings.ToLower(err.Error()), "deadline exceeded") {
					waitResult.err = NewExecutionError(ErrTimeLimitExceeded, fmt.Sprintf("execution timed out after %v", timeout), -1)
				} else {
					waitResult.err = err
				}
				stream.waitCh <- waitResult
				return
			}
		case <-childCtx.Done():
			closeExec()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				slog.Warn("exec waiter did not exit promptly after cancellation", "containerId", containerID, "cmd", cmd)
			}
			if childCtx.Err() == context.DeadlineExceeded {
				slog.Warn("exec timed out", "containerId", containerID, "timeout", timeout, "cmd", cmd)
				waitResult.err = NewExecutionError(ErrTimeLimitExceeded, fmt.Sprintf("execution timed out after %v", timeout), -1)
			} else {
				waitResult.err = childCtx.Err()
			}
			stream.waitCh <- waitResult
			return
		case <-ctx.Done():
			closeExec()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				slog.Warn("exec waiter did not exit promptly after caller cancellation", "containerId", containerID, "cmd", cmd)
			}
			waitResult.err = ctx.Err()
			stream.waitCh <- waitResult
			return
		}

		inspect, err := e.cli.InspectExec(execObj.ID)
		if err != nil {
			waitResult.err = fmt.Errorf("failed to inspect exec: %w", err)
			stream.waitCh <- waitResult
			return
		}

		waitResult.exitCode = inspect.ExitCode
		if inspect.ExitCode != 0 {
			if inspect.ExitCode == 137 {
				waitResult.err = NewExecutionError(ErrMemoryLimitExceeded, "process killed (possibly OOM)", inspect.ExitCode)
			} else {
				waitResult.err = NewExecutionError(ErrRuntimeError, fmt.Sprintf("exit code %d", inspect.ExitCode), inspect.ExitCode)
			}
		}
		stream.waitCh <- waitResult
	}()

	return stream, nil
}

func (e *Executor) collectStream(stream *ExecStream) (string, string, int, error) {
	stdoutBuf := &boundedWriter{limit: maxCapturedOutputBytes}
	stderrBuf := &boundedWriter{limit: maxCapturedOutputBytes}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(stdoutBuf, stream.Stdout)
		_ = stream.Stdout.Close()
	}()
	go func() {
		defer wg.Done()
		_, _ = io.Copy(stderrBuf, stream.Stderr)
		_ = stream.Stderr.Close()
	}()

	exitCode, waitErr := stream.Wait()
	wg.Wait()
	// The waiter classified the exit before stderr was fully read; re-check now that it is.
	if errors.Is(waitErr, ErrRuntimeError) {
		waitErr = exitError(exitCode, stderrBuf.String())
	}
	return stdoutBuf.String(), stderrBuf.String(), exitCode, waitErr
}

// RunInContainer executes user code in a given Docker container
func (e *Executor) RunInContainer(ctx context.Context, containerID string, files []string, hostWorkDir string, containerWorkDir string, compileCmd []string, runCmd []string, timeout time.Duration, memoryLimitMb int64) (string, string, error) {
	// Overall submission timeout derived from provided timeout (multiply by factor) or environment.
	submissionTimeout := timeout * 3
	subCtx, cancel := context.WithTimeout(ctx, submissionTimeout)
	defer cancel()

	stream, err := e.RunInContainerStream(subCtx, containerID, files, hostWorkDir, containerWorkDir, compileCmd, runCmd, timeout, memoryLimitMb)
	if err != nil {
		return "", "", err
	}
	runStdout, runStderr, _, err := e.collectStream(stream)
	return runStdout, runStderr, err
}

// RunInContainerWithStdin is RunInContainer's sibling for ProblemType: stdin
// (see pkg/models/problem_type.go) — instead of taking test input as a CLI
// argument, it pipes stdinInput to the process's stdin via
// runExecWithStdinTimeout, and returns raw stdout/stderr for the caller to
// exact-text compare (see pkg/comparator.CompareText). RunInContainer itself
// is untouched, so the function-mode path is provably unaffected by this
// addition.
//
// The process's exit code is returned alongside its output because the public
// GO Judge public API surface reports it as exit_code, and a caller uses it to tell a
// crashing program apart from a merely wrong one. It is 0 when the run never
// happened at all (a file-copy or compile failure).
func (e *Executor) RunInContainerWithStdin(ctx context.Context, containerID string, files []string, hostWorkDir string, containerWorkDir string, compileCmd []string, runCmd []string, stdinInput string, timeout time.Duration, memoryLimitMb int64) (string, string, int, error) {
	submissionTimeout := timeout * 3
	subCtx, cancel := context.WithTimeout(ctx, submissionTimeout)
	defer cancel()

	if len(files) > 0 {
		if err := e.copyFilesToContainer(subCtx, containerID, hostWorkDir, containerWorkDir, files); err != nil {
			return "", "", 0, err
		}
	}

	if memoryLimitMb > 0 {
		compilationLimit := memoryLimitMb
		if floor := compilationMemoryFloorMb(compileCmd); compilationLimit < floor {
			compilationLimit = floor
		}
		if err := e.UpdateContainerResources(subCtx, containerID, compilationLimit); err != nil {
			slog.Warn("failed to apply compilation memory limit", "containerId", containerID, "error", err)
		}
	}

	if len(compileCmd) > 0 {
		slog.Info("Compiling in container (stdin mode)", "containerId", containerID, "cmd", compileCmd)
		compileStdout, compileStderr, _, err := e.runExecWithTimeout(subCtx, containerID, getJudgeUser(), containerWorkDir, rewriteCommandForWorkspace(compileCmd, containerWorkDir), timeout)
		if err != nil {
			return "", "", 0, NewExecutionError(ErrCompilationFailed, fmt.Sprintf("%v | stdout=%s stderr=%s", err, compileStdout, compileStderr), -1)
		}
	}

	if memoryLimitMb > 0 {
		if err := e.UpdateContainerResources(subCtx, containerID, memoryLimitMb); err != nil {
			slog.Warn("failed to apply execution memory limit", "containerId", containerID, "error", err)
		}
	}

	runStdout, runStderr, runExit, err := e.runExecWithStdinTimeout(subCtx, containerID, getJudgeUser(), containerWorkDir, rewriteCommandForWorkspace(runCmd, containerWorkDir), stdinInput, timeout)

	if memoryLimitMb > 0 {
		if resetErr := e.UpdateContainerResources(context.Background(), containerID, 1024); resetErr != nil {
			slog.Error("failed to reset memory limit", "containerId", containerID, "error", resetErr)
			if err == nil {
				err = NewExecutionError(ErrContainerUnhealthy, fmt.Sprintf("failed to reset memory limit: %v", resetErr), -1)
			}
		}
	}

	if runEndedBadly(runExit, err) {
		e.killLeftovers(containerID)
	}

	return runStdout, runStderr, runExit, err
}

func (e *Executor) CompileInContainer(ctx context.Context, containerID string, files []string, hostWorkDir string, containerWorkDir string, compileCmd []string, timeout time.Duration, memoryLimitMb int64) (string, string, error) {
	submissionTimeout := timeout * 3
	subCtx, cancel := context.WithTimeout(ctx, submissionTimeout)
	defer cancel()

	if err := e.copyFilesToContainer(subCtx, containerID, hostWorkDir, containerWorkDir, files); err != nil {
		return "", "", err
	}

	// Apply memory limit before compilation
	if memoryLimitMb > 0 {
		compilationLimit := memoryLimitMb
		if floor := compilationMemoryFloorMb(compileCmd); compilationLimit < floor {
			compilationLimit = floor
		}
		if err := e.UpdateContainerResources(subCtx, containerID, compilationLimit); err != nil {
			slog.Warn("failed to apply memory limit for compilation", "containerId", containerID, "error", err)
		}
	}

	compileStdout, compileStderr, _, err := e.runExecWithTimeout(subCtx, containerID, getJudgeUser(), containerWorkDir, rewriteCommandForWorkspace(compileCmd, containerWorkDir), timeout)
	if err != nil {
		return compileStdout, compileStderr, NewExecutionError(ErrCompilationFailed, err.Error(), -1)
	}

	return compileStdout, compileStderr, nil
}

// runEndedBadly reports whether a test's process may still be running after its exec returned:
// a timeout or watchdog cancel leaves the student's process alive inside the container, and a
// crash can leave children behind. A clean exit needs no per-test cleanup (JUDGE_FIX_PLAN T5):
// the reset in finishWithContainer clears /tmp and kills everything once per submission, before
// the container is reused by anyone else.
func runEndedBadly(exitCode int, err error) bool {
	return err != nil || exitCode != 0
}

// killLeftovers stops whatever a test left running so it cannot eat CPU or memory while the
// next test of the same submission runs. Since the container's PID 1 runs as root, every process
// owned by the judge user can be killed without stopping the container.
func (e *Executor) killLeftovers(containerID string) {
	stdout, stderr, exitCode, err := e.runExecWithTimeout(context.Background(), containerID, "root", "/", []string{"sh", "-c", "pkill -9 -u judge || true"}, 5*time.Second)
	if err != nil && exitCode != 137 {
		slog.Error("failed to kill leftover processes", "containerId", containerID, "error", err, "stdout", stdout, "stderr", stderr, "exitCode", exitCode)
	}
}

func getJudgeUser() string {
	if u := os.Getenv("JUDGE_USER"); u != "" {
		return u
	}
	return "judge"
}

func (e *Executor) RunInContainerStream(ctx context.Context, containerID string, files []string, hostWorkDir string, containerWorkDir string, compileCmd []string, runCmd []string, timeout time.Duration, memoryLimitMb int64) (*ExecStream, error) {
	submissionTimeout := timeout * 3
	subCtx, cancel := context.WithTimeout(ctx, submissionTimeout)

	if len(files) > 0 {
		if err := e.copyFilesToContainer(subCtx, containerID, hostWorkDir, containerWorkDir, files); err != nil {
			cancel()
			return nil, err
		}
	}

	// Apply a reasonable limit during compilation if a strict limit is requested for run
	if memoryLimitMb > 0 {
		compilationLimit := memoryLimitMb
		if floor := compilationMemoryFloorMb(compileCmd); compilationLimit < floor {
			compilationLimit = floor
		}
		if err := e.UpdateContainerResources(subCtx, containerID, compilationLimit); err != nil {
			slog.Warn("failed to apply compilation memory limit", "containerId", containerID, "error", err)
		}
	}

	if len(compileCmd) > 0 {
		slog.Info("Compiling in container", "containerId", containerID, "cmd", compileCmd)
		compileStdout, compileStderr, _, err := e.runExecWithTimeout(subCtx, containerID, getJudgeUser(), containerWorkDir, rewriteCommandForWorkspace(compileCmd, containerWorkDir), timeout)
		if err != nil {
			cancel()
			return nil, NewExecutionError(ErrCompilationFailed, fmt.Sprintf("%v | stdout=%s stderr=%s", err, compileStdout, compileStderr), -1)
		}
	}

	// Apply strict memory limit BEFORE execution
	if memoryLimitMb > 0 {
		if err := e.UpdateContainerResources(subCtx, containerID, memoryLimitMb); err != nil {
			slog.Warn("failed to apply execution memory limit", "containerId", containerID, "error", err)
		}
	}

	stream, err := e.runExecStreamWithTimeout(subCtx, containerID, getJudgeUser(), containerWorkDir, rewriteCommandForWorkspace(runCmd, containerWorkDir), timeout)
	if err != nil {
		cancel()
		return nil, err
	}

	wrapped := &ExecStream{
		Stdout: stream.Stdout,
		Stderr: stream.Stderr,
		waitCh: make(chan execWaitResult, 1),
	}
	go func() {
		exitCode, waitErr := stream.Wait()
		cancel()

		// Reset limit AFTER execution completes. Bounded on its own timeout — this must
		// never be context.Background() unbounded: a stalled Docker daemon call here would
		// otherwise hang forever, and since the container is only released back to the
		// pool once this goroutine returns, one hang permanently strands a pooled container.
		if memoryLimitMb > 0 {
			resetCtx, resetCancel := context.WithTimeout(context.Background(), 10*time.Second)
			resetErr := e.UpdateContainerResources(resetCtx, containerID, 1024)
			resetCancel()
			if resetErr != nil {
				slog.Error("failed to reset memory limit", "containerId", containerID, "error", resetErr)
				if waitErr == nil {
					waitErr = NewExecutionError(ErrContainerUnhealthy, fmt.Sprintf("failed to reset memory limit: %v", resetErr), -1)
				}
			}
		}

		if runEndedBadly(exitCode, waitErr) {
			e.killLeftovers(containerID)
		}

		wrapped.waitCh <- execWaitResult{exitCode: exitCode, err: waitErr}
	}()

	return wrapped, nil
}

// runExecWithStdin is like runExecWithTimeout but attaches stdin and feeds stdinData
// to the process, then signals EOF so blocking readers (input()/scanf/Scanner...)
// unblock once all bytes have been consumed.
func (e *Executor) runExecWithStdin(ctx context.Context, containerID string, user string, workDir string, cmd []string, timeout time.Duration, stdinData []byte) (string, string, int, error) {
	stdoutBuf := &boundedWriter{limit: maxCapturedOutputBytes}
	stderrBuf := &boundedWriter{limit: maxCapturedOutputBytes}

	execOpts := docker.CreateExecOptions{
		Container:    containerID,
		User:         user,
		Cmd:          cmd,
		WorkingDir:   workDir,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		Context:      ctx,
	}
	execObj, err := e.cli.CreateExec(execOpts)
	if err != nil {
		return "", "", -1, fmt.Errorf("failed to create exec: %w", err)
	}

	childCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	startExecOptions := docker.StartExecOptions{
		InputStream:  bytes.NewReader(stdinData),
		OutputStream: stdoutBuf,
		ErrorStream:  stderrBuf,
		Context:      childCtx,
	}
	closeWaiter, err := e.cli.StartExecNonBlocking(execObj.ID, startExecOptions)
	if err != nil {
		return stdoutBuf.String(), stderrBuf.String(), -1, fmt.Errorf("failed to start exec: %w", err)
	}
	var closeOnce sync.Once
	closeExec := func() {
		closeOnce.Do(func() {
			_ = closeWaiter.Close()
		})
	}
	defer closeExec()

	done := make(chan error, 1)
	go func() {
		done <- closeWaiter.Wait()
	}()

	select {
	case err := <-done:
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) || childCtx.Err() == context.DeadlineExceeded || strings.Contains(strings.ToLower(err.Error()), "deadline exceeded") {
				return stdoutBuf.String(), stderrBuf.String(), -1, NewExecutionError(ErrTimeLimitExceeded, fmt.Sprintf("execution timed out after %v", timeout), -1)
			}
			return stdoutBuf.String(), stderrBuf.String(), -1, err
		}
	case <-childCtx.Done():
		closeExec()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			slog.Warn("exec waiter did not exit promptly after cancellation", "containerId", containerID, "cmd", cmd)
		}
		if childCtx.Err() == context.DeadlineExceeded {
			slog.Warn("exec timed out", "containerId", containerID, "timeout", timeout, "cmd", cmd)
			return stdoutBuf.String(), stderrBuf.String(), -1, NewExecutionError(ErrTimeLimitExceeded, fmt.Sprintf("execution timed out after %v", timeout), -1)
		}
		return stdoutBuf.String(), stderrBuf.String(), -1, childCtx.Err()
	case <-ctx.Done():
		closeExec()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			slog.Warn("exec waiter did not exit promptly after caller cancellation", "containerId", containerID, "cmd", cmd)
		}
		return stdoutBuf.String(), stderrBuf.String(), -1, ctx.Err()
	}

	inspect, err := e.cli.InspectExec(execObj.ID)
	if err != nil {
		return stdoutBuf.String(), stderrBuf.String(), -1, fmt.Errorf("failed to inspect exec: %w", err)
	}

	if inspect.ExitCode != 0 {
		return stdoutBuf.String(), stderrBuf.String(), inspect.ExitCode, exitError(inspect.ExitCode, stderrBuf.String())
	}

	return stdoutBuf.String(), stderrBuf.String(), inspect.ExitCode, nil
}

// RunRawWithStdin compiles (if needed) and runs raw, unwrapped source code against a
// single stdin payload, returning stdout/stderr/exit code directly — no wrapper
// generation, no test-case harness, no structural comparison. This is the primitive
// behind the GO Judge public API /raw-run endpoint: the caller (assessment-api) decides
// AC/WA itself by comparing stdout against an expected value it never sends here.
func (e *Executor) RunRawWithStdin(ctx context.Context, containerID string, files []string, hostWorkDir string, containerWorkDir string, compileCmd []string, runCmd []string, timeout time.Duration, memoryLimitMb int64, stdinData []byte) (stdout string, stderr string, compileOutput string, exitCode int, execErr error) {
	// Compilation gets its own generous, FIXED budget — matching central_runner.go's
	// compileCentralSubmission (120s), which real production submissions rely on.
	// It must NOT share the caller's short per-run `timeout`: Go builds in particular
	// (cold GOCACHE) routinely take longer than any reasonable algorithm time limit,
	// and that's expected/fine — only the student's own run should be bounded tightly.
	const rawCompileTimeout = 120 * time.Second

	submissionTimeout := rawCompileTimeout + timeout*2
	subCtx, cancel := context.WithTimeout(ctx, submissionTimeout)
	defer cancel()

	if len(files) > 0 {
		if err := e.copyFilesToContainer(subCtx, containerID, hostWorkDir, containerWorkDir, files); err != nil {
			return "", "", "", -1, err
		}
	}

	if memoryLimitMb > 0 {
		compilationLimit := memoryLimitMb
		if floor := compilationMemoryFloorMb(compileCmd); compilationLimit < floor {
			compilationLimit = floor
		}
		if err := e.UpdateContainerResources(subCtx, containerID, compilationLimit); err != nil {
			slog.Warn("failed to apply compilation memory limit", "containerId", containerID, "error", err)
		}
	}

	if len(compileCmd) > 0 {
		slog.Info("Compiling raw submission in container", "containerId", containerID, "cmd", compileCmd)
		compileStdout, compileStderr, _, err := e.runExecWithTimeout(subCtx, containerID, getJudgeUser(), containerWorkDir, rewriteCommandForWorkspace(compileCmd, containerWorkDir), rawCompileTimeout)
		if err != nil {
			combined := compileStdout
			if compileStderr != "" {
				if combined != "" {
					combined += "\n"
				}
				combined += compileStderr
			}
			return "", "", combined, -1, NewExecutionError(ErrCompilationFailed, fmt.Sprintf("%v | stdout=%s stderr=%s", err, compileStdout, compileStderr), -1)
		}
	}

	if memoryLimitMb > 0 {
		if err := e.UpdateContainerResources(subCtx, containerID, memoryLimitMb); err != nil {
			slog.Warn("failed to apply execution memory limit", "containerId", containerID, "error", err)
		}
	}

	runStdout, runStderr, runExit, runErr := e.runExecWithStdin(subCtx, containerID, getJudgeUser(), containerWorkDir, rewriteCommandForWorkspace(runCmd, containerWorkDir), timeout, stdinData)

	// Reset limit AFTER execution completes. Bounded on its own timeout for the same
	// reason as RunInContainerStream's equivalent reset — see comment there.
	if memoryLimitMb > 0 {
		resetCtx, resetCancel := context.WithTimeout(context.Background(), 10*time.Second)
		resetErr := e.UpdateContainerResources(resetCtx, containerID, 1024)
		resetCancel()
		if resetErr != nil {
			slog.Error("failed to reset memory limit", "containerId", containerID, "error", resetErr)
		}
	}

	// Clear /tmp and kill leftover processes to prevent contamination between reused containers.
	cStdout, cStderr, cExit, cErr := e.runExecWithTimeout(context.Background(), containerID, "root", "/", []string{"sh", "-c", "rm -rf /tmp/* && (pkill -9 -u judge || true)"}, 5*time.Second)
	if cErr != nil && cExit != 137 {
		slog.Error("failed to cleanup raw-run container", "containerId", containerID, "error", cErr, "stdout", cStdout, "stderr", cStderr, "exitCode", cExit)
	}

	return runStdout, runStderr, "", runExit, runErr
}
