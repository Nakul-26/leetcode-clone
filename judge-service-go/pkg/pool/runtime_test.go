package pool

import "testing"

func TestSetRuntime(t *testing.T) {
	p := NewPool(nil, 1)
	for _, rt := range []string{"", "runc", "runsc"} {
		if err := p.SetRuntime(rt); err != nil {
			t.Fatalf("SetRuntime(%q): %v", rt, err)
		}
		if got := p.sandboxRuntime(); got != rt {
			t.Fatalf("runtime = %q, want %q", got, rt)
		}
	}
	if err := p.SetRuntime("kata"); err == nil {
		t.Fatal("SetRuntime accepted an unknown runtime")
	}
	if got := p.sandboxRuntime(); got != "runsc" {
		t.Fatalf("a rejected runtime changed the setting to %q", got)
	}
}
