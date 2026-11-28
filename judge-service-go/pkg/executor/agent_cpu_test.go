package executor

import (
	"context"
	"io"
	"testing"
	"time"

	"judge-service-go/pkg/agentproto"
)

func fakeKeeperCPUReply(t *testing.T, reply agentproto.Msg) *Executor {
	t.Helper()
	requestR, requestW := io.Pipe()
	replyR, replyW := io.Pipe()
	keeper := &agentConn{
		containerID: "cpu-test",
		role:        "keeper",
		in:          requestW,
		jobs:        map[uint64]*agentJob{},
		replies:     map[uint64]chan *agentproto.Msg{},
		dead:        make(chan struct{}),
	}
	go keeper.readLoop(replyR, make(chan *agentproto.Msg, 1))
	if err := agentproto.Write(replyW, &agentproto.Msg{Op: agentproto.OpHello, Version: agentproto.Version, Role: "keeper", Pid: 1}); err != nil {
		t.Fatal(err)
	}
	go func() {
		request, err := agentproto.Read(requestR)
		if err != nil {
			return
		}
		reply.Op = agentproto.OpDone
		reply.Seq = request.Seq
		_ = agentproto.Write(replyW, &reply)
	}()
	t.Cleanup(func() {
		_ = requestR.Close()
		_ = requestW.Close()
		_ = replyR.Close()
		_ = replyW.Close()
	})

	e := &Executor{}
	e.agents.Store("cpu-test", &agentState{containerID: "cpu-test", keeper: keeper})
	return e
}

func TestContainerCPUTimeUsesTrustedKeeperReply(t *testing.T) {
	e := fakeKeeperCPUReply(t, agentproto.Msg{Code: 0, CPUTimeNanos: int64(73 * time.Millisecond)})
	used, got, err := e.containerCPUTimeFromAgent(context.Background(), "cpu-test")
	if err != nil || !used || got != 73*time.Millisecond {
		t.Fatalf("containerCPUTimeFromAgent() = %t, %s, %v", used, got, err)
	}
}

func TestContainerCPUTimeDisablesUnsupportedKeeperCounter(t *testing.T) {
	e := fakeKeeperCPUReply(t, agentproto.Msg{Code: 1, Err: "counter unavailable"})
	used, _, err := e.containerCPUTimeFromAgent(context.Background(), "cpu-test")
	if !used || err == nil {
		t.Fatalf("first call = %t, %v; want an attempted agent call and an error", used, err)
	}
	used, _, err = e.containerCPUTimeFromAgent(context.Background(), "cpu-test")
	if used || err != nil {
		t.Fatalf("second call = %t, %v; unsupported counter should fall back without retrying", used, err)
	}
}
