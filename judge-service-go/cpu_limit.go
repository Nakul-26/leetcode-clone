package main

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"
)

// Time limits on CPU time (JUDGE_FIX_PLAN F5). A wall-clock limit around docker exec also
// counts exec overhead and time the program spent waiting for a CPU, so the same
// submission could pass when the server is quiet and get Time Limit Exceeded when it is
// busy. The judge now reads the container's CPU usage before and after each test and
// judges the limit on the difference; wall-clock time only caps a test that is not using
// CPU (sleeping, blocked, or starved) at wallCapFactor times the limit.
//
// A test is over the limit only when both its CPU time and its wall time exceed it, so no
// verdict is stricter than with the old wall-clock limit (pool containers have one CPU,
// so CPU time cannot outrun wall time anyway).

const (
	wallCapFactor = 3
	// Shortest gap between two CPU readings while a test is near its limit.
	cpuPollMin = 20 * time.Millisecond
	// Gap between retries when a reading fails mid-test (the wall cap still applies).
	cpuPollRetry = 100 * time.Millisecond
)

type cpuTimeReader interface {
	ContainerCPUTime(ctx context.Context, containerID string) (time.Duration, error)
}

type cpuLimitedRun struct {
	Measured bool          // false: CPU time could not be read; the wall-clock limit applied
	CPU      time.Duration // CPU time the test used, when Measured
	Wall     time.Duration
	Exceeded bool // over the limit on CPU time (only set when Measured)
}

// TimeMs is the time to report for the test: CPU time when it was measured.
func (r cpuLimitedRun) TimeMs() int64 {
	if r.Measured {
		return r.CPU.Milliseconds()
	}
	return r.Wall.Milliseconds()
}

var cpuReadFailureLogged atomic.Bool

// runWithCPULimit runs one test under a CPU-time limit. run starts the test with the
// context and wall-clock timeout it is given and returns the executor's error. Once the
// test has run for limit of wall time, a watchdog reads the container's CPU usage and
// cancels the run's context as soon as the test has used limit of CPU; the caller then
// reports Time Limit Exceeded when Exceeded is set, whatever error run returned.
//
// If the CPU usage cannot be read when the test starts, the test runs exactly as before
// the change: a wall-clock limit of limit.
func runWithCPULimit(ctx context.Context, meter cpuTimeReader, containerID string, limit time.Duration, run func(ctx context.Context, wallTimeout time.Duration) error) (cpuLimitedRun, error) {
	start := time.Now()
	before, err := meter.ContainerCPUTime(ctx, containerID)
	if err != nil {
		if !cpuReadFailureLogged.Swap(true) {
			slog.Warn("cannot read container CPU time; time limits fall back to wall-clock", "containerId", containerID, "error", err)
		}
		runErr := run(ctx, limit)
		return cpuLimitedRun{Wall: time.Since(start)}, runErr
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var exceeded atomic.Bool
	stop := make(chan struct{})
	watchdogDone := make(chan struct{})
	go func() {
		defer close(watchdogDone)
		timer := time.NewTimer(limit)
		defer timer.Stop()
		for {
			select {
			case <-stop:
				return
			case <-runCtx.Done():
				return
			case <-timer.C:
			}
			now, err := meter.ContainerCPUTime(runCtx, containerID)
			if err != nil {
				timer.Reset(cpuPollRetry)
				continue
			}
			used := now - before
			if used >= limit {
				exceeded.Store(true)
				cancel()
				return
			}
			// CPU time cannot grow faster than wall time on one CPU, so nothing can
			// cross the limit before the remaining CPU budget has passed.
			wait := limit - used
			if wait < cpuPollMin {
				wait = cpuPollMin
			}
			timer.Reset(wait)
		}
	}()

	runErr := run(runCtx, limit*wallCapFactor)
	wall := time.Since(start)
	close(stop)
	<-watchdogDone

	res := cpuLimitedRun{Wall: wall, Exceeded: exceeded.Load()}
	after, err := meter.ContainerCPUTime(ctx, containerID)
	if err != nil {
		// Judge on wall-clock time for this test.
		res.Exceeded = res.Exceeded || wall > limit
		return res, runErr
	}
	res.Measured = true
	res.CPU = after - before
	if res.CPU > limit && wall > limit {
		res.Exceeded = true
	}
	return res, runErr
}
