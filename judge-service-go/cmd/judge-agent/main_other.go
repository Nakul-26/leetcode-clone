//go:build !linux

// judge-agent runs inside Linux sandboxes only; this stub keeps `go build ./...` working on
// other systems.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "judge-agent runs on Linux only")
	os.Exit(2)
}
