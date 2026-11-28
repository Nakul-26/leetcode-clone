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
	// memoryMb remembers the last memory limit set on each container (container ID ->
	// int64), so a run that asks for the limit the container already has skips the
	// `docker update` call. A run used to make up to three (set, compile limit, reset to
	// 1024), usually with the same value, at 30-50 ms each. Entries for removed containers
	// stay (the pool removes them with its own client); one small entry per container
	// ever created is negligible, and IDs are never reused.
	memoryMb sync.Map

	// Merged execs (JUDGE_MERGED_EXECS, JUDGE_AGENT_PLAN Phase 1), per container ID:
	// wipePending: the last reset killed everything but left the wipe to the next use's first
	// judge-user exec (see beginPrep). staleLimit: the last reset left a submission's memory
	// limit in place; the next use restores the default unless it sets a limit of its own.
	// broken: a deferred wipe or upload failed, so the container must not be reused.
	wipePending sync.Map
	staleLimit  sync.Map
	broken      sync.Map

	// The sandbox agent (agent.go): per container ID its *agentState, and per stand-in exec
	// ID the *agentExec it runs.
	agents     sync.Map
	agentExecs sync.Map

	// The compile cache (compile_cache.go), nil when off, and each container's image ID.
	cc       *compileCache
	imageIDs sync.Map

	// ext compiles some programs outside the sandbox (external_compiler.go); nil when off.
	ext ExternalCompiler
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
	total int // everything written, kept or not
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	w.total += len(p)
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
	return &Executor{cli: cli, cc: newCompileCacheFromEnv()}, nil
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
	// This use chose its own limit, so the previous use's need not be restored.
	e.staleLimit.Delete(containerID)

	if current, ok := e.memoryMb.Load(containerID); ok && current.(int64) == memoryMb {
		return nil
	}

	memoryBytes := memoryMb * 1024 * 1024
	slog.Info("Updating container resource limits", "containerId", containerID, "memoryMb", memoryMb)

	opts := docker.UpdateContainerOptions{
		Context:    ctx,
		Memory:     int(memoryBytes),
		MemorySwap: int(memoryBytes),
	}
	if err := e.updateContainer(containerID, opts); err != nil {
		// Unknown now: the next call must really update.
		e.memoryMb.Delete(containerID)
		return fmt.Errorf("failed to update container memory limit: %w", err)
	}
	e.memoryMb.Store(containerID, memoryMb)
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

// The reset returns a pooled container to a clean state between submissions, in two steps.
//
// containerKillScript (as root) kills every process the submission left running, first, so
// nothing can recreate files after they are removed. It then checks that no judge-user process
// survived, and exits non-zero if one did or if pkill is missing.
//
// containerWipeScript (as the judge user) then empties /app and /tmp completely, hidden entries
// included: submission directories (world-readable, so leaving them let a later submission read
// earlier students' code, and memory-backed, so they ate into the memory limit) and everything
// the submission wrote. It runs as the judge user, not root, because pooled containers drop every
// capability: root there cannot open or remove a directory the submission made unreadable
// (chmod 000), so a root wipe silently left such files for the next submission. Everything in
// /app and /tmp belongs to the judge user (uploads run as it too), and an owner can always make
// its own files removable again. The Go build cache in /tmp/.cache goes too: the next submission
// would trust its entries, so one submission could plant compiled code into the next one's
// program (JUDGE_FIX_PLAN S1). The image's warm-up hook then seeds a clean copy again (~0.1 s,
// Go only). The wipe exits non-zero if anything is left.
//
// A non-zero exit from either makes the caller discard the container instead of reusing it
// dirty. Because the reset is what makes reuse safe, a TLE, MLE or crash no longer discards the
// container (JUDGE_FIX_PLAN T2).
const containerKillCmds = `command -v pkill >/dev/null || { echo "pkill missing"; exit 1; }; ` +
	`pkill -9 -u judge; ` +
	`i=0; while pgrep -u judge >/dev/null && [ $i -lt 40 ]; do sleep 0.05; i=$((i+1)); done; ` +
	`if pgrep -u judge >/dev/null; then echo "judge processes survived the reset"; exit 1; fi`

const containerKillScript = containerKillCmds + `; exit 0`

// containerWipeCmds is the wipe without its final exit, so beginPrep can run it ahead of a
// command. It exits 1 if anything is left. The hook's stdin is /dev/null because in a merged
// exec stdin carries the upload or the program's input.
const containerWipeCmds = `cd /; ` +
	`find /app /tmp -mindepth 1 -maxdepth 1 -exec chmod -R u+rwx {} + 2>/dev/null; ` +
	`find /app /tmp -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null; ` +
	`left=$(find /app /tmp -mindepth 1 2>&1 | head -n 5); ` +
	`if [ -n "$left" ]; then echo "not removed by the reset: $left"; exit 1; fi; ` +
	// The same hook the pool runs when it creates a container (pool.warmupHookPath).
	`if [ -x /usr/local/bin/judge-warmup ]; then /usr/local/bin/judge-warmup </dev/null; fi`

const containerWipeScript = containerWipeCmds + `; exit 0`

// containerUsageScript runs after containerKillScript in merged mode and prints how much the
// submission left in /app and /tmp (KB, then inodes), which decides whether the wipe can wait.
// statfs needs no read access to the files, so root without capabilities can run it.
const containerUsageScript = `echo judge-df-k; df -P -k /app /tmp; echo judge-df-i; df -P -i /app /tmp`

// A deferred wipe runs inside the next submission's first exec, under that submission's memory
// limit and partly on its clock (it is counted in its first test's CPU time). It is deferred
// only when there is little to remove; anything bigger is wiped at release as before, so one
// submission can neither OOM the next one's start nor make it slow by leaving many files.
const (
	deferWipeMaxKB     = 8 * 1024
	deferWipeMaxInodes = 512
)

// defaultMemoryMb is the limit a container is reset to between submissions.
const defaultMemoryMb = 1024

// MergedExecsEnabled reports JUDGE_MERGED_EXECS=true (JUDGE_AGENT_PLAN Phase 1): the upload
// shares an exec with the compile or run that follows it, and the reset's wipe moves to the
// next submission's first exec. Read on each call so tests can switch it.
func MergedExecsEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("JUDGE_MERGED_EXECS")))
	return v == "true" || v == "1"
}

// ResetContainer cleans a container after a submission and restores its default memory limit,
// before it goes back to the pool. Once per submission, so per-test steps can skip both.
// An error means the container could not be trusted clean; the caller should discard it.
//
// In merged mode the kill still runs here, so nothing of the submission keeps running, but a
// small wipe is left to the next use (beginPrep), and so is the memory limit: the next use
// usually sets its own, often the same one, which then costs no `docker update`.
func (e *Executor) ResetContainer(ctx context.Context, containerID string) error {
	if reason, ok := e.broken.LoadAndDelete(containerID); ok {
		e.forget(containerID)
		return fmt.Errorf("container reset failed: %v", reason)
	}
	if MergedExecsEnabled() {
		return e.resetDeferred(ctx, containerID)
	}
	// Restore the limit first: after an MLE the container is still at the problem's limit with
	// the student's process holding memory, and the reset shell itself could be OOM-killed.
	if err := e.UpdateContainerResources(ctx, containerID, defaultMemoryMb); err != nil {
		return err
	}
	var stdout, stderr string
	var exitCode int
	handled, err := e.killJudge(ctx, containerID)
	if !handled {
		stdout, stderr, exitCode, err = e.runExecWithTimeout(ctx, containerID, "root", "/", []string{"sh", "-c", containerKillScript}, 10*time.Second)
	}
	if err == nil {
		err = e.checkRunner(ctx, containerID)
	}
	if err == nil {
		stdout, stderr, exitCode, err = e.runExecWithTimeout(ctx, containerID, getJudgeUser(), "/", []string{"sh", "-c", containerWipeScript}, 10*time.Second)
	}
	if err != nil {
		return fmt.Errorf("container reset failed: %w (exit=%d stdout=%s stderr=%s)", err, exitCode, stdout, stderr)
	}
	return nil
}

// resetDeferred is ResetContainer in merged mode. The kill runs under the submission's own
// limit: the OOM killer frees memory by killing the student's processes, and if what is left
// (files in memory-backed /tmp) still starves the kill, it fails and the container is discarded.
func (e *Executor) resetDeferred(ctx context.Context, containerID string) error {
	var stdout, stderr string
	var exitCode int
	handled, err := e.killJudge(ctx, containerID)
	switch {
	case !handled:
		stdout, stderr, exitCode, err = e.runExecWithTimeout(ctx, containerID, "root", "/", []string{"sh", "-c", containerKillCmds + "; " + containerUsageScript + "; exit 0"}, 10*time.Second)
	case err == nil:
		// The keeper killed everything but the runner; the usage check is a root command too.
		if err = e.checkRunner(ctx, containerID); err == nil {
			stdout, stderr, exitCode, err = e.runExecWithTimeout(ctx, containerID, "root", "/", []string{"sh", "-c", containerUsageScript + "; exit 0"}, 10*time.Second)
		}
	}
	if err != nil {
		e.forget(containerID)
		return fmt.Errorf("container reset failed: %w (exit=%d stdout=%s stderr=%s)", err, exitCode, stdout, stderr)
	}
	if kb, inodes, ok := parseUsage(stdout); ok && kb <= deferWipeMaxKB && inodes <= deferWipeMaxInodes {
		if current, known := e.memoryMb.Load(containerID); known && current.(int64) != defaultMemoryMb {
			e.staleLimit.Store(containerID, struct{}{})
		}
		e.wipePending.Store(containerID, struct{}{})
		return nil
	}
	// Too much to leave for the next submission (or usage unreadable): wipe now, as before.
	e.wipePending.Delete(containerID)
	if err := e.UpdateContainerResources(ctx, containerID, defaultMemoryMb); err != nil {
		e.forget(containerID)
		return err
	}
	stdout, stderr, exitCode, err = e.runExecWithTimeout(ctx, containerID, getJudgeUser(), "/", []string{"sh", "-c", containerWipeScript}, 10*time.Second)
	if err != nil {
		e.forget(containerID)
		return fmt.Errorf("container reset failed: %w (exit=%d stdout=%s stderr=%s)", err, exitCode, stdout, stderr)
	}
	return nil
}

// forget drops the merged-mode state of a container that is being discarded.
func (e *Executor) forget(containerID string) {
	e.wipePending.Delete(containerID)
	e.staleLimit.Delete(containerID)
}

// parseUsage reads containerUsageScript's output: the used KB and inodes of /app and /tmp
// summed. ok is false if either table is missing or unreadable.
func parseUsage(out string) (kb int64, inodes int64, ok bool) {
	var section string
	var sawK, sawI bool
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch line {
		case "judge-df-k", "judge-df-i":
			section = line
			continue
		}
		fields := strings.Fields(line)
		if section == "" || len(fields) < 6 || fields[0] == "Filesystem" {
			continue
		}
		var used int64
		if _, err := fmt.Sscanf(fields[2], "%d", &used); err != nil {
			return 0, 0, false
		}
		if section == "judge-df-k" {
			kb += used
			sawK = true
		} else {
			inodes += used
			sawI = true
		}
	}
	return kb, inodes, sawK && sawI
}

// runExecWithTimeout handles the full lifecycle of creating, running, and waiting for an exec instance.
func (e *Executor) runExecWithTimeout(ctx context.Context, containerID string, user string, workDir string, cmd []string, timeout time.Duration) (string, string, int, error) {
	return e.runExecWithUpload(ctx, containerID, user, workDir, cmd, timeout, nil)
}

// runExecWithUpload is runExecWithTimeout that, in merged mode, first extracts upload (a
// workspace tar, or nil) into workDir in the same exec (see beginPrep).
func (e *Executor) runExecWithUpload(ctx context.Context, containerID string, user string, workDir string, cmd []string, timeout time.Duration, upload []byte) (stdout string, stderr string, exitCode int, err error) {
	p, cmd, workDir, err := e.beginPrep(ctx, containerID, user, workDir, cmd, upload)
	if err != nil {
		return "", "", -1, err
	}
	defer func() { err = e.endPrep(containerID, p, err) }()

	stdoutBuf := &boundedWriter{limit: maxCapturedOutputBytes}
	stderrBuf := &boundedWriter{limit: maxCapturedOutputBytes}

	execOpts := docker.CreateExecOptions{
		Container:    containerID,
		User:         user,
		Cmd:          cmd,
		WorkingDir:   workDir,
		AttachStdin:  upload != nil && p != nil,
		AttachStdout: true,
		AttachStderr: true,
		Context:      ctx,
	}
	execObj, err := e.createExec(execOpts)
	if err != nil {
		return "", "", -1, fmt.Errorf("failed to create exec: %w", err)
	}

	// Use a child context with timeout so it cancels the StartExec if needed.
	childCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	startExecOptions := docker.StartExecOptions{
		OutputStream: stdoutBuf,
		ErrorStream:  p.stderr(stderrBuf),
		Context:      childCtx,
	}
	if execOpts.AttachStdin {
		startExecOptions.InputStream = bytes.NewReader(upload)
	}
	closeWaiter, err := e.startExec(execObj.ID, startExecOptions)
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
	inspect, err := e.inspectExec(execObj.ID)
	if err != nil {
		return stdoutBuf.String(), stderrBuf.String(), -1, fmt.Errorf("failed to inspect exec: %w", err)
	}

	if inspect.ExitCode != 0 {
		return stdoutBuf.String(), stderrBuf.String(), inspect.ExitCode, e.execExitError(containerID, inspect.ExitCode, stderrBuf.String())
	}

	return stdoutBuf.String(), stderrBuf.String(), inspect.ExitCode, nil
}

// runExecWithStdinTimeout is runExecWithTimeout's sibling for stdin-mode
// execution: it attaches stdin and streams stdinInput into the process
// instead of passing input as a CLI argument. Kept as a separate function
// (rather than adding a stdin parameter to runExecWithTimeout) so the
// function-mode path — covered by the existing test suite — is provably
// untouched.
func (e *Executor) runExecWithStdinTimeout(ctx context.Context, containerID string, user string, workDir string, cmd []string, stdinInput string, timeout time.Duration) (stdout string, stderr string, exitCode int, err error) {
	p, cmd, workDir, err := e.beginPrep(ctx, containerID, user, workDir, cmd, nil)
	if err != nil {
		return "", "", -1, err
	}
	defer func() { err = e.endPrep(containerID, p, err) }()

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
	execObj, err := e.createExec(execOpts)
	if err != nil {
		return "", "", -1, fmt.Errorf("failed to create exec: %w", err)
	}

	childCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	startExecOptions := docker.StartExecOptions{
		InputStream:  strings.NewReader(stdinInput),
		OutputStream: stdoutBuf,
		ErrorStream:  p.stderr(stderrBuf),
		Context:      childCtx,
	}
	closeWaiter, err := e.startExec(execObj.ID, startExecOptions)
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

	inspect, err := e.inspectExec(execObj.ID)
	if err != nil {
		return stdoutBuf.String(), stderrBuf.String(), -1, fmt.Errorf("failed to inspect exec: %w", err)
	}

	if inspect.ExitCode != 0 {
		return stdoutBuf.String(), stderrBuf.String(), inspect.ExitCode, e.execExitError(containerID, inspect.ExitCode, stderrBuf.String())
	}

	return stdoutBuf.String(), stderrBuf.String(), inspect.ExitCode, nil
}

func (e *Executor) copyFilesToContainer(ctx context.Context, containerID string, hostWorkDir string, containerWorkDir string, files []string) error {
	if len(files) == 0 {
		return nil
	}
	tarData, err := buildWorkspaceTar(hostWorkDir, files)
	if err != nil {
		return err
	}
	return e.uploadTar(ctx, containerID, containerWorkDir, tarData)
}

// uploadTar extracts a workspace tar into containerWorkDir as the judge user.
func (e *Executor) uploadTar(ctx context.Context, containerID string, containerWorkDir string, tarData []byte) error {
	if MergedExecsEnabled() {
		// An exec of its own still, but it also runs any wipe the last reset left pending.
		if _, stderr, _, err := e.runExecWithUpload(ctx, containerID, getJudgeUser(), containerWorkDir, []string{"true"}, 20*time.Second, tarData); err != nil {
			return fmt.Errorf("failed to extract files into container: %w (stderr=%s)", err, stderr)
		}
		return nil
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
	// Extracted as the judge user (see getJudgeUser), which compiles and runs the code, so
	// the workspace is its own: the reset wipes /app as that user and must be able to
	// remove everything in it (see containerWipeScript). /app is world-writable and
	// sticky (pool.go), so the user can create the directory. chmod -R 0777 keeps the
	// world-writable workspace the host-side staging dir also uses. prepScript extracts
	// the same way in merged mode.
	extractCmd := []string{"sh", "-c", `mkdir -p "$1" && tar -xf - -C "$1" && chmod -R 0777 "$1"`, "sh", containerWorkDir}
	if _, stderr, _, err := e.runExecWithStdin(ctx, containerID, getJudgeUser(), "/", extractCmd, 20*time.Second, tarData); err != nil {
		return fmt.Errorf("failed to extract files into container: %w (stderr=%s)", err, stderr)
	}
	return nil
}

// stageUpload prepares files for upload. In merged mode it returns the tar for the next exec
// to extract (beginPrep); otherwise it uploads them now, in an exec of their own, and returns nil.
func (e *Executor) stageUpload(ctx context.Context, containerID string, hostWorkDir string, containerWorkDir string, files []string) ([]byte, error) {
	if len(files) == 0 {
		return nil, nil
	}
	if !MergedExecsEnabled() {
		return nil, e.copyFilesToContainer(ctx, containerID, hostWorkDir, containerWorkDir, files)
	}
	return buildWorkspaceTar(hostWorkDir, files)
}

// buildWorkspaceTar packs files from a submission's host workspace for upload.
func buildWorkspaceTar(hostWorkDir string, files []string) ([]byte, error) {
	if err := workspace.ValidateNoExternalSymlinks(hostWorkDir); err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, name := range files {
		path, err := workspace.SafeJoin(hostWorkDir, name)
		if err != nil {
			_ = tw.Close()
			return nil, fmt.Errorf("invalid workspace path %s: %w", name, err)
		}
		data, info, err := workspace.ReadRegularFile(hostWorkDir, name)
		if err != nil {
			_ = tw.Close()
			return nil, fmt.Errorf("failed to read %s: %w", path, err)
		}
		hdr := &tar.Header{
			Name:    name,
			Mode:    int64(info.Mode().Perm()),
			Size:    int64(len(data)),
			ModTime: info.ModTime(),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			_ = tw.Close()
			return nil, fmt.Errorf("failed to write tar header for %s: %w", name, err)
		}
		if _, err := tw.Write(data); err != nil {
			_ = tw.Close()
			return nil, fmt.Errorf("failed to write tar data for %s: %w", name, err)
		}
	}
	if err := tw.Close(); err != nil {
		return nil, fmt.Errorf("failed to close tar writer: %w", err)
	}

	return buf.Bytes(), nil
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

// upload is a workspace tar to extract into workDir first, in merged mode (see beginPrep).
func (e *Executor) runExecStreamWithTimeout(ctx context.Context, containerID string, user string, workDir string, cmd []string, timeout time.Duration, upload []byte) (*ExecStream, error) {
	p, cmd, workDir, err := e.beginPrep(ctx, containerID, user, workDir, cmd, upload)
	if err != nil {
		return nil, err
	}
	execOpts := docker.CreateExecOptions{
		Container:    containerID,
		User:         user,
		Cmd:          cmd,
		WorkingDir:   workDir,
		AttachStdin:  upload != nil && p != nil,
		AttachStdout: true,
		AttachStderr: true,
		Context:      ctx,
	}
	execObj, err := e.createExec(execOpts)
	if err != nil {
		return nil, e.endPrep(containerID, p, fmt.Errorf("failed to create exec: %w", err))
	}

	childCtx, cancel := context.WithTimeout(ctx, timeout)
	stdoutReader, stdoutWriter := io.Pipe()
	stderrReader, stderrWriter := io.Pipe()

	startExecOptions := docker.StartExecOptions{
		OutputStream: stdoutWriter,
		ErrorStream:  p.stderr(stderrWriter),
		Context:      childCtx,
	}
	if execOpts.AttachStdin {
		startExecOptions.InputStream = bytes.NewReader(upload)
	}
	closeWaiter, err := e.startExec(execObj.ID, startExecOptions)
	if err != nil {
		cancel()
		_ = stdoutWriter.Close()
		_ = stderrWriter.Close()
		_ = stdoutReader.Close()
		_ = stderrReader.Close()
		return nil, e.endPrep(containerID, p, fmt.Errorf("failed to start exec: %w", err))
	}

	stream := &ExecStream{
		Stdout: stdoutReader,
		Stderr: stderrReader,
		waitCh: make(chan execWaitResult, 1),
	}

	send := func(r execWaitResult) {
		r.err = e.endPrep(containerID, p, r.err)
		stream.waitCh <- r
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
				send(waitResult)
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
			send(waitResult)
			return
		case <-ctx.Done():
			closeExec()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				slog.Warn("exec waiter did not exit promptly after caller cancellation", "containerId", containerID, "cmd", cmd)
			}
			waitResult.err = ctx.Err()
			send(waitResult)
			return
		}

		inspect, err := e.inspectExec(execObj.ID)
		if err != nil {
			waitResult.err = fmt.Errorf("failed to inspect exec: %w", err)
			send(waitResult)
			return
		}

		waitResult.exitCode = inspect.ExitCode
		if inspect.ExitCode != 0 {
			// stderr is still being read here; collectStream re-checks a runtime error once it is.
			waitResult.err = e.execExitError(containerID, inspect.ExitCode, "")
		}
		send(waitResult)
	}()

	return stream, nil
}

// execExitError classifies a non-zero exec exit (see exitError). An exit of
// lostSandboxExitCode from a container that has since stopped OOM-killed is a memory limit
// exceeded that took the container with it.
func (e *Executor) execExitError(containerID string, exitCode int, stderr string) error {
	if exitCode == lostSandboxExitCode {
		// The exec can end a moment before Docker records the container as stopped.
		for i := 0; i < 5; i++ {
			c, err := e.cli.InspectContainerWithOptions(docker.InspectContainerOptions{ID: containerID})
			if err != nil || c.HostConfig == nil || c.HostConfig.Runtime != "runsc" {
				break // under runc an exit of 128 is the student's own
			}
			if !c.State.Running {
				if c.State.OOMKilled {
					return sandboxOOMError()
				}
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	return exitError(exitCode, stderr)
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

	if memoryLimitMb > 0 && !MergedExecsEnabled() { // merged: left to the reset at release
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

	// Compiled outside the sandbox (pkg/compilesvc): the sources and what it produced go in.
	if handled, outFiles, output, err := e.compileExternally(subCtx, compileCmd, hostWorkDir, files); handled {
		if err != nil {
			return "", output, err
		}
		if err := e.copyFilesToContainer(subCtx, containerID, hostWorkDir, containerWorkDir, append(append([]string(nil), files...), outFiles...)); err != nil {
			return "", "", err
		}
		return "", output, nil
	}

	// The same code compiled before with the same compiler: its files instead (compile_cache.go).
	cacheKey, cacheable := e.compileKey(containerID, hostWorkDir, files, compileCmd)
	if cacheable && e.restoreCompiled(subCtx, containerID, containerWorkDir, cacheKey) {
		return "", "", nil
	}
	compileStart := time.Now()

	upload, err := e.stageUpload(subCtx, containerID, hostWorkDir, containerWorkDir, files)
	if err != nil {
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

	compileStdout, compileStderr, _, err := e.runExecWithUpload(subCtx, containerID, getJudgeUser(), containerWorkDir, rewriteCommandForWorkspace(compileCmd, containerWorkDir), timeout, upload)
	if err != nil {
		if IsContainerLost(err) {
			return compileStdout, compileStderr, err
		}
		return compileStdout, compileStderr, NewExecutionError(ErrCompilationFailed, err.Error(), -1)
	}
	if cacheable {
		e.keepCompiled(subCtx, containerID, containerWorkDir, cacheKey, time.Since(compileStart))
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
	if handled, err := e.killJudge(context.Background(), containerID); handled {
		if err != nil {
			slog.Error("failed to kill leftover processes", "containerId", containerID, "error", err)
		}
		return
	}
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

	// In merged mode the upload goes with the compile, or with the run when there is none.
	upload, err := e.stageUpload(subCtx, containerID, hostWorkDir, containerWorkDir, files)
	if err != nil {
		cancel()
		return nil, err
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
		compileStdout, compileStderr, _, err := e.runExecWithUpload(subCtx, containerID, getJudgeUser(), containerWorkDir, rewriteCommandForWorkspace(compileCmd, containerWorkDir), timeout, upload)
		upload = nil
		if err != nil {
			cancel()
			if IsContainerLost(err) {
				return nil, err
			}
			return nil, NewExecutionError(ErrCompilationFailed, fmt.Sprintf("%v | stdout=%s stderr=%s", err, compileStdout, compileStderr), -1)
		}
	}

	// Apply strict memory limit BEFORE execution
	if memoryLimitMb > 0 {
		if err := e.UpdateContainerResources(subCtx, containerID, memoryLimitMb); err != nil {
			slog.Warn("failed to apply execution memory limit", "containerId", containerID, "error", err)
		}
	}

	stream, err := e.runExecStreamWithTimeout(subCtx, containerID, getJudgeUser(), containerWorkDir, rewriteCommandForWorkspace(runCmd, containerWorkDir), timeout, upload)
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
		// In merged mode the reset at release handles it (resetDeferred), often for free.
		if memoryLimitMb > 0 && !MergedExecsEnabled() {
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
func (e *Executor) runExecWithStdin(ctx context.Context, containerID string, user string, workDir string, cmd []string, timeout time.Duration, stdinData []byte) (stdout string, stderr string, exitCode int, err error) {
	p, cmd, workDir, err := e.beginPrep(ctx, containerID, user, workDir, cmd, nil)
	if err != nil {
		return "", "", -1, err
	}
	defer func() { err = e.endPrep(containerID, p, err) }()

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
	execObj, err := e.createExec(execOpts)
	if err != nil {
		return "", "", -1, fmt.Errorf("failed to create exec: %w", err)
	}

	childCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	startExecOptions := docker.StartExecOptions{
		InputStream:  bytes.NewReader(stdinData),
		OutputStream: stdoutBuf,
		ErrorStream:  p.stderr(stderrBuf),
		Context:      childCtx,
	}
	closeWaiter, err := e.startExec(execObj.ID, startExecOptions)
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

	inspect, err := e.inspectExec(execObj.ID)
	if err != nil {
		return stdoutBuf.String(), stderrBuf.String(), -1, fmt.Errorf("failed to inspect exec: %w", err)
	}

	if inspect.ExitCode != 0 {
		return stdoutBuf.String(), stderrBuf.String(), inspect.ExitCode, e.execExitError(containerID, inspect.ExitCode, stderrBuf.String())
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

	// Compiled outside the sandbox (pkg/compilesvc): upload sources and output, no compile here.
	cacheable := false
	cacheKey := ""
	if handled, outFiles, output, err := e.compileExternally(subCtx, compileCmd, hostWorkDir, files); handled {
		if err != nil {
			return "", "", output, -1, err
		}
		files = append(append([]string(nil), files...), outFiles...)
		compileCmd = nil
	} else {
		// The same code compiled before with the same compiler: its files, and no compile.
		cacheKey, cacheable = e.compileKey(containerID, hostWorkDir, files, compileCmd)
		if cacheable && e.restoreCompiled(subCtx, containerID, containerWorkDir, cacheKey) {
			compileCmd = nil
			files = nil
		}
	}

	// The run takes the program's stdin, so in merged mode the upload goes with the compile
	// only; without one it is an exec of its own.
	var upload []byte
	if len(compileCmd) > 0 {
		var err error
		if upload, err = e.stageUpload(subCtx, containerID, hostWorkDir, containerWorkDir, files); err != nil {
			return "", "", "", -1, err
		}
	} else if err := e.copyFilesToContainer(subCtx, containerID, hostWorkDir, containerWorkDir, files); err != nil {
		return "", "", "", -1, err
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
		compileStart := time.Now()
		compileStdout, compileStderr, _, err := e.runExecWithUpload(subCtx, containerID, getJudgeUser(), containerWorkDir, rewriteCommandForWorkspace(compileCmd, containerWorkDir), rawCompileTimeout, upload)
		if err == nil && cacheable {
			e.keepCompiled(subCtx, containerID, containerWorkDir, cacheKey, time.Since(compileStart))
		}
		if IsContainerLost(err) {
			return "", "", "", -1, err
		}
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
	if memoryLimitMb > 0 && !MergedExecsEnabled() { // merged: left to the reset at release
		resetCtx, resetCancel := context.WithTimeout(context.Background(), 10*time.Second)
		resetErr := e.UpdateContainerResources(resetCtx, containerID, 1024)
		resetCancel()
		if resetErr != nil {
			slog.Error("failed to reset memory limit", "containerId", containerID, "error", resetErr)
		}
	}

	// Clear /tmp and kill leftover processes to prevent contamination between reused containers.
	cleanup := "rm -rf /tmp/* && (pkill -9 -u judge || true)"
	if handled, err := e.killJudge(context.Background(), containerID); handled {
		if err != nil {
			slog.Error("failed to kill raw-run leftovers", "containerId", containerID, "error", err)
		}
		cleanup = "rm -rf /tmp/* || true" // with the agent, the keeper did the kill
	}
	cStdout, cStderr, cExit, cErr := e.runExecWithTimeout(context.Background(), containerID, "root", "/", []string{"sh", "-c", cleanup}, 5*time.Second)
	if cErr != nil && cExit != 137 {
		slog.Error("failed to cleanup raw-run container", "containerId", containerID, "error", cErr, "stdout", cStdout, "stderr", cStderr, "exitCode", cExit)
	}

	return runStdout, runStderr, "", runExit, runErr
}
