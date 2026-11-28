package metrics

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestStageHistogramConcurrentAndSnapshotIsolation(t *testing.T) {
	stages.Lock()
	delete(stages.values, "stage-test")
	stages.Unlock()
	ctx := WithLanguage(context.Background(), "stage-test")
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			RecordStage(ctx, "compile", 25*time.Millisecond)
			RecordStage(ctx, "compile", 6*time.Second)
		}()
	}
	wg.Wait()
	v := SnapshotStages()["stage-test"]["compile"]
	if v.Count != 80 || v.TotalMs != 241000 || v.MaxMs != 6000 || v.Buckets[3] != 40 || v.Buckets[9] != 40 {
		t.Fatalf("bad histogram: %+v", v)
	}
	snapshot := SnapshotStages()
	delete(snapshot["stage-test"], "compile")
	if SnapshotStages()["stage-test"]["compile"].Count != 80 {
		t.Fatal("snapshot mutation affected live metrics")
	}
	RecordStage(ctx, "negative", -time.Second)
	if _, ok := SnapshotStages()["stage-test"]["negative"]; ok {
		t.Fatal("negative sample accepted")
	}
}
