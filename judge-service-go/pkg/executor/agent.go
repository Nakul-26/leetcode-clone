package executor

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	docker "github.com/fsouza/go-dockerclient"

	"judge-service-go/pkg/agentproto"
	"judge-service-go/pkg/languages"
)

// The resident sandbox agent (JUDGE_AGENT_PLAN Phase 2, Option B; cmd/judge-agent).
//
// A `docker exec` is expensive for the host: each starts a runc process that joins the
// container's namespaces and cgroups, which costs far more CPU than the ~20 ms Python program it
// then runs. With the agent, a container gets two long-lived execs when it is first used, a
// runner (judge user) and a keeper (root), and every later exec for that container is a message
// to one of them instead.
//
// The agent sits under the three calls everything else goes through (createExec, startExec and
// inspectExec in dockercalls.go): an exec for the judge user is run by the runner, one for root
// by the keeper, with the same command, working directory, stdin, streamed output and exit
// code. So every step above them is unchanged and covered by the same tests: the deferred wipe
// and upload (prep.go), the runner scripts, time limits, output caps, and memory limits set from
// outside the sandbox. CPU time comes from the keeper's read-only cgroup counter, with Docker
// stats as a compatibility fallback.
//
// The one step that changes is killing the judge user's processes: `pkill -u judge` would kill
// the runner too, so with the agent the keeper does it and spares the runner (killJudge).
//
// Enabled per language: JUDGE_AGENT_LANGS=python,javascript (or "all"). A container whose image
// has no agent, or one of another protocol version, uses plain execs for its whole life.

const (
	agentBinary       = "/usr/local/bin/judge-agent"
	agentStartTimeout = 10 * time.Second
	agentReplyTimeout = 5 * time.Second
	// How long a cancelled command may take to report its end before the runner is treated as
	// unresponsive (a submission may have stopped it) and replaced.
	agentCancelGrace = time.Second
)

// agentLangs reads JUDGE_AGENT_LANGS: nil when the agent is off, otherwise the languages it is
// on for ("all" matches every language). Read on each new container so tests can switch it.
func agentLangs() map[string]bool {
	v := strings.TrimSpace(os.Getenv("JUDGE_AGENT_LANGS"))
	if v == "" || v == "0" || strings.EqualFold(v, "false") || strings.EqualFold(v, "off") {
		return nil
	}
	langs := map[string]bool{}
	for _, l := range strings.Split(v, ",") {
		if l = strings.ToLower(strings.TrimSpace(l)); l != "" {
			langs[l] = true
		}
	}
	return langs
}

// agentEnabledForImage reports whether a sandbox image belongs to a language the agent is on
// for. One image can serve several languages (judge-js-env runs JavaScript and TypeScript);
// any of them listed is enough.
func agentEnabledForImage(image string, langs map[string]bool) bool {
	if i := strings.LastIndex(image, "/"); i >= 0 {
		image = image[i+1:]
	}
	if i := strings.IndexByte(image, ':'); i >= 0 {
		image = image[:i]
	}
	for id, l := range languages.Languages {
		if l.Image == image && (langs["all"] || langs[id]) {
			return true
		}
	}
	return false
}

// agentState is one container's agent: off for its whole life, or its two connections.
type agentState struct {
	containerID string
	mu          sync.Mutex
	off         bool
	cpuTimeOff  bool // the keeper could not read this sandbox's immutable cgroup CPU counter
	keeper      *agentConn
	runner      *agentConn
}

// agentFor returns the container's agent state, or nil when it uses plain execs. The first call
// for a container inspects it once for its image.
func (e *Executor) agentFor(containerID string) *agentState {
	if v, ok := e.agents.Load(containerID); ok {
		st := v.(*agentState)
		if st.isOff() {
			return nil
		}
		return st
	}
	st := &agentState{containerID: containerID}
	langs := agentLangs()
	if langs == nil {
		// Not cached: the switch may be turned on later.
		return nil
	}
	start := time.Now()
	c, err := e.cli.InspectContainerWithOptions(docker.InspectContainerOptions{ID: containerID})
	recordSince("inspect", start)
	if err != nil || c.Config == nil {
		return nil // not cached either; the next call tries again
	}
	if !agentEnabledForImage(c.Config.Image, langs) {
		st.off = true
	}
	actual, _ := e.agents.LoadOrStore(containerID, st)
	st = actual.(*agentState)
	if st.isOff() {
		return nil
	}
	return st
}

func (st *agentState) isOff() bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.off
}

// active reports whether the agent is running in this container (so kills must go through
// the keeper). A container whose agent was never started still uses plain execs.
func (e *Executor) agentActive(containerID string) *agentState {
	v, ok := e.agents.Load(containerID)
	if !ok {
		return nil
	}
	st := v.(*agentState)
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.off || st.keeper == nil || st.keeper.isDead() {
		return nil
	}
	return st
}

// connFor returns the live connection that runs commands as user, starting the agent (or a new
// runner) first if needed. ok is false when this container should use a plain exec instead.
func (e *Executor) connFor(ctx context.Context, st *agentState, user string) (conn *agentConn, ok bool, err error) {
	var role string
	switch user {
	case getJudgeUser():
		role = "runner"
	case "root":
		role = "keeper"
	default:
		return nil, false, nil
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.off {
		return nil, false, nil
	}
	first := st.keeper == nil
	if st.keeper == nil || st.keeper.isDead() {
		if !first {
			// The keeper is root; no submission can stop it. Losing it means the container
			// itself is going away.
			return nil, true, e.markBroken(st.containerID, "sandbox agent keeper lost")
		}
		k, err := e.startAgentConn(ctx, st.containerID, "root", "keeper")
		if err != nil {
			// No agent in this image, or an old one: plain execs for this container.
			slog.Warn("sandbox agent unavailable, using plain execs", "containerId", st.containerID, "error", err)
			st.off = true
			return nil, false, nil
		}
		st.keeper = k
	}
	if role == "keeper" {
		return st.keeper, true, nil
	}
	if st.runner == nil || st.runner.isDead() {
		if err := e.startRunnerLocked(ctx, st, !first); err != nil {
			if first {
				slog.Warn("sandbox agent runner unavailable, using plain execs", "containerId", st.containerID, "error", err)
				st.keeper.close()
				st.keeper = nil
				st.off = true
				return nil, false, nil
			}
			return nil, true, e.markBroken(st.containerID, "sandbox agent runner could not be restarted: "+err.Error())
		}
	}
	return st.runner, true, nil
}

// startRunnerLocked starts a runner and registers it with the keeper. A replacement runner is
// only started after the keeper killed every judge-user process, so nothing a submission left
// behind can outlive the old runner and meet the new one.
func (e *Executor) startRunnerLocked(ctx context.Context, st *agentState, replacing bool) error {
	if st.runner != nil {
		st.runner.close()
		st.runner = nil
	}
	if replacing {
		if r, err := st.keeper.request(ctx, &agentproto.Msg{Op: agentproto.OpKillJudge, Spare: false, User: getJudgeUser()}); err != nil {
			return err
		} else if r.Code == 1 {
			return errors.New(r.Err)
		}
	}
	runner, err := e.startAgentConn(ctx, st.containerID, getJudgeUser(), "runner")
	if err != nil {
		return err
	}
	r, err := st.keeper.request(ctx, &agentproto.Msg{Op: agentproto.OpRegister, Pid: runner.pid})
	if err == nil && r.Code != 0 {
		err = errors.New(r.Err)
	}
	if err != nil {
		runner.close()
		return err
	}
	st.runner = runner
	agentRunnerStarts.Add(1)
	return nil
}

// replaceRunner drops a runner that cannot be trusted any more (stopped, tampered with or
// gone) and starts a new one.
func (e *Executor) replaceRunner(ctx context.Context, st *agentState, reason string) error {
	slog.Warn("replacing sandbox agent runner", "containerId", st.containerID, "reason", reason)
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.off || st.keeper == nil || st.keeper.isDead() {
		return e.markBroken(st.containerID, "sandbox agent keeper lost")
	}
	if err := e.startRunnerLocked(ctx, st, true); err != nil {
		return e.markBroken(st.containerID, "sandbox agent runner could not be restarted: "+err.Error())
	}
	return nil
}

// markBroken makes the container's next reset fail, so it is discarded, and returns the
// error for the current step.
func (e *Executor) markBroken(containerID, reason string) error {
	e.broken.Store(containerID, reason)
	return containerBrokenError(reason)
}

// agentRunnerStarts counts runners started, for tests.
var agentRunnerStarts atomic.Int64

// AgentRunnerStarts reports how many sandbox agent runners this process has started.
func AgentRunnerStarts() int64 { return agentRunnerStarts.Load() }

// agentConn is one agent process, reached over the stdin and stdout of a long-lived exec.
type agentConn struct {
	containerID string
	role        string
	pid         int

	wmu sync.Mutex
	in  *io.PipeWriter
	cw  docker.CloseWaiter

	mu      sync.Mutex
	jobs    map[uint64]*agentJob
	replies map[uint64]chan *agentproto.Msg
	seq     uint64

	dead      chan struct{}
	deadOnce  sync.Once
	closeOnce sync.Once
}

func (c *agentConn) isDead() bool {
	select {
	case <-c.dead:
		return true
	default:
		return false
	}
}

func (c *agentConn) markDead() {
	c.deadOnce.Do(func() {
		close(c.dead)
		c.mu.Lock()
		defer c.mu.Unlock()
		for id, j := range c.jobs {
			j.lost = true
			j.finish(lostAgentExitCode)
			delete(c.jobs, id)
		}
		for seq, ch := range c.replies {
			close(ch)
			delete(c.replies, seq)
		}
	})
}

// lostAgentExitCode is what a command reports when its runner died under it: the same as a
// process killed with SIGKILL, which is what happens when a submission kills every process it
// can (and the runner with them) or exceeds its memory limit.
const lostAgentExitCode = 137

// close may be called from several places (a replaced runner, the kill, shutdown) and only
// does its work once: go-dockerclient's CloseWaiter panics when closed a second time.
func (c *agentConn) close() {
	c.closeOnce.Do(func() {
		_ = c.in.Close()
		if c.cw != nil {
			_ = c.cw.Close()
		}
	})
	c.markDead()
}

func (c *agentConn) write(m *agentproto.Msg) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	if c.isDead() {
		return errors.New("sandbox agent connection closed")
	}
	if err := agentproto.Write(c.in, m); err != nil {
		c.markDead()
		return fmt.Errorf("sandbox agent write: %w", err)
	}
	return nil
}

// request sends a keeper or runner request that has one reply (ping, register, killjudge).
func (c *agentConn) request(ctx context.Context, m *agentproto.Msg) (*agentproto.Msg, error) {
	ch := make(chan *agentproto.Msg, 1)
	c.mu.Lock()
	if c.isDead() {
		c.mu.Unlock()
		return nil, errors.New("sandbox agent connection closed")
	}
	c.seq++
	m.Seq = c.seq
	c.replies[m.Seq] = ch
	c.mu.Unlock()
	if err := c.write(m); err != nil {
		return nil, err
	}
	timer := time.NewTimer(agentReplyTimeout)
	defer timer.Stop()
	select {
	case r, ok := <-ch:
		if !ok {
			return nil, errors.New("sandbox agent connection closed")
		}
		return r, nil
	case <-timer.C:
		return nil, fmt.Errorf("sandbox agent %s did not answer %s", c.role, m.Op)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// startAgentConn starts one agent process as a long-lived exec and waits for its hello.
func (e *Executor) startAgentConn(ctx context.Context, containerID, user, role string) (*agentConn, error) {
	start := time.Now()
	ex, err := e.cli.CreateExec(docker.CreateExecOptions{
		Container:    containerID,
		User:         user,
		Cmd:          []string{agentBinary, role},
		WorkingDir:   "/",
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		Context:      ctx,
	})
	recordSince("exec_create", start)
	if err != nil {
		return nil, fmt.Errorf("creating agent exec: %w", err)
	}

	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	c := &agentConn{
		containerID: containerID,
		role:        role,
		in:          inW,
		jobs:        map[uint64]*agentJob{},
		replies:     map[uint64]chan *agentproto.Msg{},
		dead:        make(chan struct{}),
	}
	start = time.Now()
	cw, err := e.cli.StartExecNonBlocking(ex.ID, docker.StartExecOptions{
		InputStream:  inR,
		OutputStream: outW,
		ErrorStream:  &agentLog{containerID: containerID, role: role},
		// Not ctx: the connection outlives the request that started it.
		Context: context.Background(),
	})
	recordSince("exec_start", start)
	if err != nil {
		_ = inW.Close()
		return nil, fmt.Errorf("starting agent exec: %w", err)
	}
	c.cw = cw
	go func() {
		_ = cw.Wait()
		_ = outW.Close()
		_ = inR.Close()
		c.markDead()
		if role == "keeper" {
			// The keeper is root and no submission can stop it, so its exec ends when the
			// container is removed: forget the container. (If it ever ended otherwise, the next
			// use would start a new agent from scratch, which is safe: a new keeper's first kill
			// spares only the runner registered with it.)
			e.agents.Delete(containerID)
		}
	}()

	hello := make(chan *agentproto.Msg, 1)
	go c.readLoop(bufio.NewReaderSize(outR, 64<<10), hello)

	timer := time.NewTimer(agentStartTimeout)
	defer timer.Stop()
	select {
	case h := <-hello:
		if h == nil {
			c.close()
			return nil, errors.New("agent exited before saying hello (no judge-agent in this image?)")
		}
		if h.Version != agentproto.Version || h.Role != role || h.Pid <= 0 {
			c.close()
			return nil, fmt.Errorf("agent hello %+v does not match version %s role %s", h, agentproto.Version, role)
		}
		c.pid = h.Pid
		return c, nil
	case <-timer.C:
		c.close()
		return nil, errors.New("agent did not say hello in time")
	case <-ctx.Done():
		c.close()
		return nil, ctx.Err()
	}
}

func (c *agentConn) readLoop(r io.Reader, hello chan<- *agentproto.Msg) {
	defer c.markDead()
	first := true
	for {
		m, err := agentproto.Read(r)
		if err != nil {
			if first {
				hello <- nil
			}
			return
		}
		if first {
			first = false
			if m.Op != agentproto.OpHello {
				hello <- nil
				return
			}
			hello <- m
			continue
		}
		switch m.Op {
		case agentproto.OpStarted, agentproto.OpOut, agentproto.OpErr, agentproto.OpExit:
			c.mu.Lock()
			j := c.jobs[m.ID]
			if m.Op == agentproto.OpExit || (m.Op == agentproto.OpStarted && m.Code != 0) {
				delete(c.jobs, m.ID)
			}
			c.mu.Unlock()
			if j != nil {
				j.handle(m)
			}
		case agentproto.OpPong, agentproto.OpDone:
			c.mu.Lock()
			ch := c.replies[m.Seq]
			delete(c.replies, m.Seq)
			c.mu.Unlock()
			if ch != nil {
				ch <- m
			}
		}
	}
}

// agentLog sends what an agent writes on its own stderr (never a program's output: that comes
// back in frames) to the judge's log, bounded.
type agentLog struct {
	containerID, role string
	n                 int
}

func (l *agentLog) Write(p []byte) (int, error) {
	if l.n < 16<<10 {
		l.n += len(p)
		slog.Warn("sandbox agent stderr", "containerId", l.containerID, "role", l.role, "output", strings.TrimSpace(string(p)))
	}
	return len(p), nil
}

// agentJob is one command run by an agent, standing in for one exec.
type agentJob struct {
	id             uint64
	stdout, stderr io.Writer
	started        chan *agentproto.Msg
	done           chan struct{}
	doneOnce       sync.Once
	code           int
	lost           bool
}

func (j *agentJob) handle(m *agentproto.Msg) {
	switch m.Op {
	case agentproto.OpStarted:
		select {
		case j.started <- m:
		default:
		}
		if m.Code != 0 {
			j.finish(-1)
		}
	case agentproto.OpOut:
		if j.stdout != nil {
			_, _ = j.stdout.Write(m.Data)
		}
	case agentproto.OpErr:
		if j.stderr != nil {
			_, _ = j.stderr.Write(m.Data)
		}
	case agentproto.OpExit:
		j.finish(m.Code)
	}
}

func (j *agentJob) finish(code int) {
	j.doneOnce.Do(func() {
		j.code = code
		close(j.done)
	})
}

// agentExec is an exec created through createExec for a container with an agent: the options
// are kept until startExec runs them.
type agentExec struct {
	st   *agentState
	opts docker.CreateExecOptions
	job  *agentJob
	conn *agentConn
	// realID is set when the agent was unavailable after all and a real exec ran instead.
	realID string
}

var agentExecSeq atomic.Uint64

const agentExecPrefix = "agent-exec-"

// createAgentExec stands in for CreateExec. ok is false when this exec must be a real one.
func (e *Executor) createAgentExec(opts docker.CreateExecOptions) (*docker.Exec, bool) {
	st := e.agentFor(opts.Container)
	if st == nil {
		return nil, false
	}
	if opts.User != getJudgeUser() && opts.User != "root" {
		return nil, false
	}
	if opts.Tty {
		return nil, false
	}
	id := fmt.Sprintf("%s%d", agentExecPrefix, agentExecSeq.Add(1))
	e.agentExecs.Store(id, &agentExec{st: st, opts: opts})
	return &docker.Exec{ID: id}, true
}

// startAgentExec stands in for StartExecNonBlocking.
func (e *Executor) startAgentExec(id string, opts docker.StartExecOptions) (docker.CloseWaiter, bool, error) {
	v, ok := e.agentExecs.Load(id)
	if !ok {
		return nil, false, nil
	}
	ax := v.(*agentExec)
	ctx := opts.Context
	if ctx == nil {
		ctx = context.Background()
	}

	var stdin []byte
	hasStdin := ax.opts.AttachStdin && opts.InputStream != nil
	if hasStdin {
		b, err := io.ReadAll(opts.InputStream)
		if err != nil {
			e.agentExecs.Delete(id)
			return nil, true, fmt.Errorf("reading exec stdin: %w", err)
		}
		stdin = b
	}

	for attempt := 0; ; attempt++ {
		conn, ok, err := e.connFor(ctx, ax.st, ax.opts.User)
		if err != nil {
			e.agentExecs.Delete(id)
			return nil, true, err
		}
		if !ok {
			// The agent turned out to be unavailable for this container: run a real exec.
			cw, realID, err := e.realExec(ax.opts, opts, stdin, hasStdin)
			ax.realID = realID
			return cw, true, err
		}
		job := &agentJob{started: make(chan *agentproto.Msg, 1), done: make(chan struct{})}
		if ax.opts.AttachStdout {
			job.stdout = opts.OutputStream
		}
		if ax.opts.AttachStderr {
			job.stderr = opts.ErrorStream
		}
		job.id = agentExecSeq.Add(1)
		conn.mu.Lock()
		dead := conn.isDead()
		if !dead {
			conn.jobs[job.id] = job
		}
		conn.mu.Unlock()
		if dead {
			if attempt == 0 && ax.opts.User == getJudgeUser() {
				continue // connFor replaces the runner
			}
			e.agentExecs.Delete(id)
			return nil, true, errors.New("sandbox agent connection closed")
		}
		cmd := ax.opts.Cmd
		dir := ax.opts.WorkingDir
		if dir == "" {
			dir = "/"
		}
		if err := conn.write(&agentproto.Msg{Op: agentproto.OpExec, ID: job.id, Cmd: cmd, Dir: dir, HasStdin: hasStdin, Stdin: stdin}); err != nil {
			e.agentExecs.Delete(id)
			return nil, true, err
		}

		var started *agentproto.Msg
		timer := time.NewTimer(agentStartTimeout)
		select {
		case started = <-job.started:
		case <-job.done:
		case <-timer.C:
		case <-ctx.Done():
		}
		timer.Stop()
		if started == nil {
			if conn.isDead() && attempt == 0 && ax.opts.User == getJudgeUser() {
				continue
			}
			if conn.role == "runner" {
				_ = e.replaceRunner(context.Background(), ax.st, "no answer to an exec")
			}
			e.agentExecs.Delete(id)
			if ctx.Err() != nil {
				return nil, true, ctx.Err()
			}
			return nil, true, errors.New("sandbox agent did not start the command")
		}
		if started.Code != 0 {
			if strings.HasPrefix(started.Err, "tainted") && attempt == 0 {
				if err := e.replaceRunner(ctx, ax.st, started.Err); err != nil {
					e.agentExecs.Delete(id)
					return nil, true, err
				}
				continue
			}
			e.agentExecs.Delete(id)
			return nil, true, fmt.Errorf("sandbox agent could not start %v: %s", cmd, started.Err)
		}
		ax.job, ax.conn = job, conn
		return &agentWaiter{e: e, id: id, ax: ax}, true, nil
	}
}

// realExec runs an exec the agent was meant to run as a plain one, for a container that
// turned out to have no agent.
func (e *Executor) realExec(copts docker.CreateExecOptions, sopts docker.StartExecOptions, stdin []byte, hasStdin bool) (docker.CloseWaiter, string, error) {
	start := time.Now()
	ex, err := e.cli.CreateExec(copts)
	recordSince("exec_create", start)
	if err != nil {
		return nil, "", err
	}
	if hasStdin {
		sopts.InputStream = strings.NewReader(string(stdin))
	}
	start = time.Now()
	cw, err := e.cli.StartExecNonBlocking(ex.ID, sopts)
	recordSince("exec_start", start)
	if err != nil {
		return nil, ex.ID, err
	}
	return cw, ex.ID, nil
}

// inspectAgentExec stands in for InspectExec.
func (e *Executor) inspectAgentExec(id string) (*docker.ExecInspect, error) {
	v, ok := e.agentExecs.Load(id)
	if !ok {
		return nil, fmt.Errorf("no such exec instance: %s", id)
	}
	ax := v.(*agentExec)
	if ax.realID != "" {
		e.agentExecs.Delete(id)
		start := time.Now()
		defer recordSince("exec_inspect", start)
		return e.cli.InspectExec(ax.realID)
	}
	if ax.job == nil {
		return &docker.ExecInspect{ID: id, ExitCode: -1}, nil
	}
	select {
	case <-ax.job.done:
	default:
		return &docker.ExecInspect{ID: id, Running: true}, nil
	}
	return &docker.ExecInspect{ID: id, ExitCode: ax.job.code}, nil
}

// agentWaiter stands in for the CloseWaiter of a started exec.
type agentWaiter struct {
	e         *Executor
	id        string
	ax        *agentExec
	closeOnce sync.Once
}

func (w *agentWaiter) Wait() error {
	<-w.ax.job.done
	if w.ax.job.lost && w.ax.conn.role == "keeper" {
		return errors.New("sandbox agent keeper lost")
	}
	return nil
}

// Close ends the command if it still runs (a time limit or a cancelled request), as closing a
// real exec's connection does, and more: a real exec's process kept running until the next
// kill, this one is killed now. A runner that does not report the end within agentCancelGrace
// is replaced (it may have been stopped by the submission).
func (w *agentWaiter) Close() error {
	w.closeOnce.Do(func() {
		defer func() {
			// Kept until here so inspectExec, which the callers run before their deferred
			// Close, still finds it.
			w.e.agentExecs.Delete(w.id)
		}()
		job, conn := w.ax.job, w.ax.conn
		select {
		case <-job.done:
			return
		default:
		}
		_ = conn.write(&agentproto.Msg{Op: agentproto.OpCancel, ID: job.id})
		select {
		case <-job.done:
			return
		case <-time.After(agentCancelGrace):
		}
		if conn.role == "runner" {
			_ = w.e.replaceRunner(context.Background(), w.ax.st, "a cancelled command did not end")
		}
		job.lost = true
		job.finish(lostAgentExitCode)
	})
	return nil
}

// killJudge kills the judge user's processes through the keeper, sparing the runner (the
// agent's replacement for `pkill -9 -u judge`). handled is false when the container has no
// running agent and the caller must use its plain exec. err is set if any judge-user process
// survived; the container must then be discarded.
func (e *Executor) killJudge(ctx context.Context, containerID string) (handled bool, err error) {
	st := e.agentActive(containerID)
	if st == nil {
		return false, nil
	}
	st.mu.Lock()
	keeper := st.keeper
	st.mu.Unlock()
	r, err := keeper.request(ctx, &agentproto.Msg{Op: agentproto.OpKillJudge, Spare: true, User: getJudgeUser()})
	if err != nil {
		return true, e.markBroken(containerID, "sandbox agent kill failed: "+err.Error())
	}
	switch r.Code {
	case 0:
		return true, nil
	case 2:
		// The runner was already gone (killed by the submission, or never started), and now
		// everything else is too. Drop its connection at once, so no command is sent to it
		// before its exec is seen to end; the next command starts a new runner.
		st.mu.Lock()
		if st.runner != nil {
			st.runner.close()
			st.runner = nil
		}
		st.mu.Unlock()
		return true, nil
	default:
		return true, fmt.Errorf("%s", r.Err)
	}
}

// checkRunner makes sure the runner the next submission will use is responsive and untouched,
// and replaces it otherwise. Run at every reset, after the kill.
func (e *Executor) checkRunner(ctx context.Context, containerID string) error {
	st := e.agentActive(containerID)
	if st == nil {
		return nil
	}
	st.mu.Lock()
	runner := st.runner
	st.mu.Unlock()
	if runner == nil || runner.isDead() {
		return nil // started on the next command
	}
	r, err := runner.request(ctx, &agentproto.Msg{Op: agentproto.OpPing})
	if err == nil && r.Err == "" {
		return nil
	}
	reason := "no answer to a ping"
	if err == nil {
		reason = r.Err
	}
	return e.replaceRunner(ctx, st, reason)
}
