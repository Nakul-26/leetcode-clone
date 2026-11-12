//go:build integration

package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	docker "github.com/fsouza/go-dockerclient"

	"judge-service-go/pkg/executor"
)

// TestResetLeavesNothingBehind checks that nothing a submission writes survives the reset
// between submissions (JUDGE_FIX_PLAN S1). The sandbox user can lock its own files and
// directories (chmod 000) and pooled containers drop every capability, so root in the
// container cannot remove what it cannot open; the reset must still clear all of it, including
// the Go build cache, which a submission could otherwise poison for the next one.
func TestResetLeavesNothingBehind(t *testing.T) {
	// The reset as it wipes at release; TestMergedResetDefersWipe covers merged mode.
	t.Setenv("JUDGE_MERGED_EXECS", "false")
	for _, langID := range []string{"go", "python", "java"} {
		t.Run(langID, func(t *testing.T) {
			exec, p, pc, _ := setupIntegration(t, langID)
			defer p.Release(pc)
			cli := exec.Client()
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()

			// A workspace uploaded the way every submission's is.
			if err := os.WriteFile(filepath.Join(pc.WorkDir, "solution.txt"), []byte("x"), 0644); err != nil {
				t.Fatal(err)
			}
			if err := exec.CopyFiles(ctx, pc.ID, pc.WorkDir, "/app/sub-iso", []string{"solution.txt"}); err != nil {
				t.Fatalf("upload: %v", err)
			}

			plant := `set -e
mkdir -p /tmp/locked/inner /app/sub-iso/locked/inner
echo secret > /tmp/locked/inner/secret
echo secret > /app/sub-iso/locked/inner/secret
echo x > /tmp/plain; echo x > /tmp/.hidden
chmod 000 /tmp/locked/inner/secret /app/sub-iso/locked/inner/secret
chmod 000 /tmp/locked/inner /app/sub-iso/locked/inner
chmod 500 /tmp/locked /app/sub-iso/locked
chmod 000 /app/sub-iso/solution.txt 2>/dev/null || true
if [ -n "$GOCACHE" ]; then mkdir -p "$GOCACHE"; echo poison > "$GOCACHE/planted"; fi`
			if out, code := execAs(t, cli, pc.ID, "judge", plant); code != 0 {
				t.Fatalf("planting files failed (exit %d): %s", code, out)
			}

			if err := exec.ResetContainer(ctx, pc.ID); err != nil {
				t.Fatalf("reset failed: %v", err)
			}

			out, _ := execAs(t, cli, pc.ID, "judge", `find /app /tmp -mindepth 1 2>&1 | grep -v '^/tmp/.cache'; `+
				`[ -n "$GOCACHE" ] && find "$GOCACHE" -name planted; true`)
			if left := strings.TrimSpace(out); left != "" {
				t.Fatalf("files survived the reset:\n%s", left)
			}

			if langID == "go" {
				// The reset re-seeds the build cache, so the next submission still compiles warm.
				out, _ := execAs(t, cli, pc.ID, "judge", `find "$GOCACHE" -type f | wc -l`)
				if n := strings.TrimSpace(out); n == "0" || n == "" {
					t.Fatalf("Go build cache is empty after the reset (%q files)", n)
				}
			}
		})
	}
}

func execAs(t *testing.T, cli *docker.Client, containerID, user, script string) (string, int) {
	t.Helper()
	ex, err := cli.CreateExec(docker.CreateExecOptions{
		Container: containerID, User: user, Cmd: []string{"sh", "-c", script},
		AttachStdout: true, AttachStderr: true,
	})
	if err != nil {
		t.Fatalf("create exec: %v", err)
	}
	var buf bytes.Buffer
	if err := cli.StartExec(ex.ID, docker.StartExecOptions{OutputStream: &buf, ErrorStream: &buf}); err != nil {
		t.Fatalf("start exec: %v", err)
	}
	insp, err := cli.InspectExec(ex.ID)
	if err != nil {
		t.Fatalf("inspect exec: %v", err)
	}
	return buf.String(), insp.ExitCode
}

// TestMergedResetDefersWipe covers the reset in merged mode (JUDGE_MERGED_EXECS, JUDGE_AGENT_PLAN
// Phase 1): the wipe moves to the next submission's first exec, and that exec must still start
// from an empty /app and /tmp, including what the submission locked against removal.
func TestMergedResetDefersWipe(t *testing.T) {
	t.Setenv("JUDGE_MERGED_EXECS", "true")
	exec, p, pc, _ := setupIntegration(t, "python")
	defer p.Release(pc)
	cli := exec.Client()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := os.WriteFile(filepath.Join(pc.WorkDir, "first.txt"), []byte("first"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := exec.CopyFiles(ctx, pc.ID, pc.WorkDir, "/app/sub-a", []string{"first.txt"}); err != nil {
		t.Fatalf("upload: %v", err)
	}
	plant := `set -e
mkdir -p /tmp/locked/inner; echo secret > /tmp/locked/inner/secret
chmod 000 /tmp/locked/inner/secret /tmp/locked/inner; chmod 500 /tmp/locked
echo x > /tmp/.hidden; chmod 000 /app/sub-a/first.txt`
	if out, code := execAs(t, cli, pc.ID, "judge", plant); code != 0 {
		t.Fatalf("planting files failed (exit %d): %s", code, out)
	}
	if err := exec.ResetContainer(ctx, pc.ID); err != nil {
		t.Fatalf("reset failed: %v", err)
	}
	// Deferred: the reset leaves the files for the next use's first exec to remove.
	if out, _ := execAs(t, cli, pc.ID, "judge", `ls -A /tmp`); !strings.Contains(out, "locked") {
		t.Fatalf("expected the wipe to be deferred, /tmp holds: %q", out)
	}

	if err := os.WriteFile(filepath.Join(pc.WorkDir, "second.txt"), []byte("second"), 0644); err != nil {
		t.Fatal(err)
	}
	stream, err := exec.RunInContainerStream(ctx, pc.ID, []string{"second.txt"}, pc.WorkDir, "/app/sub-b", nil,
		[]string{"sh", "-c", `find /app /tmp -mindepth 1 | sort; cat second.txt; echo; echo to-stderr >&2; exit 86`}, 20*time.Second, 0)
	if err != nil {
		t.Fatalf("merged run: %v", err)
	}
	var stdout, stderr bytes.Buffer
	done := make(chan struct{})
	go func() { _, _ = stderr.ReadFrom(stream.Stderr); close(done) }()
	_, _ = stdout.ReadFrom(stream.Stdout)
	<-done
	code, waitErr := stream.Wait()
	want := "/app/sub-b\n/app/sub-b/second.txt\nsecond\n"
	if stdout.String() != want {
		t.Fatalf("the run saw\n%s\nwant\n%s", stdout.String(), want)
	}
	if stderr.String() != "to-stderr\n" {
		t.Fatalf("stderr %q: the prep's output must not reach the program's", stderr.String())
	}
	// The program's own exit 86 is its runtime error, not a failed prep.
	if code != 86 || !errors.Is(waitErr, executor.ErrRuntimeError) {
		t.Fatalf("exit %d err %v, want 86 and a runtime error", code, waitErr)
	}
	if err := exec.ResetContainer(ctx, pc.ID); err != nil {
		t.Fatalf("second reset failed: %v", err)
	}
}

// TestMergedResetWipesLargeLeftoversAtOnce: a submission that leaves a lot behind is wiped at
// release, so it cannot starve or slow down the next submission's start.
func TestMergedResetWipesLargeLeftoversAtOnce(t *testing.T) {
	t.Setenv("JUDGE_MERGED_EXECS", "true")
	exec, p, pc, _ := setupIntegration(t, "python")
	defer p.Release(pc)
	cli := exec.Client()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	for name, script := range map[string]string{
		"bytes":  `head -c 12000000 /dev/zero > /tmp/big`,
		"inodes": `mkdir /tmp/many && cd /tmp/many && i=0; while [ $i -lt 700 ]; do : > f$i; i=$((i+1)); done`,
	} {
		if out, code := execAs(t, cli, pc.ID, "judge", script); code != 0 {
			t.Fatalf("%s: planting failed (exit %d): %s", name, code, out)
		}
		if err := exec.ResetContainer(ctx, pc.ID); err != nil {
			t.Fatalf("%s: reset failed: %v", name, err)
		}
		if out, _ := execAs(t, cli, pc.ID, "judge", `find /app /tmp -mindepth 1`); strings.TrimSpace(out) != "" {
			t.Fatalf("%s: left for the next submission:\n%s", name, out)
		}
	}
}

// TestMergedWipeFailureDiscards: when the deferred wipe cannot clear the container, the program
// does not run, the error marks the container unhealthy, and the next reset refuses it.
func TestMergedWipeFailureDiscards(t *testing.T) {
	t.Setenv("JUDGE_MERGED_EXECS", "true")
	exec, p, pc, _ := setupIntegration(t, "python")
	defer p.Release(pc)
	cli := exec.Client()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	if err := exec.ResetContainer(ctx, pc.ID); err != nil { // leaves an (empty) wipe pending
		t.Fatalf("reset failed: %v", err)
	}
	// A root-owned file in sticky /tmp: the judge user cannot remove it.
	if out, code := execAs(t, cli, pc.ID, "root", `echo x > /tmp/rootfile`); code != 0 {
		t.Fatalf("planting failed (exit %d): %s", code, out)
	}
	if err := os.WriteFile(filepath.Join(pc.WorkDir, "prog.txt"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	stdout, _, err := exec.RunInContainer(ctx, pc.ID, []string{"prog.txt"}, pc.WorkDir, "/app/sub-c", nil,
		[]string{"sh", "-c", "echo ran"}, 20*time.Second, 0)
	if !errors.Is(err, executor.ErrContainerUnhealthy) || !executor.IsContainerLost(err) {
		t.Fatalf("err = %v, want an unhealthy container", err)
	}
	if strings.Contains(stdout, "ran") {
		t.Fatal("the program ran although the wipe failed")
	}
	if err := exec.ResetContainer(ctx, pc.ID); err == nil {
		t.Fatal("the reset accepted a container whose wipe failed")
	}
}
