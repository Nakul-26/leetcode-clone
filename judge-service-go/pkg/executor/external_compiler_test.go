package executor

import (
	"archive/tar"
	"context"
	"os"
	"path/filepath"
	"testing"

	"judge-service-go/pkg/workspace"
)

type cacheTestCompiler struct {
	calls       int
	image       string
	exit        int
	changeImage bool
}

func (c *cacheTestCompiler) CacheIdentity() (string, error) { return c.image, nil }
func (c *cacheTestCompiler) Compile(_ context.Context, _ []string, dir string, _ []string) (bool, []string, int, string) {
	c.calls++
	if c.changeImage {
		c.image = "sha256:restarted"
		c.changeImage = false
	}
	if c.exit != 0 {
		return true, nil, c.exit, "invalid source"
	}
	if err := workspace.WriteFile(dir, "Main.class", []byte("bytecode"), 0o644); err != nil {
		panic(err)
	}
	return true, []string{"Main.class"}, 0, "compiler warning"
}

func TestExternalCachePreservesDiagnosticsAndCompilerIdentity(t *testing.T) {
	t.Setenv("JUDGE_COMPILE_CACHE_MB", "1")
	c := &cacheTestCompiler{image: "sha256:compiler-a"}
	e := &Executor{cc: newCompileCacheFromEnv(), ext: c}
	e.imageIDs.Store("sandbox", "sha256:runtime")
	call := func(source string, cmd []string) {
		t.Helper()
		dir := t.TempDir()
		if err := workspace.WriteFile(dir, "Main.java", []byte(source), 0o644); err != nil {
			t.Fatal(err)
		}
		handled, files, output, err := e.compileExternally(context.Background(), "sandbox", cmd, dir, []string{"Main.java"})
		if !handled || err != nil || len(files) != 1 || output != "compiler warning" {
			t.Fatalf("handled=%v files=%v output=%q err=%v", handled, files, output, err)
		}
		b, err := os.ReadFile(filepath.Join(dir, "Main.class"))
		if err != nil || string(b) != "bytecode" {
			t.Fatalf("restored artifact %q, %v", b, err)
		}
	}
	cmd := []string{"javac", "Main.java"}
	call("class Main {}", cmd)
	call("class Main {}", cmd)
	if c.calls != 1 {
		t.Fatalf("identical source compiled %d times", c.calls)
	}
	call("class Main { }", cmd)
	call("class Main {}", []string{"javac", "-g", "Main.java"})
	c.image = "sha256:compiler-b"
	call("class Main {}", cmd)
	if c.calls != 4 {
		t.Fatalf("changed source/options/compiler did not invalidate cache: %d", c.calls)
	}
	c.exit = 1
	for i := 0; i < 2; i++ {
		dir := t.TempDir()
		_ = workspace.WriteFile(dir, "Main.java", []byte("broken"), 0o644)
		if _, _, _, err := e.compileExternally(context.Background(), "sandbox", cmd, dir, []string{"Main.java"}); err == nil {
			t.Fatal("compile failure swallowed")
		}
	}
	if c.calls != 6 {
		t.Fatal("failed compilation was cached")
	}
}

func TestExternalCacheRejectsUnsafeArtifacts(t *testing.T) {
	for _, h := range []tar.Header{
		{Name: "../escape.class", Typeflag: tar.TypeReg},
		{Name: "Main.class", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"},
		{Name: "source.java", Typeflag: tar.TypeReg},
	} {
		if _, err := restoreExternalFiles(t.TempDir(), tarOf(t, h)); err == nil {
			t.Fatalf("accepted unsafe artifact %+v", h)
		}
	}
}

func TestExternalCacheDoesNotMislabelRestartedCompiler(t *testing.T) {
	t.Setenv("JUDGE_COMPILE_CACHE_MB", "1")
	c := &cacheTestCompiler{image: "sha256:original", changeImage: true}
	e := &Executor{cc: newCompileCacheFromEnv(), ext: c}
	e.imageIDs.Store("sandbox", "sha256:runtime")
	dir := t.TempDir()
	if err := workspace.WriteFile(dir, "Main.java", []byte("class Main {}"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, _, err := e.compileExternally(context.Background(), "sandbox", []string{"javac", "Main.java"}, dir, []string{"Main.java"})
	if err != nil {
		t.Fatal(err)
	}
	if e.cc.stored.Load() != 0 {
		t.Fatal("stored artifacts under the compiler identity from before the restart")
	}
}
