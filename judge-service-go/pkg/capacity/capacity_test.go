package capacity

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

var cfg = Config{Min: 10, Max: 18, UpBelow: 0.85, DownAbove: 0.95, IdleDecay: time.Minute}

func step(st State, cpu float64, demand bool, at time.Time) State {
	return Decide(cfg, st, cpu, demand, at)
}

func TestGrowsWhileWorkWaitsAndCPUIsFree(t *testing.T) {
	now := time.Now()
	st := State{Limit: 10, LastDemand: now, LastChange: now}
	for i := 1; i <= 20; i++ {
		st = step(st, 0.6, true, now.Add(time.Duration(i)*2*time.Second))
	}
	if st.Limit != 18 {
		t.Fatalf("limit %d, want the max 18", st.Limit)
	}
}

func TestDoesNotGrowWithoutWaitingWork(t *testing.T) {
	now := time.Now()
	st := State{Limit: 10, LastDemand: now, LastChange: now}
	st = step(st, 0.2, false, now.Add(2*time.Second))
	if st.Limit != 10 {
		t.Fatalf("limit %d, want 10", st.Limit)
	}
}

func TestDoesNotGrowNearFullCPU(t *testing.T) {
	now := time.Now()
	st := State{Limit: 12, LastDemand: now, LastChange: now}
	st = step(st, 0.9, true, now.Add(2*time.Second))
	if st.Limit != 12 {
		t.Fatalf("limit %d at 90%% CPU, want it held at 12", st.Limit)
	}
}

func TestShrinksAfterTwoHighReadings(t *testing.T) {
	now := time.Now()
	st := State{Limit: 15, LastDemand: now, LastChange: now}
	st = step(st, 0.97, true, now.Add(2*time.Second))
	if st.Limit != 15 {
		t.Fatalf("one high reading changed the limit to %d", st.Limit)
	}
	st = step(st, 0.98, true, now.Add(4*time.Second))
	if st.Limit != 14 {
		t.Fatalf("limit %d after two high readings, want 14", st.Limit)
	}
	// A reading in between resets the streak.
	st = step(st, 0.97, true, now.Add(6*time.Second))
	st = step(st, 0.90, true, now.Add(8*time.Second))
	st = step(st, 0.97, true, now.Add(10*time.Second))
	if st.Limit != 14 {
		t.Fatalf("limit %d, want 14 (the streak was broken)", st.Limit)
	}
}

func TestNeverBelowMinOrAboveMax(t *testing.T) {
	now := time.Now()
	st := State{Limit: 10, LastDemand: now, LastChange: now}
	for i := 1; i <= 10; i++ {
		st = step(st, 1.0, true, now.Add(time.Duration(i)*2*time.Second))
	}
	if st.Limit != 10 {
		t.Fatalf("limit %d, want the min 10", st.Limit)
	}
	st = Decide(cfg, State{Limit: 40}, 0.1, true, now)
	if st.Limit != 18 {
		t.Fatalf("limit %d, want clamped to 18", st.Limit)
	}
}

func TestDecaysToMinWhenIdle(t *testing.T) {
	now := time.Now()
	st := State{Limit: 14, LastDemand: now, LastChange: now}
	st = step(st, 0.1, false, now.Add(30*time.Second))
	if st.Limit != 14 {
		t.Fatalf("decayed after 30 s idle: %d", st.Limit)
	}
	at := now.Add(61 * time.Second)
	st = step(st, 0.1, false, at)
	if st.Limit != 13 {
		t.Fatalf("limit %d after a minute idle, want 13", st.Limit)
	}
	// One step a minute.
	st = step(st, 0.1, false, at.Add(2*time.Second))
	if st.Limit != 13 {
		t.Fatalf("decayed twice within a minute: %d", st.Limit)
	}
}

func TestReadCPU(t *testing.T) {
	p := filepath.Join(t.TempDir(), "stat")
	_ = os.WriteFile(p, []byte("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3\n"), 0o644)
	busy, total, err := readCPU(p)
	if err != nil || busy != 150 || total != 1000 {
		t.Fatalf("busy %d total %d err %v, want 150 1000", busy, total, err)
	}
	_ = os.WriteFile(p, []byte("intr 1 2\n"), 0o644)
	if _, _, err := readCPU(p); err == nil {
		t.Fatal("expected an error for a file without a cpu line")
	}
}

func TestConfigFromEnv(t *testing.T) {
	t.Setenv("JUDGE_CONCURRENCY_MAX", "6")
	c := ConfigFromEnv(10)
	if c.Min != 10 || c.Max != 10 {
		t.Fatalf("max below min should become min: %+v", c)
	}
	t.Setenv("JUDGE_CONCURRENCY_MAX", "")
	t.Setenv("JUDGE_CPU_UP_BELOW", "1.5") // out of range: default
	c = ConfigFromEnv(4)
	if c.UpBelow != 0.85 || c.Max < 4 {
		t.Fatalf("%+v", c)
	}
}
