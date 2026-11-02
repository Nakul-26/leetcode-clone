package executor

import (
	"errors"
	"fmt"
	"testing"
)

func TestSandboxOOMIsAMemoryLimitThatLosesTheContainer(t *testing.T) {
	err := fmt.Errorf("execution command failed: %w", sandboxOOMError())
	if !errors.Is(err, ErrMemoryLimitExceeded) {
		t.Fatalf("%v is not a memory limit exceeded", err)
	}
	if !IsContainerLost(err) {
		t.Fatalf("%v does not report the container lost", err)
	}
	for _, other := range []error{exitError(137, ""), exitError(lostSandboxExitCode, ""), errors.New("x"), nil} {
		if IsContainerLost(other) {
			t.Fatalf("%v reports the container lost", other)
		}
	}
	if err := exitError(lostSandboxExitCode, ""); !errors.Is(err, ErrRuntimeError) {
		t.Fatalf("a plain exit 128 is %v, want a runtime error", err)
	}
}
