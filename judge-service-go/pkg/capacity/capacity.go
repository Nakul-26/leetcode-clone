// Package capacity adjusts how many submissions a judge runs at once to the CPU the host has
// free (JUDGE_ADAPTIVE_CONCURRENCY).
//
// Fixed limits (JUDGE_INTERACTIVE_WORKERS, JUDGE_POOL_MAX_<LANG>) are a guess made for one
// moment: too low and a quiet server queues work with cores idle (C++ load test, 2026-11-27:
// deploy2 30% idle at its limits), too high and a busy one runs more programs than it has
// cores, so each takes longer in wall-clock time and can hit wall-clock limits it would not
// hit alone. The host is shared, too (deploy2 runs the production stack and other apps), so the
// right number changes by the minute.
//
// Every Interval the controller reads the host's CPU use (/proc/stat is the host's inside a
// container) and whether submissions are waiting, and moves one limit:
//
//   - up by one while work is waiting and CPU is below UpBelow (85%);
//   - down by one when CPU has been above DownAbove (95%) for two readings in a row, whoever
//     is using it;
//   - back down to Min, one step a minute, once nothing has waited for IdleDecay.
//
// It never goes below Min (the configured settings) or above Max. The judge uses the limit as
// its number of interactive workers and as a ceiling each language's sandbox pool may grow to.
package capacity

import (
	"bufio"
	"context"
	"errors"
	"log/slog"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Config bounds and paces the controller.
type Config struct {
	Min, Max  int
	Interval  time.Duration
	UpBelow   float64 // grow only while host CPU busy fraction is below this
	DownAbove float64 // shrink when it is above this for two readings
	IdleDecay time.Duration
}

// Enabled reports JUDGE_ADAPTIVE_CONCURRENCY=true.
func Enabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("JUDGE_ADAPTIVE_CONCURRENCY")))
	return v == "true" || v == "1"
}

// ConfigFromEnv builds the config. min is the configured concurrency (JUDGE_INTERACTIVE_WORKERS);
// JUDGE_CONCURRENCY_MAX defaults to 1.5x the host's cores.
func ConfigFromEnv(min int) Config {
	if min < 1 {
		min = 1
	}
	max := envInt("JUDGE_CONCURRENCY_MAX", runtime.NumCPU()*3/2)
	if max < min {
		max = min
	}
	return Config{
		Min:       min,
		Max:       max,
		Interval:  2 * time.Second,
		UpBelow:   envFloat("JUDGE_CPU_UP_BELOW", 0.85),
		DownAbove: envFloat("JUDGE_CPU_DOWN_ABOVE", 0.95),
		IdleDecay: time.Minute,
	}
}

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && v > 0 {
		return v
	}
	return def
}

func envFloat(name string, def float64) float64 {
	if v, err := strconv.ParseFloat(strings.TrimSpace(os.Getenv(name)), 64); err == nil && v > 0 && v <= 1 {
		return v
	}
	return def
}

// State is what the decision carries from one reading to the next.
type State struct {
	Limit      int
	HighStreak int       // consecutive readings above DownAbove
	LastDemand time.Time // last reading with work waiting
	LastChange time.Time
}

// Decide is the controller's policy, without clocks or I/O so it can be tested.
func Decide(cfg Config, st State, cpu float64, demand bool, now time.Time) State {
	if st.Limit < cfg.Min {
		st.Limit = cfg.Min
	}
	if st.Limit > cfg.Max {
		st.Limit = cfg.Max
	}
	if demand {
		st.LastDemand = now
	}
	if cpu > cfg.DownAbove {
		st.HighStreak++
		if st.HighStreak >= 2 && st.Limit > cfg.Min {
			st.Limit--
			st.HighStreak = 0
			st.LastChange = now
		}
		return st
	}
	st.HighStreak = 0
	switch {
	case demand && cpu < cfg.UpBelow && st.Limit < cfg.Max:
		st.Limit++
		st.LastChange = now
	case !demand && st.Limit > cfg.Min && now.Sub(st.LastDemand) >= cfg.IdleDecay && now.Sub(st.LastChange) >= time.Minute:
		st.Limit--
		st.LastChange = now
	}
	return st
}

// Controller runs Decide on a timer and reports each new limit.
type Controller struct {
	cfg      Config
	limit    atomic.Int64
	demand   func() bool
	onChange func(limit int)
	statPath string
}

// New makes a controller starting at cfg.Min. demand reports whether work waited since the last
// call; onChange is called (from the controller's goroutine) with every new limit.
func New(cfg Config, demand func() bool, onChange func(int)) *Controller {
	c := &Controller{cfg: cfg, demand: demand, onChange: onChange, statPath: "/proc/stat"}
	c.limit.Store(int64(cfg.Min))
	return c
}

// Limit is the current limit.
func (c *Controller) Limit() int { return int(c.limit.Load()) }

// Run reads and decides until ctx ends. If the host's CPU cannot be read it keeps the
// configured limit.
func (c *Controller) Run(ctx context.Context) {
	prevBusy, prevTotal, err := readCPU(c.statPath)
	if err != nil {
		slog.Warn("adaptive concurrency off: cannot read host CPU", "error", err)
		return
	}
	st := State{Limit: c.cfg.Min, LastDemand: time.Now(), LastChange: time.Now()}
	slog.Info("adaptive concurrency on", "min", c.cfg.Min, "max", c.cfg.Max, "upBelow", c.cfg.UpBelow, "downAbove", c.cfg.DownAbove)
	ticker := time.NewTicker(c.cfg.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			busy, total, err := readCPU(c.statPath)
			if err != nil || total <= prevTotal {
				continue
			}
			cpu := float64(busy-prevBusy) / float64(total-prevTotal)
			prevBusy, prevTotal = busy, total
			before := st.Limit
			st = Decide(c.cfg, st, cpu, c.demand(), now)
			if st.Limit != before {
				c.limit.Store(int64(st.Limit))
				slog.Info("adaptive concurrency", "limit", st.Limit, "was", before, "hostCpu", int(cpu*100))
				c.onChange(st.Limit)
			}
		}
	}
}

// readCPU returns the host's busy and total CPU time (jiffies) from the first line of
// /proc/stat. Idle includes iowait; guest time is already inside user and nice.
func readCPU(path string) (busy, total uint64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	if !s.Scan() {
		return 0, 0, errors.New("empty /proc/stat")
	}
	fields := strings.Fields(s.Text())
	if len(fields) < 8 || fields[0] != "cpu" {
		return 0, 0, errors.New("unexpected /proc/stat format")
	}
	var v [8]uint64
	for i := 0; i < 8 && i+1 < len(fields); i++ {
		v[i], _ = strconv.ParseUint(fields[i+1], 10, 64)
	}
	// user nice system idle iowait irq softirq steal
	idle := v[3] + v[4]
	for _, x := range v {
		total += x
	}
	return total - idle, total, nil
}
