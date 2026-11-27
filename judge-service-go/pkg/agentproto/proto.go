// Package agentproto is the wire format between the judge (pkg/executor) and judge-agent, the
// resident process inside each sandbox (cmd/judge-agent, JUDGE_AGENT_PLAN Phase 2). It has no
// dependencies outside the standard library, so the agent stays a small static binary.
//
// A frame is a 4-byte big-endian length followed by that many bytes of JSON (one Msg). Each
// side writes frames on its stdout and reads them on its stdin; the judge's end of both is one
// long-lived `docker exec`.
package agentproto

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Version changes whenever the protocol does; the judge refuses an agent of another version and
// falls back to plain execs for that container.
const Version = "1"

// MaxFrame bounds one frame. The largest are exec requests carrying a workspace tar or a
// program's stdin; output travels in chunks of at most ChunkSize.
const MaxFrame = 128 << 20

// ChunkSize is the most output one "out"/"err" frame carries.
const ChunkSize = 32 << 10

// Ops. Requests go judge -> agent, the rest agent -> judge.
const (
	// Requests.
	OpExec      = "exec"      // run Cmd in Dir with Stdin; replies started, out/err..., exit
	OpCancel    = "cancel"    // kill the process group of exec ID
	OpPing      = "ping"      // runner: report whether its state is still untouched; replies pong
	OpRegister  = "register"  // keeper: Pid is the runner, to be spared by killjudge; replies done
	OpKillJudge = "killjudge" // keeper: kill every judge-user process (sparing the runner if Spare); replies done

	// Replies and events.
	OpHello   = "hello"   // first frame from an agent: Version, Pid, Role
	OpStarted = "started" // exec ID is running (or, with Code set and Err, failed to start)
	OpOut     = "out"     // stdout bytes of exec ID
	OpErr     = "err"     // stderr bytes of exec ID
	OpExit    = "exit"    // exec ID ended with Code; nothing more follows for it
	OpPong    = "pong"    // reply to ping; Err is set if the runner was tampered with
	OpDone    = "done"    // reply to register/killjudge; Code 0 = success, Err says why not
)

// Msg is every frame's body. Fields not used by an op are left empty.
type Msg struct {
	Op  string `json:"op"`
	ID  uint64 `json:"id,omitempty"`
	Seq uint64 `json:"seq,omitempty"` // matches a ping/register/killjudge reply to its request

	// exec
	Cmd      []string `json:"cmd,omitempty"`
	Dir      string   `json:"dir,omitempty"`
	HasStdin bool     `json:"hasStdin,omitempty"`
	Stdin    []byte   `json:"stdin,omitempty"`

	// out / err
	Data []byte `json:"data,omitempty"`

	// started / exit / done / pong
	Code int    `json:"code"`
	Err  string `json:"err,omitempty"`

	// hello / register / killjudge
	Version string `json:"version,omitempty"`
	Role    string `json:"role,omitempty"`
	Pid     int    `json:"pid,omitempty"`
	Spare   bool   `json:"spare,omitempty"`
	User    string `json:"user,omitempty"` // killjudge: the judge user's name, for a keeper with no runner registered yet
}

// Write sends one frame. Callers serialise writes to the same stream themselves.
func Write(w io.Writer, m *Msg) error {
	body, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if len(body) > MaxFrame {
		return fmt.Errorf("agentproto: frame of %d bytes exceeds %d", len(body), MaxFrame)
	}
	buf := make([]byte, 4+len(body))
	binary.BigEndian.PutUint32(buf, uint32(len(body)))
	copy(buf[4:], body)
	_, err = w.Write(buf)
	return err
}

// ErrFrameTooLarge is returned for a frame whose length exceeds MaxFrame; the stream cannot be
// trusted after it.
var ErrFrameTooLarge = errors.New("agentproto: frame too large")

// Read receives one frame. io.EOF means the other side closed the stream between frames.
func Read(r io.Reader) (*Msg, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n > MaxFrame {
		return nil, ErrFrameTooLarge
	}
	body := make([]byte, n)
	if _, err := io.ReadFull(r, body); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	m := &Msg{}
	if err := json.Unmarshal(body, m); err != nil {
		return nil, fmt.Errorf("agentproto: bad frame: %w", err)
	}
	return m, nil
}
