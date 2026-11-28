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

	"judge-service-go/pkg/agentproto"
	"judge-service-go/pkg/metrics"
)

// ContainerCPUTime is the cumulative CPU time for the sandbox cgroup. With a compatible
// resident agent it asks the root keeper to read the fixed, read-only cgroup counter; otherwise
// it uses Docker's one-shot stats API. Student code cannot write the counter or the keeper's
// private protocol. The judge samples before and after tests so CPU limits do not grow when the
// host is busy.
func (e *Executor) ContainerCPUTime(ctx context.Context, containerID string) (time.Duration, error) {
	if used, cpu, err := e.containerCPUTimeFromAgent(ctx, containerID); used {
		if err == nil {
			return cpu, nil
		}
		if ctx.Err() != nil {
			return 0, ctx.Err()
		}
		slog.Warn("sandbox agent CPU counter unavailable; falling back to Docker stats", "containerId", containerID, "error", err)
	}
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
	statsStart := time.Now()
	resp, err := e.cli.HTTPClient.Do(req)
	recordSince("stats", statsStart)
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

func (e *Executor) containerCPUTimeFromAgent(ctx context.Context, containerID string) (used bool, cpu time.Duration, err error) {
	st := e.agentActive(containerID)
	if st == nil {
		return false, 0, nil
	}
	st.mu.Lock()
	if st.off || st.cpuTimeOff || st.keeper == nil || st.keeper.isDead() {
		st.mu.Unlock()
		return false, 0, nil
	}
	keeper := st.keeper
	st.mu.Unlock()

	started := time.Now()
	requestCtx, cancel := context.WithTimeout(ctx, cpuStatsTimeout)
	reply, requestErr := keeper.request(requestCtx, &agentproto.Msg{Op: agentproto.OpCPUTime})
	cancel()
	metrics.RecordStage(ctx, "agent_cpu_time", time.Since(started))
	if requestErr == nil && reply != nil && reply.Code == 0 && reply.CPUTimeNanos > 0 {
		return true, time.Duration(reply.CPUTimeNanos), nil
	}
	if requestErr == nil {
		if reply == nil {
			requestErr = errors.New("sandbox agent returned an empty CPU-time reply")
		} else {
			requestErr = fmt.Errorf("sandbox agent CPU-time reply: %s", reply.Err)
		}
	}
	if ctx.Err() != nil {
		return true, 0, ctx.Err()
	}
	if !errors.Is(requestErr, context.Canceled) {
		st.mu.Lock()
		st.cpuTimeOff = true
		st.mu.Unlock()
	}
	return true, 0, requestErr
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
