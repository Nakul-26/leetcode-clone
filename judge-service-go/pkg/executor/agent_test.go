package executor

import "testing"

func TestAgentLangs(t *testing.T) {
	for _, off := range []string{"", "0", "false", "off", "  "} {
		t.Setenv("JUDGE_AGENT_LANGS", off)
		if agentLangs() != nil {
			t.Errorf("JUDGE_AGENT_LANGS=%q should be off", off)
		}
	}
	t.Setenv("JUDGE_AGENT_LANGS", " Python, javascript ,")
	got := agentLangs()
	if !got["python"] || !got["javascript"] || len(got) != 2 {
		t.Errorf("got %v", got)
	}
}

func TestAgentEnabledForImage(t *testing.T) {
	cases := []struct {
		image string
		langs map[string]bool
		want  bool
	}{
		{"judge-py-env:examportal-go-judge-ifal7h", map[string]bool{"python": true}, true},
		{"judge-py-env", map[string]bool{"python": true}, true},
		{"registry.local/judge-py-env:latest", map[string]bool{"python": true}, true},
		{"judge-py-env:x", map[string]bool{"javascript": true}, false},
		// judge-js-env serves JavaScript and TypeScript.
		{"judge-js-env:x", map[string]bool{"typescript": true}, true},
		{"judge-js-env:x", map[string]bool{"javascript": true}, true},
		{"judge-cpp-env:x", map[string]bool{"all": true}, true},
		{"python:3.10-alpine", map[string]bool{"all": true}, false},
		{"judge-unknown-env:x", map[string]bool{"all": true}, false},
	}
	for _, c := range cases {
		if got := agentEnabledForImage(c.image, c.langs); got != c.want {
			t.Errorf("agentEnabledForImage(%q, %v) = %v, want %v", c.image, c.langs, got, c.want)
		}
	}
}
