//go:build integration

package main

import (
	"fmt"
	"os"
	"testing"
	"time"

	"judge-service-go/pkg/models"
)

// The light <bits/stdc++.h> (adapters.cppLiteCompile): stdin C++ programs get the same
// verdicts and the same compile errors as with only the full header, faster.
// JUDGE_LITE_BASELINE_TAG names an image tag without the light header to compare with.
func TestCppLiteHeader(t *testing.T) {
	baseline := os.Getenv("JUDGE_LITE_BASELINE_TAG")
	if baseline == "" {
		t.Skip("JUDGE_LITE_BASELINE_TAG not set")
	}
	programs := map[string]string{
		"common": "#include <bits/stdc++.h>\nusing namespace std;\nint main(){ long long n; cin >> n; vector<long long> v{n}; sort(v.begin(), v.end()); cout << v[0] * 2 << endl; }\n",
		"regex":  "#include <bits/stdc++.h>\nusing namespace std;\nint main(){ string s; cin >> s; regex r(\"[0-9]+\"); if (regex_match(s, r)) cout << stoll(s) * 2 << endl; }\n",
		"random": "#include <bits/stdc++.h>\nusing namespace std;\nint main(){ mt19937 g(1); long long n; cin >> n; (void)g(); cout << n * 2 << endl; }\n",
		"plain":  "#include <iostream>\nint main(){ long long n; std::cin >> n; std::cout << n * 2 << std::endl; }\n",
	}
	broken := map[string]string{
		"typo":   "#include <bits/stdc++.h>\nusing namespace std;\nint main(){ long long n; cin >> n; cout << m * 2 << endl; }\n",
		"syntax": "#include <bits/stdc++.h>\nusing namespace std;\nint main(){ long long n; cin >> n cout << n * 2 << endl; }\n",
	}

	type outcome struct {
		passed int
		status string
		stderr string
		took   time.Duration
	}
	runAll := func(tag string) map[string]outcome {
		t.Setenv("JUDGE_IMAGE_TAG", tag)
		exec, p, pc, _ := setupIntegration(t, "cpp")
		defer p.Release(pc)
		out := map[string]outcome{}
		all := map[string]string{}
		for k, v := range programs {
			all[k] = v
		}
		for k, v := range broken {
			all[k] = v
		}
		for name, code := range all {
			var best time.Duration
			var res *models.SubmissionResult
			for i := 0; i < 3; i++ {
				start := time.Now()
				res = runStdin(t, exec, pc, "cpp", fmt.Sprintf("lite-%s-%s-%d", tag, name, i), fmt.Sprintf("%s// %d\n", code, i), echoDouble)
				d := time.Since(start)
				reset(t, exec, pc)
				if best == 0 || d < best {
					best = d
				}
			}
			out[name] = outcome{res.Passed, string(res.Status), workspacePathRe.ReplaceAllString(res.Stderr, ""), best}
		}
		return out
	}
	t.Setenv("JUDGE_MERGED_EXECS", "true")
	t.Setenv("JUDGE_AGENT_LANGS", "all")
	old := runAll(baseline)
	lite := runAll(os.Getenv("JUDGE_IMAGE_TAG_UNDER_TEST"))

	for name := range programs {
		if old[name].passed != 2 || lite[name].passed != 2 {
			t.Errorf("%s: passed %d (full header) vs %d (light), want 2", name, old[name].passed, lite[name].passed)
		}
		t.Logf("%-7s full header %v, light %v", name, old[name].took, lite[name].took)
	}
	for name := range broken {
		if lite[name].status != string(models.SubmissionStatusCompilationError) {
			t.Errorf("%s: status %s, want Compilation Error", name, lite[name].status)
		}
		// Same source (same trailing comment) on both images.
		if lite[name].stderr != old[name].stderr {
			t.Errorf("%s: compile errors differ\nfull:  %q\nlight: %q", name, old[name].stderr, lite[name].stderr)
		}
	}
}
