//go:build linux

package main

import (
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"judge-service-go/pkg/agentproto"
)

func TestCgroupCPUTimeNanosReadsOnlyUsageCounter(t *testing.T) {
	root := t.TempDir()
	data := "usage_usec 12345\nuser_usec 10000\nsystem_usec 2345\n"
	if err := os.WriteFile(filepath.Join(root, "cpu.stat"), []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := cgroupCPUTimeNanosFrom(root)
	if err != nil || got != 12_345_000 {
		t.Fatalf("cgroupCPUTimeNanosFrom() = %d, %v; want 12345000, nil", got, err)
	}
}

func TestCgroupCPUTimeNanosRejectsMissingOrInvalidCounter(t *testing.T) {
	for _, data := range []string{"user_usec 1\n", "usage_usec nope\n", "usage_usec 9223372036854776\n"} {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, "cpu.stat"), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if got, err := cgroupCPUTimeNanosFrom(root); err == nil {
			t.Errorf("cgroupCPUTimeNanosFrom(%q) = %d, nil", data, got)
		}
	}
}

func TestCgroupCPUTimeNanosReadsLiveCounter(t *testing.T) {
	got, err := cgroupCPUTimeNanos()
	if err != nil || got <= 0 {
		t.Fatalf("cgroupCPUTimeNanos() = %d, %v; want a positive read-only cgroup counter", got, err)
	}
}

func TestOnlyKeeperCanReadCPUTime(t *testing.T) {
	for _, role := range []string{"keeper", "runner"} {
		t.Run(role, func(t *testing.T) {
			judgeSide, agentSide := net.Pipe()
			done := make(chan struct{})
			go func() {
				a := newAgent(role)
				a.out = agentSide
				_ = a.serve(agentSide)
				close(done)
			}()

			hello, err := agentproto.Read(judgeSide)
			if err != nil || hello.Op != agentproto.OpHello || hello.Role != role {
				t.Fatalf("agent hello = %+v, %v", hello, err)
			}
			if err := agentproto.Write(judgeSide, &agentproto.Msg{Op: agentproto.OpCPUTime, Seq: 1}); err != nil {
				t.Fatal(err)
			}
			reply, err := agentproto.Read(judgeSide)
			if err != nil || reply.Op != agentproto.OpDone || reply.Seq != 1 {
				t.Fatalf("CPU-time reply = %+v, %v", reply, err)
			}
			if role == "keeper" && (reply.Code != 0 || reply.CPUTimeNanos <= 0) {
				t.Fatalf("keeper CPU-time reply = %+v", reply)
			}
			if role == "runner" && (reply.Code == 0 || reply.CPUTimeNanos != 0) {
				t.Fatalf("runner was allowed to read the keeper CPU-time counter: %+v", reply)
			}
			_ = judgeSide.Close()
			_ = agentSide.Close()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("agent did not stop after its private protocol stream closed")
			}
		})
	}
}
