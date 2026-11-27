package agentproto

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	in := []*Msg{
		{Op: OpExec, ID: 7, Cmd: []string{"sh", "-c", "echo hi"}, Dir: "/app/x", HasStdin: true, Stdin: []byte{0, 1, 2, 0xff}},
		{Op: OpOut, ID: 7, Data: []byte("hello\n")},
		{Op: OpExit, ID: 7, Code: 137},
		{Op: OpHello, Version: Version, Pid: 42, Role: "runner"},
	}
	for _, m := range in {
		if err := Write(&buf, m); err != nil {
			t.Fatal(err)
		}
	}
	for i, want := range in {
		got, err := Read(&buf)
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if got.Op != want.Op || got.ID != want.ID || got.Code != want.Code || !bytes.Equal(got.Stdin, want.Stdin) ||
			!bytes.Equal(got.Data, want.Data) || got.Pid != want.Pid || len(got.Cmd) != len(want.Cmd) {
			t.Fatalf("frame %d: got %+v, want %+v", i, got, want)
		}
	}
	if _, err := Read(&buf); !errors.Is(err, io.EOF) {
		t.Fatalf("after the last frame: %v, want io.EOF", err)
	}
}

func TestReadRejectsHugeFrame(t *testing.T) {
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], MaxFrame+1)
	if _, err := Read(bytes.NewReader(hdr[:])); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("got %v, want ErrFrameTooLarge", err)
	}
}

func TestReadTruncatedFrame(t *testing.T) {
	var buf bytes.Buffer
	_ = Write(&buf, &Msg{Op: OpPing})
	b := buf.Bytes()[:buf.Len()-2]
	if _, err := Read(bytes.NewReader(b)); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("got %v, want io.ErrUnexpectedEOF", err)
	}
}
