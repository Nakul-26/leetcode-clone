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
