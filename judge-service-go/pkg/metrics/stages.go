package metrics

import (
	"context"
	"sync"
	"time"
)

type stageLanguageKey struct{}

// WithLanguage attributes nested executor timings without putting source, user IDs,
// or submission IDs into metric labels. Call only with a validated language.
func WithLanguage(ctx context.Context, language string) context.Context {
	return context.WithValue(ctx, stageLanguageKey{}, language)
}

// StageSnapshot is cumulative since process start. Buckets are non-cumulative;
// their bounds, in milliseconds, are published alongside them. Timings may be
// nested (compile contains upload); they must not be summed as exclusive costs.
type StageSnapshot struct {
	Count   int64     `json:"count"`
	TotalMs float64   `json:"total_ms"`
	MaxMs   float64   `json:"max_ms"`
	Buckets [10]int64 `json:"buckets"`
}

var stageBounds = [...]float64{1, 5, 10, 25, 50, 100, 250, 1000, 5000}
var stages = struct {
	sync.Mutex
	values map[string]map[string]StageSnapshot
}{values: make(map[string]map[string]StageSnapshot)}

func RecordStage(ctx context.Context, name string, elapsed time.Duration) {
	language, _ := ctx.Value(stageLanguageKey{}).(string)
	if language == "" || elapsed < 0 {
		return
	}
	ms := float64(elapsed) / float64(time.Millisecond)
	stages.Lock()
	defer stages.Unlock()
	if stages.values[language] == nil {
		stages.values[language] = make(map[string]StageSnapshot)
	}
	v := stages.values[language][name]
	v.Count++
	v.TotalMs += ms
	if ms > v.MaxMs {
		v.MaxMs = ms
	}
	i := 0
	for i < len(stageBounds) && ms > stageBounds[i] {
		i++
	}
	v.Buckets[i]++
	stages.values[language][name] = v
}

// TimeStage must be called as: defer metrics.TimeStage(ctx, "stage")().
func TimeStage(ctx context.Context, name string) func() {
	start := time.Now()
	return func() { RecordStage(ctx, name, time.Since(start)) }
}

func SnapshotStages() map[string]map[string]StageSnapshot {
	stages.Lock()
	defer stages.Unlock()
	out := make(map[string]map[string]StageSnapshot, len(stages.values))
	for language, values := range stages.values {
		out[language] = make(map[string]StageSnapshot, len(values))
		for name, v := range values {
			out[language][name] = v
		}
	}
	return out
}
