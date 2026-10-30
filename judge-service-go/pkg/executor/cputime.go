package executor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sync/atomic"
	"time"
)

// ContainerCPUTime is the CPU time used so far by every process in the container (its
// cgroup's usage counter), read through the Docker stats API (JUDGE_FIX_PLAN F5). The
// judge reads it before and after a test to judge the time limit on CPU time, which,
// unlike wall-clock time, does not grow when the server is busy.
//
// It is read from outside the sandbox, so a submission cannot forge it. It uses one-shot
// mode (Docker API 1.41+): without it the daemon waits about a second for a second sample.
// go-dockerclient's Stats has no one-shot option, so the request is made directly over the
// client's own HTTP transport.
func (e *Executor) ContainerCPUTime(ctx context.Context, containerID string) (time.Duration, error) {
	if cpuStatsDisabled.Load() {
		return 0, errCPUStatsDisabled
	}
	base, err := e.apiBaseURL()
	if err != nil {
		return 0, err
	}
	started := time.Now()
	defer func() { noteCPUStatsLatency(time.Since(started)) }()
	ctx, cancel := context.WithTimeout(ctx, cpuStatsTimeout)
	defer cancel()
	reqURL := base + "/containers/" + url.PathEscape(containerID) + "/stats?stream=false&one-shot=true"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return 0, err
	}
	resp, err := e.cli.HTTPClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("container stats: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("container stats: HTTP %d", resp.StatusCode)
	}
	var stats struct {
		CPUStats struct {
			CPUUsage struct {
				TotalUsage uint64 `json:"total_usage"`
			} `json:"cpu_usage"`
		} `json:"cpu_stats"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&stats); err != nil {
		return 0, fmt.Errorf("container stats: %w", err)
	}
	if stats.CPUStats.CPUUsage.TotalUsage == 0 {
		// A running container always has some usage; zero means the daemon did not
		// report it (for example a cgroup layout it cannot read).
		return 0, fmt.Errorf("container stats: no CPU usage reported")
	}
	return time.Duration(stats.CPUStats.CPUUsage.TotalUsage), nil
}

// A one-shot read takes a few milliseconds. A daemon older than API 1.41 ignores one-shot
// and takes about a second per read, which would add seconds to every test, so after a few
// slow reads in a row CPU-time reading is switched off for the life of the process and time
// limits fall back to wall-clock.
const (
	cpuStatsTimeout      = 2 * time.Second
	cpuStatsSlow         = 500 * time.Millisecond
	cpuStatsSlowToGiveUp = 3
)

var (
	errCPUStatsDisabled = errors.New("container CPU time reading is disabled (stats API too slow)")
	cpuStatsDisabled    atomic.Bool
	cpuStatsSlowInARow  atomic.Int32
)

func noteCPUStatsLatency(d time.Duration) {
	if d < cpuStatsSlow {
		cpuStatsSlowInARow.Store(0)
		return
	}
	if cpuStatsSlowInARow.Add(1) >= cpuStatsSlowToGiveUp && !cpuStatsDisabled.Swap(true) {
		slog.Warn("container stats API is slow (one-shot unsupported?); time limits fall back to wall-clock", "latency", d)
	}
}

// apiBaseURL is the HTTP base URL for the client's endpoint. A unix socket gets a
// placeholder host, as go-dockerclient does itself: its transport dials the socket.
func (e *Executor) apiBaseURL() (string, error) {
	u, err := url.Parse(e.cli.Endpoint())
	if err != nil {
		return "", fmt.Errorf("docker endpoint: %w", err)
	}
	switch u.Scheme {
	case "tcp":
		if e.cli.TLSConfig != nil {
			return "https://" + u.Host, nil
		}
		return "http://" + u.Host, nil
	case "http", "https":
		return u.Scheme + "://" + u.Host, nil
	case "unix":
		return "http://unix.sock", nil
	default:
		return "", fmt.Errorf("docker endpoint scheme %q not supported for stats", u.Scheme)
	}
}
