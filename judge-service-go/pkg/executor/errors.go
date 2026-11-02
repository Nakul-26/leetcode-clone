package executor

import (
	"errors"
	"fmt"
	"strings"
)

var (
	ErrCompilationFailed   = errors.New("compilation failed")
	ErrTimeLimitExceeded   = errors.New("time limit exceeded")
	ErrMemoryLimitExceeded = errors.New("memory limit exceeded")
	ErrRuntimeError        = errors.New("runtime error")
	ErrContainerUnhealthy  = errors.New("container unhealthy")
)

// ExecutionError wraps an error with additional context like exit code.
type ExecutionError struct {
	Type     error
	Message  string
	ExitCode int
	// ContainerLost: the container stopped with the process (see sandboxOOMError), so
	// nothing more can run in it.
	ContainerLost bool
}

func (e *ExecutionError) Error() string {
	if e.Message != "" {
		return fmt.Sprintf("%v: %s", e.Type, e.Message)
	}
	if e.ExitCode != 0 {
		return fmt.Sprintf("%v (exit code %d)", e.Type, e.ExitCode)
	}
	return e.Type.Error()
}

func (e *ExecutionError) Unwrap() error {
	return e.Type
}

func NewExecutionError(errType error, message string, exitCode int) *ExecutionError {
	return &ExecutionError{
		Type:     errType,
		Message:  message,
		ExitCode: exitCode,
	}
}

// IsContainerLost reports an error after which the container is no longer running.
func IsContainerLost(err error) bool {
	var execErr *ExecutionError
	return errors.As(err, &execErr) && execErr.ContainerLost
}

// lostSandboxExitCode is what an exec reports when the sandbox around it went away. Under
// gVisor (runsc, JUDGE_FIX_PLAN S3) the memory cgroup covers the whole sandbox, so an OOM
// kills the sandbox, not just the student's process: the exec ends 128 ("WaitPID failed:
// EOF") instead of runc's 137, and the container stops with OOMKilled set.
const lostSandboxExitCode = 128

func sandboxOOMError() error {
	return &ExecutionError{Type: ErrMemoryLimitExceeded, Message: "sandbox killed at the memory limit", ExitCode: lostSandboxExitCode, ContainerLost: true}
}

// exitError classifies a non-zero exit of the submitted program. 137 is a SIGKILL, which in
// the sandbox means the cgroup OOM killer. A JVM exits 1 with java.lang.OutOfMemoryError
// instead, because its heap is sized below the cgroup limit (JUDGE_FIX_PLAN F3/F4), and
// that is the same verdict. Anything else is the program's own runtime error.
func exitError(exitCode int, stderr string) error {
	if exitCode == 137 {
		return NewExecutionError(ErrMemoryLimitExceeded, "process killed (possibly OOM)", exitCode)
	}
	if strings.Contains(stderr, "java.lang.OutOfMemoryError") {
		return NewExecutionError(ErrMemoryLimitExceeded, "java.lang.OutOfMemoryError", exitCode)
	}
	return NewExecutionError(ErrRuntimeError, fmt.Sprintf("exit code %d", exitCode), exitCode)
}
