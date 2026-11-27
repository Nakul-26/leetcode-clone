package executor

import (
	"archive/tar"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func tarOf(t *testing.T, entries ...tar.Header) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, h := range entries {
		h := h
		if h.Typeflag == tar.TypeReg {
			h.Size = 1
		}
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			_, _ = tw.Write([]byte("x"))
		}
	}
	_ = tw.Close()
	return buf.Bytes()
}

func TestValidateCacheTar(t *testing.T) {
	ok := tarOf(t,
		tar.Header{Name: "./", Typeflag: tar.TypeDir, Mode: 0o755},
		tar.Header{Name: "./main", Typeflag: tar.TypeReg, Mode: 0o755},
		tar.Header{Name: "./out/", Typeflag: tar.TypeDir, Mode: 0o755},
		tar.Header{Name: "./out/Main.class", Typeflag: tar.TypeReg, Mode: 0o644},
	)
	if err := validateCacheTar(ok); err != nil {
		t.Fatalf("a normal compiled workspace was refused: %v", err)
	}
	bad := map[string]tar.Header{
		"symlink":   {Name: "./main", Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"},
		"hardlink":  {Name: "./main", Typeflag: tar.TypeLink, Linkname: "/etc/passwd"},
		"dotdot":    {Name: "../escape", Typeflag: tar.TypeReg},
		"dotdot2":   {Name: "./a/../../escape", Typeflag: tar.TypeReg},
		"absolute":  {Name: "/etc/cron.d/x", Typeflag: tar.TypeReg},
		"device":    {Name: "./dev", Typeflag: tar.TypeChar},
		"fifo":      {Name: "./fifo", Typeflag: tar.TypeFifo},
		"backslash": {Name: "./a\\b", Typeflag: tar.TypeReg},
	}
	for name, h := range bad {
		if err := validateCacheTar(tarOf(t, h)); err == nil {
			t.Errorf("%s: an unsafe entry was accepted", name)
		}
	}
	if err := validateCacheTar([]byte("not a tar at all, just some bytes that are long enough")); err == nil {
		t.Error("garbage was accepted")
	}
}

func TestCompileCacheOffByDefault(t *testing.T) {
	t.Setenv("JUDGE_COMPILE_CACHE_MB", "")
	if newCompileCacheFromEnv() != nil {
		t.Fatal("the cache is on without JUDGE_COMPILE_CACHE_MB")
	}
	t.Setenv("JUDGE_COMPILE_CACHE_MB", "0")
	if newCompileCacheFromEnv() != nil {
		t.Fatal("JUDGE_COMPILE_CACHE_MB=0 should be off")
	}
	e := &Executor{}
	if _, ok := e.compileKey("c", t.TempDir(), []string{"a"}, []string{"g++"}); ok {
		t.Fatal("a key without a cache")
	}
}

func TestCompileCacheLRU(t *testing.T) {
	t.Setenv("JUDGE_COMPILE_CACHE_MB", "1")
	c := newCompileCacheFromEnv()
	c.max = 10 // bytes, for the test
	c.put("a", []byte("1234"))
	c.put("b", []byte("1234"))
	if _, ok := c.get("a"); !ok { // a is now the most recent
		t.Fatal("a missing")
	}
	c.put("c", []byte("1234")) // over 10 bytes: the least recent (b) goes
	if _, ok := c.get("b"); ok {
		t.Fatal("b should have been evicted")
	}
	if _, ok := c.get("a"); !ok {
		t.Fatal("a was evicted although recently used")
	}
	if _, ok := c.get("c"); !ok {
		t.Fatal("c missing")
	}
	c.put("huge", make([]byte, 11)) // larger than the whole cache: not kept
	if _, ok := c.get("huge"); ok {
		t.Fatal("an entry larger than the cache was kept")
	}
	if c.size > c.max {
		t.Fatalf("size %d over max %d", c.size, c.max)
	}
}

func TestCompileKey(t *testing.T) {
	t.Setenv("JUDGE_COMPILE_CACHE_MB", "16")
	e := &Executor{cc: newCompileCacheFromEnv()}
	e.imageIDs.Store("c1", "sha256:aaa")
	e.imageIDs.Store("c2", "sha256:bbb")
	dir := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("main.cpp", "int main(){}")
	write("prelude.h", "")
	cmd := []string{"sh", "-c", "g++ -O2 -o main main.cpp"}
	key := func(container string, files []string, cmd []string) string {
		k, ok := e.compileKey(container, dir, files, cmd)
		if !ok {
			t.Fatal("no key")
		}
		return k
	}
	base := key("c1", []string{"main.cpp", "prelude.h"}, cmd)
	if key("c1", []string{"prelude.h", "main.cpp"}, cmd) != base {
		t.Error("file order changed the key")
	}
	if key("c2", []string{"main.cpp", "prelude.h"}, cmd) == base {
		t.Error("another image (compiler) gave the same key")
	}
	if key("c1", []string{"main.cpp", "prelude.h"}, []string{"sh", "-c", "g++ -O0 -o main main.cpp"}) == base {
		t.Error("another compile command gave the same key")
	}
	write("prelude.h", "#include <cstdio>")
	if key("c1", []string{"main.cpp", "prelude.h"}, cmd) == base {
		t.Error("a changed prelude.h gave the same key")
	}
	write("prelude.h", "")
	write("main.cpp", "int main(){ }")
	if key("c1", []string{"main.cpp", "prelude.h"}, cmd) == base {
		t.Error("changed source gave the same key")
	}
	// The same bytes split differently across files must not collide.
	write("a", "xy")
	write("b", "z")
	k1 := key("c1", []string{"a", "b"}, cmd)
	write("a", "x")
	write("b", "yz")
	if key("c1", []string{"a", "b"}, cmd) == k1 {
		t.Error("contents moved between files gave the same key")
	}
	if _, ok := e.compileKey("c1", dir, []string{"missing"}, cmd); ok {
		t.Error("a key for a file that does not exist")
	}
	_ = strings.TrimSpace
}
