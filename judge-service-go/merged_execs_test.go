//go:build integration

package main

import (
	"context"
	"fmt"
	"testing"
	"time"

	"judge-service-go/pkg/metrics"
	"judge-service-go/pkg/models"
)

// TestMergedExecsCallCount runs the same stdin submission back to back, reset in between as
// finishWithContainer does, with and without JUDGE_MERGED_EXECS, and compares the Docker calls
// per submission (JUDGE_AGENT_PLAN Phase 1). Verdicts must not change.
func TestMergedExecsCallCount(t *testing.T) {
	programs := map[string]string{
		"python": "n = int(input())\nprint(n * 2)\n",
		"cpp":    "#include <iostream>\nint main(){ long long n; std::cin >> n; std::cout << n * 2 << \"\\n\"; }\n",
	}
	problem := models.Problem{
		Title: "merged-execs", Type: models.StdinProblem, TimeLimitMs: 2000, MemoryLimitMb: 256,
		TestCases: []models.TestCase{
			{Input: []interface{}{"1\n"}, Expected: "2\n"},
			{Input: []interface{}{"2\n"}, Expected: "4\n"},
			{Input: []interface{}{"3\n"}, Expected: "7\n"}, // wrong answer
		},
	}
	const runs = 10
	for _, langID := range []string{"python", "cpp"} {
		t.Run(langID, func(t *testing.T) {
			exec, p, pc, _ := setupIntegration(t, langID)
			defer p.Release(pc)
			perJob := map[string]map[string]float64{}
			for _, mode := range []string{"false", "true"} {
				t.Setenv("JUDGE_MERGED_EXECS", mode)
				before, _ := metrics.SnapshotDockerCalls()
				start := time.Now()
				for i := 0; i < runs; i++ {
					ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
					msg := models.SubmissionMessage{SubmissionID: fmt.Sprintf("merged-%s-%s-%d", langID, mode, i), ProblemID: "merged-execs",
						Language: langID, Code: programs[langID], ProblemType: models.StdinProblem}
					res, _, err := runSubmissionStdinDetailed(ctx, exec, pc, msg, problem)
					if err != nil {
						cancel()
						t.Fatalf("%s run %d: %v", mode, i, err)
					}
					if res.Passed != 2 || res.Total != 3 || res.InternalError != "" {
						cancel()
						t.Fatalf("%s run %d: passed %d/%d internal %q", mode, i, res.Passed, res.Total, res.InternalError)
					}
					if err := exec.ResetContainer(ctx, pc.ID); err != nil {
						cancel()
						t.Fatalf("%s run %d: reset: %v", mode, i, err)
					}
					cancel()
				}
				elapsed := time.Since(start)
				after, _ := metrics.SnapshotDockerCalls()
				perJob[mode] = map[string]float64{}
				for op, c := range after {
					perJob[mode][op] = float64(c.Count-before[op].Count) / runs
				}
				t.Logf("merged=%s: %.1f execs, %.1f stats, %.1f updates per submission, %v per submission",
					mode, perJob[mode]["exec_create"], perJob[mode]["stats"], perJob[mode]["update"], elapsed/runs)
			}
			if perJob["true"]["exec_create"] >= perJob["false"]["exec_create"] {
				t.Fatalf("merged mode made %.1f execs per submission, legacy %.1f", perJob["true"]["exec_create"], perJob["false"]["exec_create"])
			}
		})
	}
}
