//go:build integration

package pool

import (
	"context"
	"os"
	"testing"
	"time"

	docker "github.com/fsouza/go-dockerclient"
)

// A language may grow past its configured max up to the ceiling (pkg/capacity), and the
// containers made past it are kept: the idle channel used to be sized to max, so each one was
// destroyed as soon as it was made. POOL_TEST_IMAGE names a sandbox image.
func TestCeilingGrowsPastMax(t *testing.T) {
	image := os.Getenv("POOL_TEST_IMAGE")
	if image == "" {
		t.Skip("POOL_TEST_IMAGE not set")
	}
	cli, err := docker.NewClientFromEnv()
	if err != nil {
		t.Skip(err)
	}
	p := NewPool(cli, 20)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	defer p.Shutdown(context.Background())
	if err := p.WarmUp(ctx, "python", image, 1, 2); err != nil {
		t.Skip(err)
	}

	p.SetCeiling(6)
	if got := p.effectiveMax(p.limits["python"]); got != 6 {
		t.Fatalf("effective max %d, want 6", got)
	}
	p.mu.Lock()
	p.targets["python"] = 6
	p.mu.Unlock()
	start := time.Now()
	p.convergeLang(ctx, "python")
	t.Logf("5 containers created in %v (4 at a time)", time.Since(start))

	// All six are live, and stay when acquired and released.
	held := make([]*PooledContainer, 0, 6)
	for i := 0; i < 6; i++ {
		c := p.Acquire(ctx, "python")
		if c == nil {
			t.Fatalf("only %d containers could be acquired, want 6", i)
		}
		held = append(held, c)
	}
	for _, c := range held {
		p.Release(c)
	}
	if n := len(p.availChans["python"]); n != 6 {
		t.Fatalf("%d idle containers after releasing 6, want 6", n)
	}

	// Without the ceiling the autoscaler's clamp brings the target back to max.
	p.SetCeiling(0)
	d := decideScale(1, p.effectiveMax(p.limits["python"]), 6, 50, true, 0, 150, 20, true, true, true) // a wait in the hold band
	if d.NewTarget != 2 {
		t.Fatalf("target %d after the ceiling was lifted, want the max 2", d.NewTarget)
	}
}
