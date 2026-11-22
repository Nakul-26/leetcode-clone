package pool

import "testing"

func TestJitteredLimit(t *testing.T) {
	seen := map[int32]bool{}
	for i := 0; i < 2000; i++ {
		l := jitteredLimit(100)
		if l < 90 || l > 100 {
			t.Fatalf("limit %d outside [90, 100]", l)
		}
		seen[l] = true
	}
	if len(seen) < 5 {
		t.Fatalf("limits barely vary: %v", seen)
	}
	if l := jitteredLimit(5); l != 5 {
		t.Fatalf("a small max is not jittered: got %d", l)
	}
}

func TestSuccessorAhead(t *testing.T) {
	for _, c := range []struct{ limit, want int32 }{{100, 10}, {95, 9}, {20, 2}, {10, 1}, {3, 1}, {1, 1}} {
		if got := successorAhead(c.limit); got != c.want {
			t.Errorf("successorAhead(%d) = %d, want %d", c.limit, got, c.want)
		}
	}
}

func TestCountExecutionWithoutLimit(t *testing.T) {
	p := NewPool(nil, 1)
	c := &PooledContainer{ID: "c", Language: "python"}
	for i := 1; i <= 1000; i++ {
		if n, retire := p.CountExecution(c); retire || n != int32(i) {
			t.Fatalf("run %d: count %d retire %v", i, n, retire)
		}
	}
	if c.successorState != successorNone {
		t.Fatal("a successor was prepared with no run limit")
	}
}
