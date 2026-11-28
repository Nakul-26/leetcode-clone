//go:build linux

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// cgroupCPUTimeNanos returns the usage of this sandbox's private cgroup. The path is fixed and
// read-only in the sandbox; no path or process identifier comes from the request or submission.
func cgroupCPUTimeNanos() (int64, error) {
	return cgroupCPUTimeNanosFrom("/sys/fs/cgroup")
}

func cgroupCPUTimeNanosFrom(root string) (int64, error) {
	b, err := os.ReadFile(filepath.Join(root, "cpu.stat"))
	if err != nil {
		return 0, fmt.Errorf("read cgroup cpu.stat: %w", err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || fields[0] != "usage_usec" {
			continue
		}
		usec, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil || usec > uint64(1<<63-1)/1000 {
			return 0, fmt.Errorf("invalid cgroup usage_usec %q", fields[1])
		}
		return int64(usec * 1000), nil
	}
	return 0, fmt.Errorf("cgroup cpu.stat has no usage_usec counter")
}
