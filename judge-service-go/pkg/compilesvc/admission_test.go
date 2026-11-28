package compilesvc

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestAdmissionCancellationAndShutdown(t *testing.T) {
	g := newAdmissionGate(1)
	release, err := g.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := g.acquire(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting admission: %v", err)
	}
	if g.outstanding.Load() != 1 || g.waiting.Load() != 0 {
		t.Fatal("cancelled waiter leaked capacity")
	}
	waiter := make(chan error, 1)
	go func() { _, err := g.acquire(context.Background()); waiter <- err }()
	g.close()
	g.close()
	select {
	case err := <-waiter:
		if !errors.Is(err, errAdmissionClosed) {
			t.Fatalf("shutdown waiter: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown left a blocked waiter")
	}
	release()
	release()
	if g.outstanding.Load() != 0 || len(g.slots) != 0 {
		t.Fatal("permit leaked")
	}
	if _, err := g.acquire(context.Background()); !errors.Is(err, errAdmissionClosed) {
		t.Fatal("closed gate admitted work")
	}
	g = newAdmissionGate(1)
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	if _, err := g.acquire(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled request acquired an empty slot")
	}
}

func TestAdmissionBoundsConcurrentCompiles(t *testing.T) {
	g := newAdmissionGate(3)
	var wg sync.WaitGroup
	var active, peak atomic.Int64
	entered := make(chan struct{}, 64)
	unblock := make(chan struct{})
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			release, err := g.acquire(context.Background())
			if err != nil {
				t.Error(err)
				return
			}
			defer release()
			n := active.Add(1)
			for old := peak.Load(); n > old && !peak.CompareAndSwap(old, n); old = peak.Load() {
			}
			entered <- struct{}{}
			<-unblock
			active.Add(-1)
		}()
	}
	for i := 0; i < 3; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("available slots not used")
		}
	}
	close(unblock)
	wg.Wait()
	if peak.Load() != 3 || g.outstanding.Load() != 0 || g.waiting.Load() != 0 {
		t.Fatalf("peak=%d outstanding=%d waiting=%d", peak.Load(), g.outstanding.Load(), g.waiting.Load())
	}
}

func TestCompilerAdmissionConfiguration(t *testing.T) {
	t.Setenv("JUDGE_COMPILE_SERVICE_CPUS", "4")
	t.Setenv("JUDGE_COMPILE_SERVICE_THREADS", "")
	t.Setenv("JUDGE_COMPILE_SERVICE_MAX_PENDING", "")
	s := New(nil, "test")
	if n, _, _ := s.AdmissionStats(); n != 8 {
		t.Fatalf("default pending=%d", n)
	}
	t.Setenv("JUDGE_COMPILE_SERVICE_THREADS", "9999")
	t.Setenv("JUDGE_COMPILE_SERVICE_MAX_PENDING", "9999")
	s = New(nil, "test")
	if n, _, _ := s.AdmissionStats(); n != 64 || compilerThreads() != 16 {
		t.Fatal("configuration was not bounded")
	}
	s.Close()
	if _, err := s.connection(context.Background()); !errors.Is(err, errAdmissionClosed) {
		t.Fatalf("closed service tried to restart: %v", err)
	}
	if _, err := s.CompileJava(context.Background(), nil, nil); !errors.Is(err, errAdmissionClosed) {
		t.Fatalf("closed service accepted compile: %v", err)
	}
}
