package executor

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
)

// Merged execs (JUDGE_AGENT_PLAN Phase 1). In merged mode a judge-user exec can carry two
// steps ahead of its own command, each of which used to be an exec of its own:
//
//   - the wipe the previous submission's reset left pending (see resetDeferred), and
//   - the upload of this submission's files, as a tar on the exec's stdin.
//
// Both run in a shell before the command, which they then exec into. The student's code
// starts only after both succeeded, so it never sees a previous submission's files. When
// they have, the shell writes prepMarker to stderr; everything the prep steps print comes
// before it and is kept out of the command's output (prepFilter). An exec that ends without
// the marker failed in the prep, never in the student's code, so its exit code cannot be
// confused with the program's: the container is marked broken and discarded on release.

// prepMarker ends the prep steps' output on stderr.
var prepMarker = []byte("\x1ejudge-prep-ok\x1e")

// prepScript runs as `sh -c prepScript judge-prep <wipe> <upload> <workdir> <cmd...>`.
// The prep steps' stdout goes to stderr so that the command's stdout is its own.
const prepScript = `exec 3>&1 1>&2
wipe=$1; upload=$2; wd=$3; shift 3
if [ "$wipe" = 1 ]; then ( ` + containerWipeCmds + ` ) || exit 1; fi
if [ "$upload" = 1 ]; then mkdir -p "$wd" && tar -xf - -C "$wd" && chmod -R 0777 "$wd" || exit 1; fi
cd "$wd" || exit 1
printf '\036judge-prep-ok\036' >&2
exec 1>&3 3>&-
if [ "$upload" = 1 ]; then exec "$@" </dev/null; fi
exec "$@"`

// prep is one exec's prep steps, from beginPrep to endPrep.
type prep struct {
	wipe   bool
	filter *prepFilter
}

// beginPrep decides whether an exec carries prep steps and, if so, returns the command and
// working directory to run instead. upload is a workspace tar (buildWorkspaceTar) or nil; it
// must be sent on the exec's stdin, which the command then does not get. A nil prep means
// the exec runs unchanged.
func (e *Executor) beginPrep(ctx context.Context, containerID, user, workDir string, cmd []string, upload []byte) (*prep, []string, string, error) {
	if reason, ok := e.broken.Load(containerID); ok {
		return nil, nil, "", containerBrokenError(fmt.Sprint(reason))
	}
	// Only merged mode leaves wipes pending or passes an upload.
	if user != getJudgeUser() {
		return nil, cmd, workDir, nil
	}
	_, wipe := e.wipePending.Load(containerID)
	if !wipe && upload == nil {
		return nil, cmd, workDir, nil
	}
	if _, stale := e.staleLimit.Load(containerID); stale {
		// The submission before left its limit and this one set none: restore the default
		// the reset used to.
		if err := e.UpdateContainerResources(ctx, containerID, defaultMemoryMb); err != nil {
			return nil, nil, "", err
		}
	}
	flag := func(b bool) string {
		if b {
			return "1"
		}
		return "0"
	}
	wrapped := append([]string{"sh", "-c", prepScript, "judge-prep", flag(wipe), flag(upload != nil), workDir}, cmd...)
	return &prep{wipe: wipe}, wrapped, "/", nil
}

// stderr returns the writer the exec's stderr goes to: dst, minus the prep steps' output.
func (p *prep) stderr(dst io.Writer) io.Writer {
	if p == nil {
		return dst
	}
	p.filter = &prepFilter{dst: dst}
	return p.filter
}

// endPrep settles an exec that carried prep steps, once its output has all been written. If
// the prep finished, the wipe is no longer pending and err is the command's own. If not, the
// container is marked broken and the error says so; the student's code never ran.
func (e *Executor) endPrep(containerID string, p *prep, err error) error {
	if p == nil {
		return err
	}
	done, noise := p.filter.result()
	if done {
		if p.wipe {
			e.wipePending.Delete(containerID)
		}
		return err
	}
	reason := "judge prep failed"
	if err != nil {
		reason += ": " + err.Error()
	}
	if noise = strings.TrimSpace(noise); noise != "" {
		reason += " (" + noise + ")"
	}
	e.broken.Store(containerID, reason)
	return containerBrokenError(reason)
}

// containerBrokenError is ContainerLost so that the runners stop at once, and
// ErrContainerUnhealthy so that the container is discarded (isPoisonousExecutionError).
func containerBrokenError(reason string) error {
	return &ExecutionError{Type: ErrContainerUnhealthy, Message: reason, ExitCode: -1, ContainerLost: true}
}

// prepFilterNoiseLimit bounds the prep output kept for an error message.
const prepFilterNoiseLimit = 4 << 10

// prepFilter passes stderr through to dst only after prepMarker; what comes before it is the
// prep steps' own output, kept (bounded) for an error message.
type prepFilter struct {
	dst     io.Writer
	mu      sync.Mutex
	done    bool
	pending []byte // may hold the start of a marker split across writes
	noise   bytes.Buffer
}

func (f *prepFilter) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.done {
		return f.dst.Write(p)
	}
	f.pending = append(f.pending, p...)
	if i := bytes.Index(f.pending, prepMarker); i >= 0 {
		f.keepNoise(f.pending[:i])
		rest := f.pending[i+len(prepMarker):]
		f.pending, f.done = nil, true
		if len(rest) > 0 {
			if _, err := f.dst.Write(rest); err != nil {
				return 0, err
			}
		}
		return len(p), nil
	}
	if keep := len(prepMarker) - 1; len(f.pending) > keep {
		f.keepNoise(f.pending[:len(f.pending)-keep])
		f.pending = append([]byte(nil), f.pending[len(f.pending)-keep:]...)
	}
	return len(p), nil
}

func (f *prepFilter) keepNoise(b []byte) {
	if room := prepFilterNoiseLimit - f.noise.Len(); room > 0 {
		if len(b) > room {
			b = b[:room]
		}
		f.noise.Write(b)
	}
}

func (f *prepFilter) result() (bool, string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.done {
		f.keepNoise(f.pending)
		f.pending = nil
	}
	return f.done, f.noise.String()
}
