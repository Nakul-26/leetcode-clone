package metrics

import (
	"testing"
	"time"
)

func TestDockerCallCounters(t *testing.T) {
	before, judgedBefore := SnapshotDockerCalls()
	RecordDockerCall("exec_create", 30*time.Millisecond)
	RecordDockerCall("exec_create", 10*time.Millisecond)
	RecordDockerCall("stats", 5*time.Millisecond)
	RecordJudgedSubmission()

	after, judged := SnapshotDockerCalls()
	if got := after["exec_create"].Count - before["exec_create"].Count; got != 2 {
		t.Fatalf("exec_create count = %d, want 2", got)
	}
	if got := after["exec_create"].TotalMs - before["exec_create"].TotalMs; got < 39.9 || got > 40.1 {
		t.Fatalf("exec_create total = %.1f ms, want 40", got)
	}
	if got := after["stats"].Count - before["stats"].Count; got != 1 {
		t.Fatalf("stats count = %d, want 1", got)
	}
	if judged-judgedBefore != 1 {
		t.Fatalf("judged = %d, want 1 more", judged-judgedBefore)
	}
	if _, ok := Snapshot()["docker_calls"]; !ok {
		t.Fatal("Snapshot is missing docker_calls")
	}
}
