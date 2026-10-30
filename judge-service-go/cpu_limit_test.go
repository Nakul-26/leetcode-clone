package main

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// fakeMeter reports CPU time growing at rate CPUs per second of wall time from when it was made.
type fakeMeter struct {
	mu    sync.Mutex
	start time.Time
	rate  float64
	fail  bool
	reads int
}

func newFakeMeter(rate float64) *fakeMeter { return &fakeMeter{start: time.Now(), rate: rate} }

func (m *fakeMeter) ContainerCPUTime(ctx context.Context, id string) (time.Duration, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.reads++
	if m.fail {
		return 0, errors.New("no stats")
	}
	return time.Second + time.Duration(float64(time.Since(m.start))*m.rate), nil
}

// program runs until it is cancelled, its wall timeout passes, or it finishes after d.
func program(d time.Duration) (func(ctx context.Context, wallTimeout time.Duration) error, *time.Duration) {
	var gotTimeout time.Duration
	return func(ctx context.Context, wallTimeout time.Duration) error {
		gotTimeout = wallTimeout
		select {
		case <-time.After(d):
			return nil
		case <-time.After(wallTimeout):
			return errors.New("timed out")
		case <-ctx.Done():
			return ctx.Err()
		}
	}, &gotTimeout
}

func TestCPULimitStopsABusyProgramAtTheLimit(t *testing.T) {
	limit := 100 * time.Millisecond
	run, _ := program(time.Hour)
	res, err := runWithCPULimit(context.Background(), newFakeMeter(1), "c", limit, run)
	if !res.Exceeded || !errors.Is(err, context.Canceled) {
		t.Fatalf("want exceeded and cancelled, got %+v err=%v", res, err)
	}
	if res.Wall > 2*limit {
		t.Errorf("busy program stopped after %v, want about the limit (%v)", res.Wall, limit)
	}
}

func TestCPULimitDoesNotFailAStarvedProgram(t *testing.T) {
	// 250 ms of wall time but only ~75 ms of CPU: the server was busy, not the program.
	limit := 100 * time.Millisecond
	run, _ := program(250 * time.Millisecond)
	res, err := runWithCPULimit(context.Background(), newFakeMeter(0.3), "c", limit, run)
	if err != nil || res.Exceeded || !res.Measured {
		t.Fatalf("want a pass, got %+v err=%v", res, err)
	}
	if res.CPU > limit || res.TimeMs() != res.CPU.Milliseconds() {
		t.Errorf("reported %d ms for %v of CPU", res.TimeMs(), res.CPU)
	}
}

func TestCPULimitCapsAnIdleProgramOnWallTime(t *testing.T) {
	limit := 50 * time.Millisecond
	run, gotTimeout := program(time.Hour)
	res, err := runWithCPULimit(context.Background(), newFakeMeter(0), "c", limit, run)
	if *gotTimeout != wallCapFactor*limit {
		t.Errorf("wall timeout %v, want %v", *gotTimeout, wallCapFactor*limit)
	}
	if err == nil || res.Exceeded {
		t.Fatalf("want the run's own timeout error, got %+v err=%v", res, err)
	}
}

func TestCPULimitIsNeverStricterThanWallClock(t *testing.T) {
	// Two CPUs' worth of usage, finishing inside the limit on wall time.
	limit := 100 * time.Millisecond
	run, _ := program(70 * time.Millisecond)
	res, err := runWithCPULimit(context.Background(), newFakeMeter(2), "c", limit, run)
	if err != nil || res.Exceeded {
		t.Fatalf("want a pass, got %+v err=%v", res, err)
	}
}

func TestCPULimitFallsBackToWallClock(t *testing.T) {
	limit := 80 * time.Millisecond
	m := newFakeMeter(1)
	m.fail = true
	run, gotTimeout := program(10 * time.Millisecond)
	res, err := runWithCPULimit(context.Background(), m, "c", limit, run)
	if err != nil || res.Measured || res.Exceeded {
		t.Fatalf("want an unmeasured pass, got %+v err=%v", res, err)
	}
	if *gotTimeout != limit {
		t.Errorf("fallback wall timeout %v, want the limit %v", *gotTimeout, limit)
	}
	if m.reads != 1 {
		t.Errorf("fallback read the meter %d times, want 1", m.reads)
	}
}

func TestCPULimitQuickProgramReadsTwice(t *testing.T) {
	m := newFakeMeter(1)
	run, _ := program(5 * time.Millisecond)
	if _, err := runWithCPULimit(context.Background(), m, "c", time.Second, run); err != nil {
		t.Fatal(err)
	}
	if m.reads != 2 {
		t.Errorf("a test well inside its limit read the meter %d times, want 2 (before and after)", m.reads)
	}
}
