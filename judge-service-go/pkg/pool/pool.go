package pool

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	docker "github.com/fsouza/go-dockerclient"

	"judge-service-go/pkg/metrics"
	"judge-service-go/pkg/workspace"
)

// PooledContainer represents a container in the pool.
type PooledContainer struct {
	ID             string
	Language       string
	Busy           bool
	WorkDir        string
	ExecutionCount int32

	// Recycling (see CountExecution). limit is this container's own run limit, set at its
	// first run; the fields below it are guarded by the pool's mu.
	limit          int32
	successorState successorState
	successor      *PooledContainer
	retired        bool
}

// successorState tracks the container prepared to take a retiring container's place.
type successorState int

const (
	successorNone    successorState = iota
	successorPending                // being created
	successorReady                  // created, held in ContainerPool.standby
	successorFailed                 // creation failed: Discard replaces the usual way
)

// LangLimits is one language's configured pool bounds. target (tracked separately on
// ContainerPool, not here) is always kept within [Min, Max] — Min containers exist
// unconditionally from WarmUp onward; anything above Min is what the autoscaler grows/shrinks.
type LangLimits struct {
	Min int
	Max int
}

// ContainerPool manages a pool of pre-warmed Docker containers, per language.
type ContainerPool struct {
	cli        *docker.Client
	mu         sync.Mutex
	availChans map[string]chan *PooledContainer // language -> idle containers
	inUse      map[string]*PooledContainer      // containerID -> container
	limits     map[string]LangLimits            // language -> configured min/max
	targets    map[string]int                   // language -> current scaling target (min <= target <= max)
	globalCap  int                              // max containers across ALL languages combined
	// ceiling lets a language's pool grow past its configured max, up to this many containers
	// (pkg/capacity, JUDGE_ADAPTIVE_CONCURRENCY). 0 = none. The global cap still applies.
	ceiling  atomic.Int64
	images   map[string]string           // language -> image name
	claims   map[string]int              // language -> bulk workers holding or waiting for one of its containers
	iclaims  map[string]int              // language -> interactive workers holding or waiting for one of its containers
	runtime  string                      // OCI runtime for new containers; "" is the daemon default (runc)
	maxExecs int32                       // runs before a container is replaced; 0 = never (SetMaxExecutions)
	standby  map[string]*PooledContainer // successors created ahead of their container's retirement
}

// NewPool creates a new container pool. globalCap bounds the total container count summed
// across every language — it exists because all languages ultimately share the same host CPU
// budget, so no single language's Max should be trusted in isolation (see StartAutoscaler).
func NewPool(cli *docker.Client, globalCap int) *ContainerPool {
	return &ContainerPool{
		cli:        cli,
		availChans: make(map[string]chan *PooledContainer),
		inUse:      make(map[string]*PooledContainer),
		limits:     make(map[string]LangLimits),
		targets:    make(map[string]int),
		globalCap:  globalCap,
		images:     make(map[string]string),
		claims:     make(map[string]int),
		iclaims:    make(map[string]int),
		standby:    make(map[string]*PooledContainer),
	}
}

// SetMaxExecutions sets how many runs a container does before it is replaced
// (MAX_EXECUTIONS_PER_CONTAINER). 0 or less never replaces a container for its run count.
func (p *ContainerPool) SetMaxExecutions(n int) {
	if n < 0 {
		n = 0
	}
	atomic.StoreInt32(&p.maxExecs, int32(n))
}

// Recycling without a gap. A container is replaced after its run limit, to bound drift. The
// replacement used to be created only once the last run had finished: a few seconds on an idle
// host, far longer under load. And since a language's containers are created together and used
// in turn, they all reached the limit within a few runs of each other, leaving the language with
// almost no containers while every replacement queued for Docker at once (gaps of up to ~40 s
// were seen). Now:
//   - each container gets its own limit between 90% and 100% of the setting, so they retire at
//     different times;
//   - successorAhead runs before its limit, the container's successor is created in the
//     background and held ready; when the container retires, the successor takes its place in
//     the pool at once;
//   - a replacement that fails to start is retried within seconds, not at the reconciler's next
//     run a minute later.

// successorAhead is how many runs before its limit a container's successor is prepared: 10% of
// the limit (at 90 of 100), at least one.
func successorAhead(limit int32) int32 {
	if a := limit / 10; a > 1 {
		return a
	}
	return 1
}

// jitteredLimit is a container's own run limit: max minus up to 10%.
func jitteredLimit(max int32) int32 {
	spread := max / 10
	if spread <= 0 {
		return max
	}
	return max - rand.Int31n(spread+1)
}

// CountExecution records one run on c and reports whether c has reached its limit, in which case
// the caller discards it once the run is done. Close to the limit it starts preparing c's
// successor. Call it once per run, after acquiring c.
func (p *ContainerPool) CountExecution(c *PooledContainer) (count int32, retire bool) {
	count = atomic.AddInt32(&c.ExecutionCount, 1)
	max := atomic.LoadInt32(&p.maxExecs)
	if max <= 0 {
		return count, false
	}
	limit := atomic.LoadInt32(&c.limit)
	if limit == 0 {
		atomic.CompareAndSwapInt32(&c.limit, 0, jitteredLimit(max))
		limit = atomic.LoadInt32(&c.limit)
	}
	if count >= limit-successorAhead(limit) {
		p.prepareSuccessor(c)
	}
	return count, count >= limit
}

// prepareSuccessor creates c's successor in the background, once.
func (p *ContainerPool) prepareSuccessor(c *PooledContainer) {
	p.mu.Lock()
	if c.successorState != successorNone || c.retired {
		p.mu.Unlock()
		return
	}
	c.successorState = successorPending
	image := p.images[c.Language]
	p.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		succ, err := p.newPooledContainer(ctx, image, c.Language)
		p.mu.Lock()
		defer p.mu.Unlock()
		if err != nil {
			slog.Warn("Could not prepare a container's successor; it will be replaced when it retires",
				"containerId", c.ID, "language", c.Language, "error", err)
			c.successorState = successorFailed
			if c.retired {
				// Discard saw it pending and left the replacement to us.
				go p.replaceDiscarded(image, c, p.availChans[c.Language])
			}
			return
		}
		if c.retired {
			// c retired while its successor was being created: the successor goes in now.
			c.successorState = successorNone
			p.pushLocked(succ, c.ID)
			return
		}
		c.successor = succ
		c.successorState = successorReady
		p.standby[succ.ID] = succ
	}()
}

// retireLocked marks c retired outside Discard (health check, scale-down) and hands back its
// prepared successor, if one is ready, for the caller to use or remove. Call with p.mu held.
func (p *ContainerPool) retireLocked(c *PooledContainer) *PooledContainer {
	c.retired = true
	if c.successorState != successorReady {
		return nil
	}
	succ := c.successor
	c.successor, c.successorState = nil, successorNone
	delete(p.standby, succ.ID)
	return succ
}

// pushLocked adds a new container to its language's idle channel. Call with p.mu held.
func (p *ContainerPool) pushLocked(c *PooledContainer, replacing string) {
	ch, ok := p.availChans[c.Language]
	if !ok {
		go p.removeContainer(c)
		return
	}
	select {
	case ch <- c:
		metrics.AddContainerReplacement(1)
		slog.Info("Replaced container", "oldId", replacing, "newId", c.ID, "language", c.Language)
	default:
		slog.Warn("Container pool channel full during replacement", "language", c.Language)
		go p.removeContainer(c)
	}
}

// SandboxRuntimes are the OCI runtimes SetRuntime accepts (and docker-guard allows): ""/"runc"
// is the daemon default, "runsc" is gVisor, which puts a user-space kernel between submissions
// and the host kernel (JUDGE_FIX_PLAN S3). runsc must be registered with the Docker daemon.
var SandboxRuntimes = []string{"", "runc", "runsc"}

func (p *ContainerPool) sandboxRuntime() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.runtime
}

// SetRuntime picks the OCI runtime for containers created from now on. Call it before WarmUp.
func (p *ContainerPool) SetRuntime(runtime string) error {
	for _, r := range SandboxRuntimes {
		if r == runtime {
			p.mu.Lock()
			p.runtime = runtime
			p.mu.Unlock()
			return nil
		}
	}
	return fmt.Errorf("sandbox runtime %q is not supported (want runc or runsc)", runtime)
}

// interactiveWaiters is how many interactive requests of one language may wait for a container
// beyond the containers it has.
const interactiveWaiters = 2

// TryClaimInteractive is TryClaim for the interactive workers. They are few and shared by all
// languages, and a worker waiting for a container holds its request until one is free, so
// without a limit a burst of a slow language (C++, Java) occupied most of them while Python,
// with idle containers, queued behind it: in a mixed load test Python fell from 4,728 to
// 835/min and its median wait went from 0.6 to 2.8 s (2026-11-27). A language may hold as many
// interactive requests as it has containers, plus interactiveWaiters waiting; a refused request
// goes back on the queue for a moment (the caller defers it) and the worker takes other work.
func (p *ContainerPool) TryClaimInteractive(lang string) (release func(), ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, served := p.limits[lang]; !served {
		return func() {}, true
	}
	if p.iclaims == nil {
		p.iclaims = make(map[string]int)
	}
	if p.iclaims[lang] >= p.targets[lang]+interactiveWaiters {
		return nil, false
	}
	p.iclaims[lang]++
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			p.iclaims[lang]--
			p.mu.Unlock()
		})
	}, true
}

// claimsPerContainer is how many bulk workers one language may tie up per container it
// currently has: one running a submission, one waiting to take the container next.
const claimsPerContainer = 2

// TryClaim admits one bulk worker to wait for (and then hold) a container of lang, or refuses
// when that language already has claimsPerContainer workers per container. Without it every
// worker could end up blocked on one language's burst while messages for idle languages sat
// unread behind it (JUDGE_FIX_PLAN T4). A refused caller should put the message back on the
// queue and take other work. The returned func gives the claim back; call it once the
// container has been released. A language the pool does not serve is always admitted (the
// acquire that follows fails as before).
func (p *ContainerPool) TryClaim(lang string) (release func(), ok bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, served := p.limits[lang]; !served {
		return func() {}, true
	}
	limit := claimsPerContainer * p.targets[lang]
	if limit < claimsPerContainer {
		limit = claimsPerContainer
	}
	if p.claims[lang] >= limit {
		return nil, false
	}
	if p.claims == nil {
		p.claims = make(map[string]int)
	}
	p.claims[lang]++
	var once sync.Once
	return func() {
		once.Do(func() {
			p.mu.Lock()
			p.claims[lang]--
			p.mu.Unlock()
		})
	}, true
}

// Acquire gets a container from the pool for the given language.
// It blocks until a container is available or the context is cancelled.
//
// Every call is recorded to metrics.RecordAcquire (wait duration, and whether it timed out
// rather than succeeding) — this is the load signal StartAutoscaler reads to decide whether a
// language needs more containers. Recording happens on both exit paths, including the
// ctx.Done() case, since a caller timing out waiting for a container is itself a stronger
// signal than an elevated-but-successful wait.
func (p *ContainerPool) Acquire(ctx context.Context, lang string) *PooledContainer {
	start := time.Now()

	p.mu.Lock()
	ch, ok := p.availChans[lang]
	p.mu.Unlock()

	if !ok {
		return nil
	}

	select {
	case container := <-ch:
		metrics.RecordAcquire(lang, time.Since(start), false)
		p.mu.Lock()
		container.Busy = true
		p.inUse[container.ID] = container
		p.mu.Unlock()
		return container
	case <-ctx.Done():
		metrics.RecordAcquire(lang, time.Since(start), true)
		return nil
	}
}

// AcquireBulk is Acquire for work that may wait: it will not take the last `reserve`
// idle containers of a language, leaving them for latency-sensitive callers.
//
// Acquire alone cannot provide that. It is a plain channel receive, and Go wakes blocked
// receivers in FIFO order, so an interactive request that arrives behind a backlog of
// bulk work queues behind every bulk waiter for a container, however it was prioritised
// on the message queue. Holding some containers back is what makes priority real.
//
// The reserve is capped below the language's Max so a one-container pool still runs bulk
// work rather than starving it forever.
func (p *ContainerPool) AcquireBulk(ctx context.Context, lang string, reserve int) *PooledContainer {
	start := time.Now()

	p.mu.Lock()
	ch, ok := p.availChans[lang]
	limits := p.limits[lang]
	p.mu.Unlock()
	if !ok {
		return nil
	}
	if reserve > limits.Max-1 {
		reserve = limits.Max - 1
	}
	if reserve < 0 {
		reserve = 0
	}

	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if len(ch) > reserve {
			select {
			case container := <-ch:
				metrics.RecordAcquire(lang, time.Since(start), false)
				p.mu.Lock()
				container.Busy = true
				p.inUse[container.ID] = container
				p.mu.Unlock()
				return container
			default:
			}
		}
		select {
		case <-ctx.Done():
			metrics.RecordAcquire(lang, time.Since(start), true)
			return nil
		case <-ticker.C:
		}
	}
}

// Release returns a container to the pool.
func (p *ContainerPool) Release(container *PooledContainer) {
	if container == nil {
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if _, ok := p.inUse[container.ID]; !ok {
		return
	}
	container.Busy = false
	delete(p.inUse, container.ID)

	ch, ok := p.availChans[container.Language]
	if !ok {
		// Should not happen if pool is managed correctly
		slog.Error("Releasing container for unknown language", "language", container.Language)
		p.removeContainer(container)
		return
	}

	select {
	case ch <- container:
		// success
	default:
		// Channel full? Should never happen — WarmUp sizes the channel to the
		// language's configured Max, and target/inUse+avail never exceed Max.
		slog.Warn("Container pool channel full during release", "language", container.Language)
		p.removeContainer(container)
	}
}

// Discard removes a suspect container from the pool and creates a replacement in the
// background. Creating the replacement used to block the calling worker (for a container
// create + start, a second or more for big images) before it could take more work; the result
// was already saved, so only throughput suffered. The reconciler still tops the pool up if a
// background replacement fails.
func (p *ContainerPool) Discard(ctx context.Context, container *PooledContainer, reason string) {
	if container == nil {
		return
	}

	p.mu.Lock()
	if _, wasInUse := p.inUse[container.ID]; !wasInUse {
		p.mu.Unlock()
		slog.Warn("Ignoring discard for container that is not in use", "containerId", container.ID, "language", container.Language, "reason", reason)
		return
	}
	delete(p.inUse, container.ID)
	image := p.images[container.Language]
	ch := p.availChans[container.Language]
	container.retired = true
	replace := true
	switch container.successorState {
	case successorReady:
		// Its successor is already running: it takes the container's place before the
		// container is even removed.
		succ := container.successor
		container.successor = nil
		delete(p.standby, succ.ID)
		p.pushLocked(succ, container.ID)
		replace = false
	case successorPending:
		replace = false // prepareSuccessor puts it in (or replaces) when it finishes
	}
	p.mu.Unlock()

	slog.Warn("Discarding pooled container", "containerId", container.ID, "language", container.Language, "reason", reason)
	p.removeContainer(container)

	if !replace {
		return
	}
	if image == "" {
		slog.Error("Cannot replace discarded container; image is unknown", "language", container.Language)
		return
	}

	go p.replaceDiscarded(image, container, ch)
}

// replaceAttempts is how many times replaceDiscarded tries to create a replacement.
const replaceAttempts = 3

// replaceDiscarded creates and pools a replacement for a discarded container. It runs on its
// own context because the discarding caller's context ends as soon as Discard returns.
func (p *ContainerPool) replaceDiscarded(image string, old *PooledContainer, ch chan *PooledContainer) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var replacement *PooledContainer
	var err error
	// A failed create is retried within seconds: otherwise the language stays a container short
	// until the reconciler's next run, up to a minute later.
	for attempt, wait := 1, time.Second; ; attempt, wait = attempt+1, wait*2 {
		replacement, err = p.newPooledContainer(ctx, image, old.Language)
		if err == nil || attempt == replaceAttempts || ctx.Err() != nil {
			break
		}
		slog.Warn("Failed to replace discarded container; retrying", "language", old.Language, "attempt", attempt, "error", err)
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
	}
	if err != nil {
		slog.Error("Failed to replace discarded container", "language", old.Language, "error", err)
		return
	}
	metrics.AddContainerReplacement(1)

	if ch != nil {
		select {
		case ch <- replacement:
			slog.Info("Replaced discarded container", "oldId", old.ID, "newId", replacement.ID, "language", old.Language)
		default:
			slog.Warn("Container pool channel full during discard/replacement", "language", old.Language)
			p.removeContainer(replacement)
		}
	}
}

// WarmUp creates the initial (min) set of containers for a given language, and records that
// language's [min, max] bounds for the reconciler/autoscaler to converge against later.
//
// The channel is sized to max, not min: capacity is set once here and never resized, so
// sizing it to the initial container count would mean any later scale-up past that count
// silently fails (the reconciler's create-missing branch would push onto an already-full
// channel and immediately destroy what it just created — see StartReconciler). Channel
// capacity itself is free; only the containers filling it cost real resources, and only `min`
// of those are actually created here.
func (p *ContainerPool) WarmUp(ctx context.Context, lang string, image string, min, max int) error {
	p.mu.Lock()
	p.images[lang] = image
	if p.availChans[lang] == nil {
		// Room up to the global cap, not just max: with a ceiling (SetCeiling) a language may
		// grow past its max, and a full channel would destroy each container made past it.
		size := max
		if p.globalCap > size {
			size = p.globalCap
		}
		p.availChans[lang] = make(chan *PooledContainer, size)
	}
	p.limits[lang] = LangLimits{Min: min, Max: max}
	p.targets[lang] = min
	ch := p.availChans[lang]
	p.mu.Unlock()

	if err := p.pullImage(ctx, image); err != nil {
		return fmt.Errorf("failed to pull image %s: %w", image, err)
	}

	for i := 0; i < min; i++ {
		id, workDir, err := p.createContainer(ctx, image, lang)
		if err != nil {
			return err
		}
		c := &PooledContainer{
			ID:             id,
			Language:       lang,
			WorkDir:        workDir,
			ExecutionCount: 0,
		}
		select {
		case ch <- c:
			// success
		default:
			// Can't happen given the channel is sized to max >= min above, but guard
			// against a future caller passing min > max and leaking a container.
			slog.Warn("WarmUp: channel full, discarding extra container", "language", lang)
			p.removeContainer(c)
		}
	}
	return nil
}

// Shutdown stops and removes all containers in the pool.
func (p *ContainerPool) Shutdown(ctx context.Context) {
	p.mu.Lock()
	slog.Info("Shutting down container pool", "total_languages", len(p.availChans), "total_in_use", len(p.inUse))

	var wg sync.WaitGroup

	remove := func(c *PooledContainer) {
		defer wg.Done()
		slog.Debug("Removing container", "containerId", c.ID, "language", c.Language)
		err := p.cli.RemoveContainer(docker.RemoveContainerOptions{
			ID:    c.ID,
			Force: true,
		})
		if err != nil {
			slog.Error("Failed to remove container during shutdown", "containerId", c.ID, "error", err)
		}
		// Also cleanup the workdir
		if err := workspace.CleanupContainerWorkspace(c.WorkDir); err != nil {
			slog.Error("Failed to cleanup workdir during shutdown", "workdir", c.WorkDir, "error", err)
		}
	}

	// Drain all available channels
	for lang, ch := range p.availChans {
		close(ch)
		for c := range ch {
			wg.Add(1)
			go remove(c)
		}
		delete(p.availChans, lang)
	}

	for id, c := range p.inUse {
		wg.Add(1)
		go remove(c)
		delete(p.inUse, id)
	}
	for id, c := range p.standby {
		wg.Add(1)
		go remove(c)
		delete(p.standby, id)
	}
	p.mu.Unlock()

	wg.Wait()
}

// PoolStats represents the current state of the container pool.
type PoolStats struct {
	Available map[string]int `json:"available"`
	InUse     map[string]int `json:"in_use"`
	Min       map[string]int `json:"min"`
	Max       map[string]int `json:"max"`
	Target    map[string]int `json:"target"`
	GlobalCap int            `json:"global_cap"`
}

// GetStats returns the current statistics of the container pool.
func (p *ContainerPool) GetStats() PoolStats {
	p.mu.Lock()
	defer p.mu.Unlock()

	stats := PoolStats{
		Available: make(map[string]int),
		InUse:     make(map[string]int),
		Min:       make(map[string]int),
		Max:       make(map[string]int),
		Target:    make(map[string]int),
		GlobalCap: p.globalCap,
	}

	for lang, ch := range p.availChans {
		stats.Available[lang] = len(ch)
	}

	for _, c := range p.inUse {
		stats.InUse[c.Language]++
	}

	for lang, l := range p.limits {
		stats.Min[lang] = l.Min
		stats.Max[lang] = l.Max
	}

	for lang, target := range p.targets {
		stats.Target[lang] = target
	}

	return stats
}

// StartMonitor starts a background goroutine to monitor container health.
func (p *ContainerPool) StartMonitor(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	go func() {
		for {
			select {
			case <-ctx.Done():
				ticker.Stop()
				return
			case <-ticker.C:
				p.checkHealth(ctx)
			}
		}
	}()
}

// StartReconciler periodically ensures each language's live container count (in-use +
// available) matches its current target. This is the self-healing safety net — crash
// recovery, drift correction — that runs continuously regardless of whether autoscaling is
// enabled; StartAutoscaler only ever changes *what* the target is, this loop is what actually
// makes reality match it. Kept on a slower, fixed cadence (see main.go, currently 1 minute)
// separate from the faster autoscaling decision interval, since this loop's job (catch drift)
// doesn't need to react as quickly as a live load signal does.
func (p *ContainerPool) StartReconciler(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				p.mu.Lock()
				langs := make([]string, 0, len(p.availChans))
				for lang := range p.availChans {
					langs = append(langs, lang)
				}
				p.mu.Unlock()

				metrics.SetReconcileLastRun(time.Now())

				for _, lang := range langs {
					p.convergeLang(ctx, lang)
				}
			}
		}
	}()
}

// convergeLang creates or removes containers for one language so its live count (in-use +
// available) matches p.targets[lang]. Called by StartReconciler on every tick for every
// language (self-healing), and by StartAutoscaler immediately after it changes a target (so a
// scale-up/down decision takes effect right away instead of waiting for the next reconciler
// tick, which could be up to a minute later).
func (p *ContainerPool) convergeLang(ctx context.Context, lang string) {
	p.mu.Lock()
	ch := p.availChans[lang]
	image := p.images[lang]
	inUseCount := 0
	for _, c := range p.inUse {
		if c.Language == lang {
			inUseCount++
		}
	}
	availCount := 0
	if ch != nil {
		availCount = len(ch)
	}
	current := inUseCount + availCount
	target := p.targets[lang]
	p.mu.Unlock()

	if current < target {
		// Create the missing containers, four at a time: one after another, a scale-up by
		// several (UpByHalf) held the autoscaler, and every other language, for seconds.
		missing := target - current
		var wg sync.WaitGroup
		sem := make(chan struct{}, 4)
		for i := 0; i < missing; i++ {
			wg.Add(1)
			sem <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-sem }()
				repl, err := p.newPooledContainer(ctx, image, lang)
				if err != nil {
					slog.Error("reconciler: failed to create replacement", "language", lang, "error", err)
					return
				}
				metrics.AddReconcileRepairs(1)
				p.mu.Lock()
				defer p.mu.Unlock()
				if ch2, ok := p.availChans[lang]; ok {
					select {
					case ch2 <- repl:
					default:
						// Should never happen: the channel has room up to the global cap
						// (WarmUp), which no target exceeds.
						p.removeContainer(repl)
					}
				} else {
					p.removeContainer(repl)
				}
			}()
		}
		wg.Wait()
	} else if current > target {
		// remove excess available containers (prefer idle ones)
		excess := current - target
		if excess > 0 && ch != nil {
			for i := 0; i < excess; i++ {
				select {
				case c := <-ch:
					p.mu.Lock()
					succ := p.retireLocked(c)
					p.mu.Unlock()
					p.removeContainer(c)
					if succ != nil {
						p.removeContainer(succ)
					}
				default:
					// no more idle containers to remove
				}
			}
		}
	}
}

// AutoscaleConfig bundles the tunables for StartAutoscaler. See main.go for where these are
// read from env vars (JUDGE_POOL_AUTOSCALE_INTERVAL, JUDGE_POOL_SCALE_UP_THRESHOLD_MS, etc.)
// and their defaults.
type AutoscaleConfig struct {
	Interval        time.Duration
	UpThresholdMs   float64
	DownThresholdMs float64
	UpCooldown      time.Duration
	DownCooldown    time.Duration
	// UpByHalf grows a language by half its target (at least 1) per scale-up instead of by 1:
	// 4 -> 6 -> 9 -> 13 -> 18, so a burst (an exam starting) is met in a few ticks rather than
	// one container every interval. Set with adaptive concurrency.
	UpByHalf bool
}

// SetCeiling sets how far past its configured max a language's pool may grow while the host has
// CPU to spare (pkg/capacity). Lowering it shrinks pools back on the autoscaler's next ticks,
// never below their configured max.
func (p *ContainerPool) SetCeiling(n int) { p.ceiling.Store(int64(n)) }

// effectiveMax is a language's max with the ceiling applied.
func (p *ContainerPool) effectiveMax(l LangLimits) int {
	if c := int(p.ceiling.Load()); c > l.Max {
		return c
	}
	return l.Max
}

// globalLiveTotal returns the current container count (in-use + available) summed across
// every language — what StartAutoscaler compares against globalCap before allowing any
// language to scale up, since all languages share the same underlying host CPU budget.
func (p *ContainerPool) globalLiveTotal() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	total := len(p.inUse)
	for _, ch := range p.availChans {
		total += len(ch)
	}
	return total
}

// StartAutoscaler runs the per-language scaling loop: every cfg.Interval, it diffs each
// language's cumulative Acquire wait-time counters (metrics.SnapshotAcquire) against the
// previous tick to get a rate for just that interval, feeds it through the pure decideScale
// function alongside that language's cooldown state and current global headroom, and — if the
// decision changes the target — updates it and calls convergeLang immediately so the change
// takes effect right away rather than waiting for the next (slower, fixed-cadence)
// StartReconciler tick.
//
// Language mins are never touched here (WarmUp creates them unconditionally and convergeLang
// never lets target below min) — this loop only ever moves target within [min, max].
func (p *ContainerPool) StartAutoscaler(ctx context.Context, cfg AutoscaleConfig) {
	if cfg.Interval <= 0 {
		return
	}
	ticker := time.NewTicker(cfg.Interval)
	go func() {
		defer ticker.Stop()

		prev := map[string]metrics.AcquireSnapshot{}
		lastScaleUp := map[string]time.Time{}
		lastScaleDown := map[string]time.Time{}

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				now := time.Now()
				snap := metrics.SnapshotAcquire()

				p.mu.Lock()
				langs := make([]string, 0, len(p.limits))
				for lang := range p.limits {
					langs = append(langs, lang)
				}
				p.mu.Unlock()

				for _, lang := range langs {
					cur := snap[lang]
					prior := prev[lang]

					deltaCount := cur.Count - prior.Count
					deltaWaitNanos := cur.WaitNanos - prior.WaitNanos
					deltaTimeouts := cur.TimeoutCount - prior.TimeoutCount
					hadTraffic := deltaCount > 0

					var avgWaitMs float64
					if deltaCount > 0 {
						avgWaitMs = float64(deltaWaitNanos) / float64(deltaCount) / 1e6
					}

					p.mu.Lock()
					limits, ok := p.limits[lang]
					target := p.targets[lang]
					p.mu.Unlock()
					if !ok {
						continue
					}

					upElapsed := lastScaleUp[lang].IsZero() || now.Sub(lastScaleUp[lang]) >= cfg.UpCooldown
					downElapsed := lastScaleDown[lang].IsZero() || now.Sub(lastScaleDown[lang]) >= cfg.DownCooldown
					headroom := p.globalLiveTotal() < p.globalCap

					decision := decideScale(
						limits.Min, p.effectiveMax(limits), target,
						avgWaitMs, hadTraffic, deltaTimeouts,
						cfg.UpThresholdMs, cfg.DownThresholdMs,
						upElapsed, downElapsed,
						headroom,
					)

					if cfg.UpByHalf && decision.Action == scaleActionUp {
						grown := target + target/2
						if grown < decision.NewTarget {
							grown = decision.NewTarget
						}
						if m := p.effectiveMax(limits); grown > m {
							grown = m
						}
						if room := p.globalCap - p.globalLiveTotal(); grown-target > room {
							grown = target + room
						}
						if grown > decision.NewTarget {
							decision.NewTarget = grown
						}
					}
					if decision.NewTarget != target {
						p.mu.Lock()
						p.targets[lang] = decision.NewTarget
						p.mu.Unlock()

						switch decision.Action {
						case scaleActionUp:
							lastScaleUp[lang] = now
						case scaleActionDown:
							lastScaleDown[lang] = now
						}

						slog.Info("autoscaler: adjusted target",
							"language", lang, "action", decision.Action, "newTarget", decision.NewTarget,
							"avgWaitMs", avgWaitMs, "timeouts", deltaTimeouts)

						p.convergeLang(ctx, lang)
					}
				}

				prev = snap
			}
		}
	}()
}

func (p *ContainerPool) checkHealth(ctx context.Context) {
	p.mu.Lock()
	langs := make([]string, 0, len(p.availChans))
	for lang := range p.availChans {
		langs = append(langs, lang)
	}
	p.mu.Unlock()

	for _, lang := range langs {
		p.mu.Lock()
		ch := p.availChans[lang]
		image := p.images[lang]
		p.mu.Unlock()

		if ch == nil {
			continue
		}

		// Non-blocking health check of available containers
		count := len(ch)
		for i := 0; i < count; i++ {
			var c *PooledContainer
			select {
			case c = <-ch:
			default:
				continue
			}

			if p.isContainerHealthy(c.ID) {
				select {
				case ch <- c:
				default:
					p.removeContainer(c)
				}
			} else {
				slog.Warn("Container found unhealthy, removing", "containerId", c.ID, "language", lang)
				p.mu.Lock()
				succ := p.retireLocked(c)
				p.mu.Unlock()
				p.removeContainer(c)

				if succ != nil {
					p.mu.Lock()
					p.pushLocked(succ, c.ID)
					p.mu.Unlock()
				} else if image != "" {
					replacement, err := p.newPooledContainer(ctx, image, lang)
					if err == nil {
						select {
						case ch <- replacement:
							slog.Info("Replaced unhealthy container", "oldId", c.ID, "newId", replacement.ID, "language", lang)
						default:
							p.removeContainer(replacement)
						}
					} else {
						slog.Error("Failed to recreate replacement container", "language", lang, "error", err)
					}
				}
			}
		}
	}
}

func (p *ContainerPool) isContainerHealthy(id string) bool {
	container, err := p.cli.InspectContainerWithOptions(docker.InspectContainerOptions{ID: id})
	if err != nil {
		return false
	}
	return container.State.Running && !container.State.Paused
}

func (p *ContainerPool) removeContainer(c *PooledContainer) {
	_ = p.cli.RemoveContainer(docker.RemoveContainerOptions{
		ID:    c.ID,
		Force: true,
	})
	_ = workspace.CleanupContainerWorkspace(c.WorkDir)
}

func (p *ContainerPool) newPooledContainer(ctx context.Context, image string, lang string) (*PooledContainer, error) {
	id, workDir, err := p.createContainer(ctx, image, lang)
	if err != nil {
		return nil, err
	}
	return &PooledContainer{
		ID:       id,
		Language: lang,
		WorkDir:  workDir,
	}, nil
}

// createContainer creates a new Docker container with a tmpfs volume mount.
func (p *ContainerPool) createContainer(ctx context.Context, image string, lang string) (string, string, error) {
	// For pooled containers, we run the main process as root.
	// This ensures that PID 1 (init) and PID 2 (tail) are not owned by the 'judge' user.
	// Subsequent user-code execution will be done as the 'judge' user via 'docker exec'.
	containerUser := "root"

	pidsLimit := int64(128)
	memoryBytes := int64(1024 * 1024 * 1024) // Increase to 1GB
	memorySwap := memoryBytes
	noNewPrivileges := "no-new-privileges:true"

	// Create a temporary directory on the host for this container
	if err := os.MkdirAll(workspace.RootDir, 0755); err != nil {
		return "", "", fmt.Errorf("failed to create workspace root %s: %w", workspace.RootDir, err)
	}
	hostWorkDir, err := os.MkdirTemp(workspace.RootDir, "judge-")
	if err != nil {
		return "", "", fmt.Errorf("failed to create temp dir for container: %w", err)
	}
	// hostWorkDir is used purely as a host-side staging area: submission source files
	// are written here, then read back and uploaded into the container via the Docker
	// exec/UploadToContainer API (see executor.copyFilesToContainer) — it is never
	// bind-mounted into the container. Container images typically run as a non-root
	// "judge" user, so keep this permissive for the judge-service process's own use.
	if err := os.Chmod(hostWorkDir, 0777); err != nil {
		return "", "", fmt.Errorf("failed to chmod container workdir %s: %w", hostWorkDir, err)
	}

	// docker-guard (cmd/docker-guard) refuses a create that strays from these settings
	// (any host-side option it does not know, network, mounts, capabilities beyond KILL):
	// change it together with this.
	hostCfg := &docker.HostConfig{
		Runtime:        p.sandboxRuntime(),
		NetworkMode:    "none",
		ReadonlyRootfs: true,
		SecurityOpt:    []string{noNewPrivileges},
		CapDrop:        []string{"ALL"},
		CapAdd:         []string{"KILL"},
		Memory:         memoryBytes,
		MemorySwap:     memorySwap,
		CPUQuota:       100000, // Increase to 1.0 CPU
		PidsLimit:      &pidsLimit,
		Init:           true,
		Tmpfs: map[string]string{
			"/tmp": "rw,noexec,nosuid,nodev,size=512m",
			// /app is tmpfs (not a host bind mount) so a submission that writes a huge
			// file there fills bounded, memory-backed space instead of real host disk.
			// Unlike /tmp, this must stay executable — compiled binaries run from here.
			// "exec" must be listed explicitly: Docker defaults tmpfs mounts to noexec
			// when the option isn't named outright, even though nothing here asked for
			// noexec — confirmed via `mount`/`/proc/mounts` showing noexec on this
			// engine version despite this string never containing it. Without "exec",
			// every compiled language's own freshly-built binary 126s with "permission
			// denied" trying to exec itself from /app.
			// mode=1777 (like /tmp): submission files are uploaded as the judge user, so
			// everything in /app is that user's and the reset can wipe it as that user
			// (executor.containerWipeScript, JUDGE_FIX_PLAN S1).
			"/app": "rw,exec,nosuid,nodev,size=512m,mode=1777",
		},
	}

	containerOptions := docker.CreateContainerOptions{
		Context: ctx,
		Config: &docker.Config{
			Image:      image,
			Cmd:        []string{"tail", "-f", "/dev/null"},
			WorkingDir: "/app",
			Tty:        false,
			Labels: map[string]string{
				"app":        "code-platform",
				"service":    "judge",
				"managed-by": "judge-service",
				"language":   lang,
				"pool":       "true",
			},
		},
		HostConfig: hostCfg,
	}
	if instance := Instance(); instance != "" {
		containerOptions.Config.Labels[InstanceLabelKey] = instance
	}

	// If containerUser configured, set it
	if containerUser != "" {
		containerOptions.Config.User = containerUser
	}

	container, err := p.cli.CreateContainer(containerOptions)
	if err != nil {
		return "", "", fmt.Errorf("failed to create container: %w", err)
	}

	if err := p.cli.StartContainer(container.ID, nil); err != nil {
		// If starting fails, try to remove the container
		_ = p.cli.RemoveContainer(docker.RemoveContainerOptions{ID: container.ID, Force: true})
		return "", "", fmt.Errorf("failed to start container: %w", err)
	}

	slog.Info("Started container", "containerId", container.ID, "language", lang, "workdir", filepath.Clean(hostWorkDir))

	p.runWarmupHook(ctx, container.ID, lang)

	return container.ID, hostWorkDir, nil
}

// warmupHookPath is an optional script a language image can ship to prepare a new container,
// for example the Go image seeding its build cache (environments/go/judge-warmup).
const warmupHookPath = "/usr/local/bin/judge-warmup"

// runWarmupHook runs the image's warm-up script, if it has one, as the judge user right after
// the container starts, and waits for it so the container is warm before it is pooled. Best
// effort: a failure is logged and the container is still used, just slower on its first run.
func (p *ContainerPool) runWarmupHook(ctx context.Context, containerID string, lang string) {
	exec, err := p.cli.CreateExec(docker.CreateExecOptions{
		Context:      ctx,
		Container:    containerID,
		User:         "judge",
		Cmd:          []string{"sh", "-c", "[ -x " + warmupHookPath + " ] && " + warmupHookPath + "; exit 0"},
		AttachStdout: true,
		AttachStderr: true,
	})
	if err != nil {
		slog.Warn("Container warm-up skipped: could not create exec", "containerId", containerID, "language", lang, "error", err)
		return
	}
	start := time.Now()
	if err := p.cli.StartExec(exec.ID, docker.StartExecOptions{Context: ctx, OutputStream: io.Discard, ErrorStream: io.Discard}); err != nil {
		slog.Warn("Container warm-up failed", "containerId", containerID, "language", lang, "error", err)
		return
	}
	if elapsed := time.Since(start); elapsed > 50*time.Millisecond {
		slog.Info("Container warmed up", "containerId", containerID, "language", lang, "elapsedMs", elapsed.Milliseconds())
	}
}

// pullImage pulls a Docker image if it's not available locally
func (p *ContainerPool) pullImage(ctx context.Context, image string) error {
	// If image exists locally, skip
	if _, err := p.cli.InspectImage(image); err == nil {
		return nil
	} else if err != docker.ErrNoSuchImage {
		return fmt.Errorf("failed to inspect image %s: %w", image, err)
	}

	// Parse image into repository and tag
	repo, tag := image, "latest"
	if strings.Contains(image, ":") {
		parts := strings.SplitN(image, ":", 2)
		repo, tag = parts[0], parts[1]
	}

	slog.Info("Pulling image", "repository", repo, "tag", tag)
	pullOptions := docker.PullImageOptions{
		Repository:   repo,
		Tag:          tag,
		Context:      ctx,
		OutputStream: io.Discard,
	}
	auth := docker.AuthConfiguration{}
	if err := p.cli.PullImage(pullOptions, auth); err != nil {
		return fmt.Errorf("failed to pull image %s: %w", image, err)
	}
	return nil
}
