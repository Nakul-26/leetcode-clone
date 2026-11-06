package metrics

import (
	"sync"
	"sync/atomic"
	"time"
)

var (
	gcLastRunUnixNano int64
	gcRemovedTotal    int64
	gcRemovedExited   int64
	gcRemovedDead     int64

	reconcileLastRunUnixNano int64
	reconcileRepairsTotal    int64

	containerReplacementsTotal int64
)

func SetGCLastRun(t time.Time) {
	atomic.StoreInt64(&gcLastRunUnixNano, t.UnixNano())
}

func AddGCRemoved(total int) {
	atomic.AddInt64(&gcRemovedTotal, int64(total))
}

func AddGCRemovedExited(n int) {
	atomic.AddInt64(&gcRemovedExited, int64(n))
}

func AddGCRemovedDead(n int) {
	atomic.AddInt64(&gcRemovedDead, int64(n))
}

func SetReconcileLastRun(t time.Time) {
	atomic.StoreInt64(&reconcileLastRunUnixNano, t.UnixNano())
}

func AddReconcileRepairs(n int) {
	atomic.AddInt64(&reconcileRepairsTotal, int64(n))
}

func AddContainerReplacement(n int) {
	atomic.AddInt64(&containerReplacementsTotal, int64(n))
}

// acquireCounters is a cumulative-since-start set of counters for one language's
// ContainerPool.Acquire calls. All fields are updated via sync/atomic so RecordAcquire
// never needs to hold acquireMu on the hot path once the entry exists.
type acquireCounters struct {
	count        int64 // number of Acquire calls that returned (success or timeout)
	waitNanos    int64 // sum of wait duration across all calls
	waitedCount  int64 // calls where wait > 0 (i.e. didn't get a container immediately)
	timeoutCount int64 // calls where the context was cancelled/timed out before a container freed up
}

var (
	acquireMu     sync.Mutex
	acquireByLang = map[string]*acquireCounters{}
)

func acquireBucket(lang string) *acquireCounters {
	acquireMu.Lock()
	defer acquireMu.Unlock()
	c, ok := acquireByLang[lang]
	if !ok {
		c = &acquireCounters{}
		acquireByLang[lang] = c
	}
	return c
}

// RecordAcquire records the outcome of one ContainerPool.Acquire(ctx, lang) call. This is
// the load signal the pool autoscaler reads: rising average wait (or any timeouts) for a
// language means callers are queueing for containers faster than they're freeing up.
func RecordAcquire(lang string, wait time.Duration, timedOut bool) {
	c := acquireBucket(lang)
	atomic.AddInt64(&c.count, 1)
	atomic.AddInt64(&c.waitNanos, wait.Nanoseconds())
	if wait > 0 {
		atomic.AddInt64(&c.waitedCount, 1)
	}
	if timedOut {
		atomic.AddInt64(&c.timeoutCount, 1)
	}
}

// AcquireSnapshot is a point-in-time (cumulative since process start) read of one
// language's Acquire counters.
type AcquireSnapshot struct {
	Count        int64 `json:"count"`
	WaitNanos    int64 `json:"wait_nanos"`
	WaitedCount  int64 `json:"waited_count"`
	TimeoutCount int64 `json:"timeout_count"`
}

// AvgWaitMs returns the average Acquire wait time in milliseconds across Count calls.
// Returns 0 if Count is 0 (no calls yet — callers should treat this as "no signal", not
// "zero wait").
func (s AcquireSnapshot) AvgWaitMs() float64 {
	if s.Count == 0 {
		return 0
	}
	return float64(s.WaitNanos) / float64(s.Count) / 1e6
}

// SnapshotAcquire returns a per-language snapshot of cumulative Acquire counters. Callers
// that need a rate (e.g. the autoscaler) diff two consecutive snapshots themselves rather
// than this package tracking windows — this stays a single source of truth for the raw
// cumulative counts.
func SnapshotAcquire() map[string]AcquireSnapshot {
	acquireMu.Lock()
	langs := make([]string, 0, len(acquireByLang))
	buckets := make([]*acquireCounters, 0, len(acquireByLang))
	for lang, c := range acquireByLang {
		langs = append(langs, lang)
		buckets = append(buckets, c)
	}
	acquireMu.Unlock()

	out := make(map[string]AcquireSnapshot, len(langs))
	for i, lang := range langs {
		c := buckets[i]
		out[lang] = AcquireSnapshot{
			Count:        atomic.LoadInt64(&c.count),
			WaitNanos:    atomic.LoadInt64(&c.waitNanos),
			WaitedCount:  atomic.LoadInt64(&c.waitedCount),
			TimeoutCount: atomic.LoadInt64(&c.timeoutCount),
		}
	}
	return out
}

// Snapshot returns metrics in primitive values for JSON encoding.
func Snapshot() map[string]interface{} {
	lastGCRun := atomic.LoadInt64(&gcLastRunUnixNano)
	lastReconcileRun := atomic.LoadInt64(&reconcileLastRunUnixNano)

	var lastGCRunStr string
	if lastGCRun != 0 {
		lastGCRunStr = time.Unix(0, lastGCRun).UTC().Format(time.RFC3339)
	}
	var lastReconcileRunStr string
	if lastReconcileRun != 0 {
		lastReconcileRunStr = time.Unix(0, lastReconcileRun).UTC().Format(time.RFC3339)
	}

	dockerCalls, judged := SnapshotDockerCalls()
	return map[string]interface{}{
		"last_gc_run_unix":             lastGCRun,
		"last_gc_run":                  lastGCRunStr,
		"gc_removed_total":             atomic.LoadInt64(&gcRemovedTotal),
		"gc_removed_exited":            atomic.LoadInt64(&gcRemovedExited),
		"gc_removed_dead":              atomic.LoadInt64(&gcRemovedDead),
		"last_reconcile_run_unix":      lastReconcileRun,
		"last_reconcile_run":           lastReconcileRunStr,
		"reconcile_repairs_total":      atomic.LoadInt64(&reconcileRepairsTotal),
		"container_replacements_total": atomic.LoadInt64(&containerReplacementsTotal),
		"acquire_wait":                 SnapshotAcquire(),
		"docker_calls":                 dockerCalls,
		"judged_submissions":           judged,
	}
}

// Docker API calls made while judging (JUDGE_AGENT_PLAN Phase 0): how many of each kind and
// how long they took, cumulative since start. With JudgedSubmissions, a diff of two snapshots
// gives calls and Docker time per submission, the number the agent plan sets out to cut.
type dockerOpCounters struct {
	count int64
	nanos int64
}

var (
	dockerOpsMu       sync.Mutex
	dockerOps         = map[string]*dockerOpCounters{}
	judgedSubmissions int64
)

// RecordDockerCall records one Docker API call of the given kind ("exec_create", "stats", ...).
func RecordDockerCall(op string, d time.Duration) {
	dockerOpsMu.Lock()
	c, ok := dockerOps[op]
	if !ok {
		c = &dockerOpCounters{}
		dockerOps[op] = c
	}
	dockerOpsMu.Unlock()
	atomic.AddInt64(&c.count, 1)
	atomic.AddInt64(&c.nanos, d.Nanoseconds())
}

// RecordJudgedSubmission counts a submission that reached a container and finished.
func RecordJudgedSubmission() {
	atomic.AddInt64(&judgedSubmissions, 1)
}

// DockerCallSnapshot is one kind of Docker call, cumulative since start.
type DockerCallSnapshot struct {
	Count   int64   `json:"count"`
	TotalMs float64 `json:"total_ms"`
}

// SnapshotDockerCalls returns the Docker call counters and the judged-submission count.
func SnapshotDockerCalls() (map[string]DockerCallSnapshot, int64) {
	dockerOpsMu.Lock()
	defer dockerOpsMu.Unlock()
	out := make(map[string]DockerCallSnapshot, len(dockerOps))
	for op, c := range dockerOps {
		out[op] = DockerCallSnapshot{Count: atomic.LoadInt64(&c.count), TotalMs: float64(atomic.LoadInt64(&c.nanos)) / 1e6}
	}
	return out, atomic.LoadInt64(&judgedSubmissions)
}
