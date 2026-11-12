package executor

import (
	"bytes"
	"testing"
)

func TestPrepFilterDropsPrepOutput(t *testing.T) {
	// The marker split across writes, prep noise before it, the command's output after it.
	in := append([]byte("tar: warning\n"), prepMarker...)
	in = append(in, []byte("program stderr")...)
	for split := 1; split < len(in); split++ {
		var out bytes.Buffer
		f := &prepFilter{dst: &out}
		if _, err := f.Write(in[:split]); err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write(in[split:]); err != nil {
			t.Fatal(err)
		}
		done, noise := f.result()
		if !done || out.String() != "program stderr" || noise != "tar: warning\n" {
			t.Fatalf("split %d: done=%v out=%q noise=%q", split, done, out.String(), noise)
		}
	}
}

func TestPrepFilterWithoutMarker(t *testing.T) {
	var out bytes.Buffer
	f := &prepFilter{dst: &out}
	_, _ = f.Write([]byte("not removed by the reset: /tmp/x"))
	done, noise := f.result()
	if done || out.Len() != 0 || noise != "not removed by the reset: /tmp/x" {
		t.Fatalf("done=%v out=%q noise=%q", done, out.String(), noise)
	}
}

func TestPrepFilterPassesMarkerTextAfterMarker(t *testing.T) {
	// A program printing the marker itself changes nothing: only the first one counts.
	var out bytes.Buffer
	f := &prepFilter{dst: &out}
	_, _ = f.Write(prepMarker)
	_, _ = f.Write(prepMarker)
	if done, _ := f.result(); !done || !bytes.Equal(out.Bytes(), prepMarker) {
		t.Fatalf("done=%v out=%q", done, out.String())
	}
}

func TestParseUsage(t *testing.T) {
	coreutils := `judge-df-k
Filesystem     1024-blocks  Used Available Capacity Mounted on
tmpfs              1048576    12   1048564       1% /app
tmpfs               524288   100    524188       1% /tmp
judge-df-i
Filesystem      Inodes IUsed   IFree IUse% Mounted on
tmpfs          2032742     5 2032737    1% /app
tmpfs          2032742     3 2032739    1% /tmp
`
	kb, inodes, ok := parseUsage(coreutils)
	if !ok || kb != 112 || inodes != 8 {
		t.Fatalf("got kb=%d inodes=%d ok=%v", kb, inodes, ok)
	}
	if _, _, ok := parseUsage("judge-df-k\nFilesystem 1024-blocks Used Available Capacity Mounted on\ntmpfs 1 1 0 1% /app\njudge-df-i\ndf: unrecognized option: i\n"); ok {
		t.Fatal("a missing inode table must not parse")
	}
	if _, _, ok := parseUsage(""); ok {
		t.Fatal("empty output must not parse")
	}
}
