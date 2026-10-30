//go:build integration

package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	docker "github.com/fsouza/go-dockerclient"
)

// TestResetLeavesNothingBehind checks that nothing a submission writes survives the reset
// between submissions (JUDGE_FIX_PLAN S1). The sandbox user can lock its own files and
// directories (chmod 000) and pooled containers drop every capability, so root in the
// container cannot remove what it cannot open; the reset must still clear all of it, including
// the Go build cache, which a submission could otherwise poison for the next one.
func TestResetLeavesNothingBehind(t *testing.T) {
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
