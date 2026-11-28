// Package compilesvc runs the resident Java compiler (environments/java/compile-server) and
// sends it compiles (JUDGE_COMPILE_SERVICE=java).
//
// Java is CPU-bound on javac: a fresh javac costs ~340 ms on one core, almost all of it
// starting the JVM, and every Java submission and Run paid it. In a JVM that keeps running a
// compile takes ~60 ms (measured on deploy2, 2026-11-27). So each judge keeps one compiler
// container, and its sandboxes get the class files instead of compiling themselves.
//
// The container is locked down like a sandbox: no network, read-only root filesystem, every
// capability dropped, no-new-privileges, pids and memory limits, the server running as the
// judge user. Submitted code never runs in it: the server forces annotation processing off (the
// one way javac runs code it is given) and refuses options that could change that. What it
// sends back is class files, which the sandbox runs exactly as it ran its own.
//
// It is a shared process, unlike a sandbox, so it is recycled: the server exits after a few
// hundred compiles, or at once if a compile runs over its limit, and a new one starts. If it is
// unavailable the judge compiles in the sandbox as before; nothing depends on it.
package compilesvc

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	docker "github.com/fsouza/go-dockerclient"

	"judge-service-go/pkg/metrics"
	"judge-service-go/pkg/pool"
	"judge-service-go/pkg/workspace"
)

const (
	serverClasspath = "/opt/judge-java/compile-server:/usr/share/java/gson.jar"
	maxFrame        = 48 << 20
	helloTimeout    = 30 * time.Second
)

// Enabled reports whether the service is on for a language (JUDGE_COMPILE_SERVICE=java).
func Enabled(lang string) bool {
	for _, l := range strings.Split(os.Getenv("JUDGE_COMPILE_SERVICE"), ",") {
		if strings.EqualFold(strings.TrimSpace(l), lang) {
			return true
		}
	}
	return false
}

// Result is one compile: javac's exit code and messages, and on success the class files by
// path relative to the output directory.
type Result struct {
	Exit   int
	Output string
	Files  map[string][]byte
}

// errServerExited: the server ended before answering, usually because it recycled itself.
var errServerExited = errors.New("compile server exited before answering")

// ErrUnavailable means the caller should compile in the sandbox instead.
var ErrUnavailable = errors.New("compile service unavailable")

// Service is one judge's compiler container and the server running in it.
type Service struct {
	cli   *docker.Client
	image string

	mu              sync.Mutex
	containerID     string
	compilerImageID string // immutable for this container; cleared when it is removed
	conn            *conn
	failures        int
	retryAfter      time.Time

	compiles, fallbacks, restarts atomic.Int64
}

// New makes a service for the Java image. Nothing starts until the first compile.
func New(cli *docker.Client, javaImage string) *Service {
	return &Service{cli: cli, image: javaImage}
}

// CacheIdentity identifies the actual compiler image without widening docker-guard's
// named-image allowlist. A restarted container may resolve a rebuilt tag differently.
func (s *Service) CacheIdentity() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.containerID != "" {
		if s.compilerImageID != "" {
			return s.compilerImageID, nil
		}
		container, err := s.cli.InspectContainerWithOptions(docker.InspectContainerOptions{ID: s.containerID})
		if err != nil {
			return "", err
		}
		s.compilerImageID = container.Image
		return s.compilerImageID, nil
	}
	image, err := s.cli.InspectImage(s.image)
	if err != nil {
		return "", err
	}
	return image.ID, nil
}

// Stats reports compiles served, compiles sent back to the sandbox and server starts.
func (s *Service) Stats() (compiles, fallbacks, restarts int64) {
	return s.compiles.Load(), s.fallbacks.Load(), s.restarts.Load()
}

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name))); err == nil && v > 0 {
		return v
	}
	return def
}

// CompileJava compiles the given sources (name -> content) with javac args. ErrUnavailable
// (or any other error) means: compile in the sandbox instead.
func (s *Service) CompileJava(ctx context.Context, sources map[string][]byte, args []string) (*Result, error) {
	c, err := s.connection(ctx)
	if err != nil {
		s.fallbacks.Add(1)
		return nil, err
	}
	files := make(map[string]string, len(sources))
	for name, b := range sources {
		files[name] = base64.StdEncoding.EncodeToString(b)
	}
	timeout := time.Duration(envInt("JUDGE_COMPILE_SERVICE_TIMEOUT_S", 30)+5) * time.Second
	reply, err := c.request(ctx, files, args, timeout)
	if errors.Is(err, errServerExited) {
		// It recycled itself (or crashed) with this request in flight. A compile can be
		// repeated safely: once more, on a new server.
		s.dropConn(c, err)
		if c, err = s.connection(ctx); err == nil {
			reply, err = c.request(ctx, files, args, timeout)
		}
	}
	if err != nil {
		s.fallbacks.Add(1)
		if c != nil {
			s.dropConn(c, err)
		}
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if reply.Retire {
		s.retire(c)
	}
	if reply.Exit < 0 {
		s.fallbacks.Add(1)
		return nil, fmt.Errorf("%w: refused: %s", ErrUnavailable, reply.Output)
	}
	if reply.CompileNanos > 0 {
		metrics.RecordStage(metrics.WithLanguage(ctx, "java"), "compiler_queue", time.Duration(reply.QueueNanos))
		metrics.RecordStage(metrics.WithLanguage(ctx, "java"), "compiler_work", time.Duration(reply.CompileNanos))
	}
	res := &Result{Exit: reply.Exit, Output: reply.Output, Files: map[string][]byte{}}
	for name, b64 := range reply.Files {
		if !safeClassPath(name) {
			s.fallbacks.Add(1)
			return nil, fmt.Errorf("%w: unsafe output name %q", ErrUnavailable, name)
		}
		b, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			s.fallbacks.Add(1)
			return nil, fmt.Errorf("%w: bad output %q", ErrUnavailable, name)
		}
		res.Files[name] = b
	}
	s.compiles.Add(1)
	return res, nil
}

// safeClassPath accepts relative .class paths without "..", the only thing the server sends.
func safeClassPath(name string) bool {
	if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "\\") || !strings.HasSuffix(name, ".class") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// connection returns a live server, starting the container and the server if needed. After
// repeated failures it waits before trying again, so a broken image costs one attempt a minute.
func (s *Service) connection(ctx context.Context) (*conn, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil && !s.conn.isDead() {
		return s.conn, nil
	}
	if time.Now().Before(s.retryAfter) {
		return nil, ErrUnavailable
	}
	c, err := s.startLocked(ctx)
	if err != nil {
		s.failures++
		if s.failures >= 3 {
			s.retryAfter = time.Now().Add(time.Minute)
			s.failures = 0
		}
		slog.Warn("compile service: could not start, compiling in sandboxes", "error", err)
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	s.failures = 0
	s.conn = c
	return c, nil
}

// retire stops sending new compiles to c; it closes once its pending ones are answered.
func (s *Service) retire(c *conn) {
	s.mu.Lock()
	if s.conn == c {
		s.conn = nil // the next compile starts a new server in the same container
	}
	s.mu.Unlock()
	c.retireWhenIdle()
}

func (s *Service) dropConn(c *conn, why error) {
	slog.Warn("compile service: dropping the server", "reason", why)
	c.close()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == c {
		s.conn = nil
		// A server that ended (recycled itself) leaves its container usable: the next one
		// starts in it. One that stopped answering may be stuck: start from a fresh container.
		if !errors.Is(why, errServerExited) {
			s.removeContainerLocked()
		}
	}
}

func (s *Service) startLocked(ctx context.Context) (*conn, error) {
	if s.containerID != "" {
		if c, err := s.cli.InspectContainerWithOptions(docker.InspectContainerOptions{ID: s.containerID}); err != nil || !c.State.Running {
			s.removeContainerLocked()
		}
	}
	if s.containerID == "" {
		id, err := s.createContainer(ctx)
		if err != nil {
			return nil, err
		}
		s.containerID = id
	}
	c, err := startServer(ctx, s.cli, s.containerID)
	if err != nil {
		s.removeContainerLocked()
		return nil, err
	}
	s.restarts.Add(1)
	return c, nil
}

func (s *Service) removeContainerLocked() {
	s.compilerImageID = ""
	if s.containerID == "" {
		return
	}
	_ = s.cli.RemoveContainer(docker.RemoveContainerOptions{ID: s.containerID, Force: true})
	s.containerID = ""
}

// Close removes the container (judge shutdown).
func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil {
		s.conn.close()
		s.conn = nil
	}
	s.removeContainerLocked()
}

// createContainer makes the compiler container with a sandbox's restrictions (docker-guard
// checks the same ones) and its own size: JUDGE_COMPILE_SERVICE_CPUS (default 2) and 1.5 GB.
func (s *Service) createContainer(ctx context.Context) (string, error) {
	cpus := envInt("JUDGE_COMPILE_SERVICE_CPUS", 2)
	pids := int64(256)
	mem := int64(1536) << 20
	labels := map[string]string{
		"app":        "code-platform",
		"service":    "judge",
		"managed-by": "judge-service",
		"language":   "java",
		"role":       "compile-service",
	}
	if inst := pool.Instance(); inst != "" {
		labels[pool.InstanceLabelKey] = inst
	}
	ct, err := s.cli.CreateContainer(docker.CreateContainerOptions{
		Context: ctx,
		Config: &docker.Config{
			Image:      s.image,
			Cmd:        []string{"tail", "-f", "/dev/null"},
			WorkingDir: "/tmp",
			User:       "root",
			Labels:     labels,
		},
		HostConfig: &docker.HostConfig{
			NetworkMode:    "none",
			ReadonlyRootfs: true,
			SecurityOpt:    []string{"no-new-privileges:true"},
			CapDrop:        []string{"ALL"},
			Memory:         mem,
			MemorySwap:     mem,
			CPUQuota:       int64(cpus) * 100000,
			PidsLimit:      &pids,
			Init:           true,
			Tmpfs:          map[string]string{"/tmp": "rw,noexec,nosuid,nodev,size=256m,mode=1777"},
		},
	})
	if err != nil {
		return "", fmt.Errorf("creating the compiler container: %w", err)
	}
	if err := s.cli.StartContainer(ct.ID, nil); err != nil {
		_ = s.cli.RemoveContainer(docker.RemoveContainerOptions{ID: ct.ID, Force: true})
		return "", fmt.Errorf("starting the compiler container: %w", err)
	}
	slog.Info("compile service: container started", "containerId", ct.ID, "cpus", cpus)
	return ct.ID, nil
}

// conn is one server process, over the stdin and stdout of a long-lived exec.
type conn struct {
	in  *io.PipeWriter
	cw  docker.CloseWaiter
	wmu sync.Mutex

	mu      sync.Mutex
	nextID  int64
	pending map[int64]chan *reply

	dead      chan struct{}
	deadOnce  sync.Once
	closeOnce sync.Once
	retiring  bool // guarded by mu: close once pending is empty
}

// retireWhenIdle closes the connection (the server then exits) once no request is pending.
func (c *conn) retireWhenIdle() {
	c.mu.Lock()
	c.retiring = true
	idle := len(c.pending) == 0
	c.mu.Unlock()
	if idle {
		c.close()
	}
}

type request struct {
	ID    int64             `json:"id"`
	Files map[string]string `json:"files"`
	Args  []string          `json:"args"`
}

type reply struct {
	ID      int64             `json:"id"`
	Hello   string            `json:"hello"`
	Version int               `json:"version"`
	Exit    int               `json:"exit"`
	Output  string            `json:"output"`
	Files   map[string]string `json:"files"`
	// Retire: the server reached its recycle count. New compiles go to a fresh server; this
	// one is closed once nothing is pending on it.
	Retire       bool  `json:"retire"`
	QueueNanos   int64 `json:"queueNanos"`
	CompileNanos int64 `json:"compileNanos"`
}

func startServer(ctx context.Context, cli *docker.Client, containerID string) (*conn, error) {
	threads := strconv.Itoa(envInt("JUDGE_COMPILE_SERVICE_THREADS", envInt("JUDGE_COMPILE_SERVICE_CPUS", 2)))
	maxCompiles := strconv.Itoa(envInt("JUDGE_COMPILE_SERVICE_RECYCLE", 500))
	timeoutMs := strconv.Itoa(envInt("JUDGE_COMPILE_SERVICE_TIMEOUT_S", 30) * 1000)
	ex, err := cli.CreateExec(docker.CreateExecOptions{
		Container:    containerID,
		User:         "judge",
		WorkingDir:   "/tmp",
		Cmd:          []string{"java", "-Xmx700m", "-XX:+UseSerialGC", "-XX:-UsePerfData", "-cp", serverClasspath, "CompileServer", threads, maxCompiles, timeoutMs},
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		Context:      ctx,
	})
	if err != nil {
		return nil, fmt.Errorf("creating the server exec: %w", err)
	}
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	c := &conn{in: inW, pending: map[int64]chan *reply{}, dead: make(chan struct{})}
	cw, err := cli.StartExecNonBlocking(ex.ID, docker.StartExecOptions{
		InputStream:  inR,
		OutputStream: outW,
		ErrorStream:  &stderrLog{},
		Context:      context.Background(), // outlives the request that started it
	})
	if err != nil {
		_ = inW.Close()
		return nil, fmt.Errorf("starting the server exec: %w", err)
	}
	c.cw = cw
	go func() {
		_ = cw.Wait()
		_ = outW.Close()
		_ = inR.Close()
		c.markDead()
	}()
	hello := make(chan *reply, 1)
	go c.readLoop(bufio.NewReaderSize(outR, 1<<20), hello)
	select {
	case h := <-hello:
		if h == nil || h.Hello != "judge-compile-server" || h.Version != 1 {
			c.close()
			return nil, fmt.Errorf("unexpected hello %+v (no compile server in this image?)", h)
		}
		return c, nil
	case <-time.After(helloTimeout):
		c.close()
		return nil, errors.New("the compile server did not start in time")
	case <-ctx.Done():
		c.close()
		return nil, ctx.Err()
	}
}

func (c *conn) isDead() bool {
	select {
	case <-c.dead:
		return true
	default:
		return false
	}
}

func (c *conn) markDead() {
	c.deadOnce.Do(func() {
		close(c.dead)
		c.mu.Lock()
		defer c.mu.Unlock()
		for id, ch := range c.pending {
			close(ch)
			delete(c.pending, id)
		}
	})
}

// close only does its work once: several failed requests may close the same server, and
// go-dockerclient's CloseWaiter panics when closed a second time.
func (c *conn) close() {
	c.closeOnce.Do(func() {
		_ = c.in.Close()
		if c.cw != nil {
			_ = c.cw.Close()
		}
	})
	c.markDead()
}

func (c *conn) request(ctx context.Context, files map[string]string, args []string, timeout time.Duration) (*reply, error) {
	ch := make(chan *reply, 1)
	c.mu.Lock()
	if c.isDead() {
		c.mu.Unlock()
		return nil, errServerExited
	}
	c.nextID++
	id := c.nextID
	c.pending[id] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		idle := c.retiring && len(c.pending) == 0
		c.mu.Unlock()
		if idle {
			c.close()
		}
	}()

	body, err := json.Marshal(request{ID: id, Files: files, Args: args})
	if err != nil {
		return nil, err
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(body)))
	c.wmu.Lock()
	_, err = c.in.Write(append(hdr[:], body...))
	c.wmu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("sending: %w", err)
	}
	select {
	case r, ok := <-ch:
		if !ok {
			return nil, errServerExited
		}
		return r, nil
	case <-time.After(timeout):
		return nil, fmt.Errorf("no answer within %v", timeout)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *conn) readLoop(r io.Reader, hello chan<- *reply) {
	defer c.markDead()
	first := true
	for {
		var hdr [4]byte
		if _, err := io.ReadFull(r, hdr[:]); err != nil {
			if first {
				hello <- nil
			}
			return
		}
		n := binary.BigEndian.Uint32(hdr[:])
		if n > maxFrame {
			if first {
				hello <- nil
			}
			return
		}
		body := make([]byte, n)
		if _, err := io.ReadFull(r, body); err != nil {
			if first {
				hello <- nil
			}
			return
		}
		var m reply
		if err := json.Unmarshal(body, &m); err != nil {
			if first {
				hello <- nil
			}
			return
		}
		if first {
			first = false
			hello <- &m
			continue
		}
		c.mu.Lock()
		ch := c.pending[m.ID]
		c.mu.Unlock()
		if ch != nil {
			ch <- &m
		}
	}
}

// stderrLog sends the server's own stderr to the judge's log, bounded.
type stderrLog struct{ n int }

func (l *stderrLog) Write(p []byte) (int, error) {
	if l.n < 16<<10 {
		l.n += len(p)
		slog.Warn("compile service stderr", "output", strings.TrimSpace(string(p)))
	}
	return len(p), nil
}

// Compile implements executor.ExternalCompiler for plain javac commands (stdin-mode Java):
// the sources go to the server, the class files come back into hostWorkDir. Anything else,
// or the service being unavailable, is handled=false: the sandbox compiles it as before.
func (s *Service) Compile(ctx context.Context, compileCmd []string, hostWorkDir string, files []string) (bool, []string, int, string) {
	if !Enabled("java") || len(compileCmd) == 0 || compileCmd[0] != "javac" {
		return false, nil, 0, ""
	}
	args, sources, ok := javacArgs(compileCmd)
	if !ok {
		return false, nil, 0, ""
	}
	contents := map[string][]byte{}
	for _, src := range sources {
		name := filepathBase(src)
		if !contains(files, name) {
			return false, nil, 0, "" // a source that is not one of the uploaded files
		}
		b, _, err := workspace.ReadRegularFile(hostWorkDir, name)
		if err != nil {
			return false, nil, 0, ""
		}
		contents[name] = b
	}
	res, err := s.CompileJava(ctx, contents, args)
	if err != nil {
		slog.Warn("compile service: compiling in the sandbox instead", "error", err)
		return false, nil, 0, ""
	}
	if res.Exit != 0 {
		return true, nil, res.Exit, res.Output
	}
	var out []string
	for name, b := range res.Files {
		if dir := filepathDir(name); dir != "" {
			target, err := workspace.SafeJoin(hostWorkDir, dir)
			if err != nil || os.MkdirAll(target, 0o777) != nil {
				return false, nil, 0, ""
			}
		}
		if err := workspace.WriteFile(hostWorkDir, name, b, 0o644); err != nil {
			return false, nil, 0, ""
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return true, out, 0, res.Output
}

// javacArgs splits a javac command into the options the server should use and the source
// files. The JVM options (-J...) are javac's own start-up tuning and do not apply to a warm
// server. Only the options the judge's own javac commands use are accepted.
func javacArgs(cmd []string) (args []string, sources []string, ok bool) {
	for i := 1; i < len(cmd); i++ {
		a := cmd[i]
		switch {
		case strings.HasPrefix(a, "-J"):
		case a == "-cp" || a == "-classpath":
			if i+1 >= len(cmd) {
				return nil, nil, false
			}
			args = append(args, "-cp", cmd[i+1])
			i++
		case strings.HasSuffix(a, ".java") && !strings.HasPrefix(a, "-"):
			sources = append(sources, a)
		default:
			return nil, nil, false // an option we do not expect: leave it to the sandbox
		}
	}
	return args, sources, len(sources) > 0
}

func filepathBase(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

func filepathDir(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[:i]
	}
	return ""
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
