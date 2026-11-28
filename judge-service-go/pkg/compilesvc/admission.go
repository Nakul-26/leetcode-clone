package compilesvc

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
)

var errAdmissionClosed = errors.New("compiler service closed")

// Bound requests sent to the JVM, including its active and queued compiles.
// Excess requests wait in Go with the caller's deadline, before source encoding
// or creating a JVM watchdog thread. No student process runs in this service.
type admissionGate struct {
	slots       chan struct{}
	done        chan struct{}
	once        sync.Once
	outstanding atomic.Int64
	waiting     atomic.Int64
}

func newAdmissionGate(limit int) *admissionGate {
	return &admissionGate{slots: make(chan struct{}, max(1, limit)), done: make(chan struct{})}
}

func (g *admissionGate) acquire(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case <-g.done:
		return nil, errAdmissionClosed
	default:
	}
	g.waiting.Add(1)
	defer g.waiting.Add(-1)
	select {
	case g.slots <- struct{}{}:
		// Cancellation/shutdown may race an available slot. Do not send work
		// after either one just because the select chose the slot first.
		if err := ctx.Err(); err != nil {
			<-g.slots
			return nil, err
		}
		select {
		case <-g.done:
			<-g.slots
			return nil, errAdmissionClosed
		default:
		}
		g.outstanding.Add(1)
		var releaseOnce sync.Once
		return func() { releaseOnce.Do(func() { g.outstanding.Add(-1); <-g.slots }) }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-g.done:
		return nil, errAdmissionClosed
	}
}

func (g *admissionGate) close() { g.once.Do(func() { close(g.done) }) }

func compilerThreads() int {
	// Keep native compiler/watchdog thread and heap use bounded even for an
	// accidental configuration typo. CPU quota remains independently enforced.
	return min(16, envInt("JUDGE_COMPILE_SERVICE_THREADS", envInt("JUDGE_COMPILE_SERVICE_CPUS", 2)))
}
