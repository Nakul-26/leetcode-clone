package pool

import (
	"context"
	"testing"
	"time"
)

func poolWithIdle(lang string, idle, max int) *ContainerPool {
	p := &ContainerPool{
		availChans: map[string]chan *PooledContainer{lang: make(chan *PooledContainer, max)},
		inUse:      map[string]*PooledContainer{},
		limits:     map[string]LangLimits{lang: {Min: 1, Max: max}},
		targets:    map[string]int{lang: max},
	}
	for i := 0; i < idle; i++ {
		p.availChans[lang] <- &PooledContainer{ID: string(rune('a' + i)), Language: lang}
	}
	return p
}

func TestAcquireBulkLeavesTheReserveForInteractiveCallers(t *testing.T) {
	p := poolWithIdle("java", 2, 4)

	first := p.AcquireBulk(context.Background(), "java", 1)
	if first == nil {
		t.Fatal("bulk should take a container when more than the reserve are idle")
	}

	// One idle container left, equal to the reserve: bulk must wait rather than take it.
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if got := p.AcquireBulk(ctx, "java", 1); got != nil {
		t.Fatal("bulk took the reserved container")
	}

	// The interactive path still gets it immediately.
	ictx, icancel := context.WithTimeout(context.Background(), time.Second)
	defer icancel()
	if got := p.Acquire(ictx, "java"); got == nil {
		t.Fatal("interactive caller could not get the reserved container")
	}
}

func TestAcquireBulkStillRunsOnASingleContainerPool(t *testing.T) {
	// A reserve larger than the pool must not starve bulk work forever.
	p := poolWithIdle("ruby", 1, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if got := p.AcquireBulk(ctx, "ruby", 3); got == nil {
		t.Fatal("bulk starved on a one-container pool")
	}
}

func TestAcquireBulkUnknownLanguage(t *testing.T) {
	p := poolWithIdle("java", 1, 2)
	if got := p.AcquireBulk(context.Background(), "cobol", 1); got != nil {
		t.Fatal("expected nil for an unknown language")
	}
}
