package executor

import (
	"archive/tar"
	"bytes"
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	docker "github.com/fsouza/go-dockerclient"

	"judge-service-go/pkg/workspace"
)

// The compile cache (JUDGE_COMPILE_CACHE_MB). In stdin mode a student usually runs the same
// program several times with different input and then submits it, and every one of those
// compiled it again: 0.2-0.5 s of CPU for C++, Java, Rust or C#, 2.7 s for Kotlin. The cache
// keeps what a successful compile left in the workspace, keyed by everything that decides it,
// and a later compile of the same code with the same compiler gets those files instead.
//
//   - Key: SHA-256 of the container's image ID (the exact compiler build), the compile command
//     and every source file's name and content. Only byte-identical code hits.
//   - What is kept: the workspace as a tar, taken right after a successful compile and before
//     anything of the submission has run, in a sandbox that was wiped first. None of the
//     compilers run submitted code while compiling (no annotation processors, proc macros or
//     build scripts), so the files are exactly what compiling that source produces. A failed
//     compile is never kept.
//   - Checked before it is kept: regular files and directories only, relative names without
//     "..", at most compileCacheEntryMax bytes.
//   - Compiles faster than compileCacheMinDuration are not kept: reading the files back costs
//     about as much.
//
// In memory, per judge, least recently used first out. 0 (the default) turns it off.

const (
	compileCacheEntryMax    = 64 << 20
	compileCacheMinDuration = 150 * time.Millisecond
)

type compileCache struct {
	mu   sync.Mutex
	max  int64
	size int64
	ll   *list.List
	m    map[string]*list.Element

	hits, misses, stored atomic.Int64
}

type compileCacheEntry struct {
	key    string
	tar    []byte
	output string // successful compiler diagnostics, preserved on external-cache hits
}

// newCompileCacheFromEnv reads JUDGE_COMPILE_CACHE_MB; nil means off.
func newCompileCacheFromEnv() *compileCache {
	mb, err := strconv.Atoi(strings.TrimSpace(os.Getenv("JUDGE_COMPILE_CACHE_MB")))
	if err != nil || mb <= 0 {
		return nil
	}
	slog.Info("compile cache on", "maxMb", mb)
	return &compileCache{max: int64(mb) << 20, ll: list.New(), m: map[string]*list.Element{}}
}

func (c *compileCache) get(key string) ([]byte, bool) {
	data, _, ok := c.getWithOutput(key)
	return data, ok
}

func (c *compileCache) getWithOutput(key string) ([]byte, string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	el, ok := c.m[key]
	if !ok {
		return nil, "", false
	}
	c.ll.MoveToFront(el)
	e := el.Value.(*compileCacheEntry)
	return e.tar, e.output, true
}

func (c *compileCache) put(key string, data []byte) {
	c.putWithOutput(key, data, "")
}

func (c *compileCache) putWithOutput(key string, data []byte, output string) {
	if int64(len(data)+len(output)) > c.max {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.m[key]; ok {
		c.ll.MoveToFront(el)
		return
	}
	c.m[key] = c.ll.PushFront(&compileCacheEntry{key: key, tar: data, output: output})
	c.size += int64(len(data) + len(output))
	for c.size > c.max {
		old := c.ll.Back()
		e := old.Value.(*compileCacheEntry)
		c.ll.Remove(old)
		delete(c.m, e.key)
		c.size -= int64(len(e.tar) + len(e.output))
	}
	c.stored.Add(1)
}

// CompileCacheStats reports hits, misses and entries stored since start (all 0 when off).
func (e *Executor) CompileCacheStats() (hits, misses, stored int64) {
	if e.cc == nil {
		return 0, 0, 0
	}
	return e.cc.hits.Load(), e.cc.misses.Load(), e.cc.stored.Load()
}

// imageID is the ID of the image a container runs, looked up once per container.
func (e *Executor) imageID(containerID string) (string, error) {
	if v, ok := e.imageIDs.Load(containerID); ok {
		return v.(string), nil
	}
	start := time.Now()
	c, err := e.cli.InspectContainerWithOptions(docker.InspectContainerOptions{ID: containerID})
	recordSince("inspect", start)
	if err != nil {
		return "", err
	}
	if c.Image == "" {
		return "", errors.New("container has no image ID")
	}
	e.imageIDs.Store(containerID, c.Image)
	return c.Image, nil
}

// compileKey hashes what decides a compile's result. ok is false when the cache is off or the
// inputs cannot be read (the compile then runs as usual).
func (e *Executor) compileKey(containerID, hostWorkDir string, files, compileCmd []string) (string, bool) {
	if e.cc == nil || len(compileCmd) == 0 || len(files) == 0 {
		return "", false
	}
	img, err := e.imageID(containerID)
	if err != nil {
		return "", false
	}
	h := sha256.New()
	fmt.Fprintf(h, "judge-compile-cache-v1\x00%s\x00", img)
	for _, part := range compileCmd {
		fmt.Fprintf(h, "%d:%s\x00", len(part), part)
	}
	names := append([]string(nil), files...)
	sort.Strings(names)
	for _, name := range names {
		data, _, err := workspace.ReadRegularFile(hostWorkDir, name)
		if err != nil {
			return "", false
		}
		fmt.Fprintf(h, "%d:%s\x00%d:", len(name), name, len(data))
		h.Write(data)
	}
	return hex.EncodeToString(h.Sum(nil)), true
}

// restoreCompiled puts a cached compile's files into the workspace. ok is false on a miss, or
// if the upload failed (the caller then compiles as usual).
func (e *Executor) restoreCompiled(ctx context.Context, containerID, containerWorkDir, key string) bool {
	data, ok := e.cc.get(key)
	if !ok {
		e.cc.misses.Add(1)
		return false
	}
	if err := e.uploadTar(ctx, containerID, containerWorkDir, data); err != nil {
		slog.Warn("compile cache: restore failed, compiling", "containerId", containerID, "error", err)
		e.cc.misses.Add(1)
		return false
	}
	e.cc.hits.Add(1)
	return true
}

// keepCompiled reads the workspace after a successful compile and keeps it.
func (e *Executor) keepCompiled(ctx context.Context, containerID, containerWorkDir, key string, took time.Duration) {
	if took < compileCacheMinDuration {
		return
	}
	out, stderr, err := e.runExecCapture(ctx, containerID, getJudgeUser(), containerWorkDir, []string{"tar", "-cf", "-", "."}, 20*time.Second, compileCacheEntryMax)
	if err != nil {
		slog.Warn("compile cache: could not read the compiled workspace", "containerId", containerID, "error", err, "stderr", stderr)
		return
	}
	if err := validateCacheTar(out); err != nil {
		slog.Warn("compile cache: not kept", "containerId", containerID, "reason", err)
		return
	}
	e.cc.put(key, out)
}

// validateCacheTar accepts only regular files and directories with clean relative names.
func validateCacheTar(data []byte) error {
	tr := tar.NewReader(bytes.NewReader(data))
	n := 0
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("bad tar: %w", err)
		}
		n++
		name := strings.TrimPrefix(h.Name, "./")
		if name == "" || name == "." {
			if h.Typeflag != tar.TypeDir {
				return errors.New("root entry is not a directory")
			}
			continue
		}
		clean := path.Clean(name)
		if path.IsAbs(name) || clean == ".." || strings.HasPrefix(clean, "../") || strings.Contains(name, "\\") {
			return fmt.Errorf("unsafe name %q", h.Name)
		}
		switch h.Typeflag {
		case tar.TypeReg, tar.TypeDir:
		default:
			return fmt.Errorf("%q is not a regular file or directory (type %q)", h.Name, h.Typeflag)
		}
	}
	if n == 0 {
		return errors.New("empty")
	}
	return nil
}

// runExecCapture runs cmd and returns its stdout as bytes, up to limit; more than that is an
// error rather than a silently cut result. For reading a compiled workspace (a Go or Rust
// binary is well over runExecWithTimeout's 1 MB cap).
func (e *Executor) runExecCapture(ctx context.Context, containerID, user, workDir string, cmd []string, timeout time.Duration, limit int) ([]byte, string, error) {
	if reason, ok := e.broken.Load(containerID); ok {
		return nil, "", containerBrokenError(fmt.Sprint(reason))
	}
	stdoutBuf := &boundedWriter{limit: limit}
	stderrBuf := &boundedWriter{limit: 64 << 10}
	ex, err := e.createExec(docker.CreateExecOptions{
		Container: containerID, User: user, Cmd: cmd, WorkingDir: workDir,
		AttachStdout: true, AttachStderr: true, Context: ctx,
	})
	if err != nil {
		return nil, "", fmt.Errorf("failed to create exec: %w", err)
	}
	childCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cw, err := e.startExec(ex.ID, docker.StartExecOptions{OutputStream: stdoutBuf, ErrorStream: stderrBuf, Context: childCtx})
	if err != nil {
		return nil, "", fmt.Errorf("failed to start exec: %w", err)
	}
	// Closed after the inspect below: with the sandbox agent, closing drops what inspect reads.
	defer cw.Close()
	done := make(chan error, 1)
	go func() { done <- cw.Wait() }()
	select {
	case err = <-done:
	case <-childCtx.Done():
		_ = cw.Close()
		<-done
		return nil, stderrBuf.String(), fmt.Errorf("timed out after %v", timeout)
	}
	if err != nil {
		return nil, stderrBuf.String(), err
	}
	inspect, err := e.inspectExec(ex.ID)
	if err != nil {
		return nil, stderrBuf.String(), fmt.Errorf("failed to inspect exec: %w", err)
	}
	if inspect.ExitCode != 0 {
		return nil, stderrBuf.String(), fmt.Errorf("exit code %d", inspect.ExitCode)
	}
	if stdoutBuf.total > limit {
		return nil, stderrBuf.String(), fmt.Errorf("output over %d bytes", limit)
	}
	return stdoutBuf.buf.Bytes(), stderrBuf.String(), nil
}
