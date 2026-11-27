//go:build integration

package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"runtime"
	"runtime/pprof"
	"strings"
	"testing"
	"time"

	"judge-service-go/pkg/executor"
	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/metrics"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/pool"
)

// The resident sandbox agent (JUDGE_AGENT_PLAN Phase 2, pkg/executor/agent.go). Besides these,
// the whole integration suite is run with JUDGE_AGENT_LANGS=all to check that every existing
// contamination, limit and verdict test passes with the agent too.

func agentSetup(t *testing.T, langID string) (*executor.Executor, *pool.ContainerPool, *pool.PooledContainer, *languages.Language) {
	t.Setenv("JUDGE_MERGED_EXECS", "true")
	t.Setenv("JUDGE_AGENT_LANGS", "all")
	return setupIntegration(t, langID)
}

// echoDouble is a stdin problem whose third test is a wrong answer, so a correct program
// passes 2 of 3.
var echoDouble = []models.TestCase{
	{Input: []interface{}{"1\n"}, Expected: "2\n"},
	{Input: []interface{}{"2\n"}, Expected: "4\n"},
	{Input: []interface{}{"3\n"}, Expected: "7\n"},
}

const pythonDouble = "n = int(input())\nprint(n * 2)\n"

func runStdin(t *testing.T, exec *executor.Executor, pc *pool.PooledContainer, langID, id, code string, tests []models.TestCase) *models.SubmissionResult {
	t.Helper()
	problem := models.Problem{Title: id, Type: models.StdinProblem, TimeLimitMs: 2000, MemoryLimitMb: 256, TestCases: tests}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	msg := models.SubmissionMessage{SubmissionID: id, ProblemID: id, Language: langID, Code: code, ProblemType: models.StdinProblem}
	res, _, err := runSubmissionStdinDetailed(ctx, exec, pc, msg, problem)
	if err != nil {
		t.Fatalf("%s: %v", id, err)
	}
	return res
}

func reset(t *testing.T, exec *executor.Executor, pc *pool.PooledContainer) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := exec.ResetContainer(ctx, pc.ID); err != nil {
		t.Fatalf("reset: %v", err)
	}
}

// expectHealthy runs a normal submission and checks its verdicts: what any attack must leave
// behind for the next student.
func expectHealthy(t *testing.T, exec *executor.Executor, pc *pool.PooledContainer, id string) {
	t.Helper()
	res := runStdin(t, exec, pc, "python", id, pythonDouble, echoDouble)
	if res.Passed != 2 || res.Total != 3 || res.InternalError != "" {
		t.Fatalf("%s: the next submission got %d/%d passed, internal error %q, status %s", id, res.Passed, res.Total, res.InternalError, res.Status)
	}
	reset(t, exec, pc)
}

// TestAgentRunsWithoutExecs: once a container's agent is up, a submission makes no exec at
// all, gets the same verdicts as without the agent, and is faster.
func TestAgentRunsWithoutExecs(t *testing.T) {
	programs := map[string]string{
		"python":     pythonDouble,
		"javascript": "const n = parseInt(require('fs').readFileSync(0, 'utf8'));\nconsole.log(n * 2);\n",
		"cpp":        "#include <iostream>\nint main(){ long long n; std::cin >> n; std::cout << n * 2 << \"\\n\"; }\n",
		"java":       "import java.util.*;\npublic class Main { public static void main(String[] a){ Scanner s = new Scanner(System.in); long n = s.nextLong(); System.out.println(n * 2); } }\n",
	}
	const runs = 10
	for _, langID := range []string{"python", "javascript", "cpp", "java"} {
		t.Run(langID, func(t *testing.T) {
			t.Setenv("JUDGE_MERGED_EXECS", "true")
			type sample struct {
				execs, stats, updates float64
				wall                  time.Duration
			}
			got := map[string]sample{}
			for _, agent := range []string{"", "all"} {
				t.Setenv("JUDGE_AGENT_LANGS", agent)
				exec, p, pc, _ := setupIntegration(t, langID) // a fresh container per mode
				// Warm: the first submission starts the agent (two execs, once per container).
				res := runStdin(t, exec, pc, langID, fmt.Sprintf("warm-%s-%s", langID, agent), programs[langID], echoDouble)
				if res.Passed != 2 {
					t.Fatalf("agent=%q warm-up: %d passed, internal %q", agent, res.Passed, res.InternalError)
				}
				reset(t, exec, pc)

				before, _ := metrics.SnapshotDockerCalls()
				start := time.Now()
				for i := 0; i < runs; i++ {
					res := runStdin(t, exec, pc, langID, fmt.Sprintf("agent-%s-%s-%d", langID, agent, i), programs[langID], echoDouble)
					if res.Passed != 2 || res.Total != 3 || res.InternalError != "" {
						t.Fatalf("agent=%q run %d: %d/%d passed, internal %q", agent, i, res.Passed, res.Total, res.InternalError)
					}
					reset(t, exec, pc)
				}
				wall := time.Since(start) / runs
				after, _ := metrics.SnapshotDockerCalls()
				d := func(op string) float64 { return float64(after[op].Count-before[op].Count) / runs }
				got[agent] = sample{d("exec_create"), d("stats"), d("update"), wall}
				t.Logf("agent=%-3q: %.1f execs, %.1f stats, %.1f updates, %v per submission", agent, d("exec_create"), d("stats"), d("update"), wall)
				p.Release(pc)
			}
			if got["all"].execs != 0 {
				t.Fatalf("with the agent a submission made %.1f execs, want 0", got["all"].execs)
			}
			if got["all"].wall >= got[""].wall {
				t.Errorf("with the agent a submission took %v, without %v", got["all"].wall, got[""].wall)
			}
		})
	}
}

// pyRunner finds the runner from inside a submission: the judge-agent process of the same user.
const pyRunner = `import os
def runner_pid():
    me = os.getuid()
    for d in os.listdir('/proc'):
        if not d.isdigit() or int(d) == os.getpid():
            continue
        try:
            if '(judge-agent)' not in open('/proc/%s/stat' % d).read():
                continue
            for line in open('/proc/%s/status' % d):
                if line.startswith('Uid:') and int(line.split()[1]) == me:
                    return int(d)
        except OSError:
            pass
    return None
`

// TestAgentRunnerCannotBeRead: a submission cannot trace the runner or reach its memory,
// environment or file descriptors (where the judge's stream is).
func TestAgentRunnerCannotBeRead(t *testing.T) {
	exec, p, pc, _ := agentSetup(t, "python")
	defer p.Release(pc)
	expectHealthy(t, exec, pc, "read-warm") // starts the agent

	code := pyRunner + `import ctypes
pid = runner_pid()
out = []
for path in ['/proc/%d/fd/0' % pid, '/proc/%d/fd/1' % pid, '/proc/%d/mem' % pid, '/proc/%d/environ' % pid, '/proc/%d/maps' % pid]:
    try:
        open(path, 'rb').read(1)
        out.append('READ ' + path)
    except PermissionError:
        out.append('denied')
    except OSError as e:
        out.append('error %d %s' % (e.errno, path))
try:
    os.listdir('/proc/%d/fd' % pid)
    out.append('LISTED fds')
except PermissionError:
    out.append('denied')
libc = ctypes.CDLL(None, use_errno=True)
out.append('denied' if libc.ptrace(16, pid, 0, 0) != 0 else 'ATTACHED')  # PTRACE_ATTACH
print(pid is not None, ' '.join(out))
`
	want := "True " + strings.TrimSpace(strings.Repeat("denied ", 7)) + "\n"
	res := runStdin(t, exec, pc, "python", "read-runner", code, []models.TestCase{{Input: []interface{}{""}, Expected: want}})
	if res.Passed != 1 {
		got := ""
		if len(res.Details) > 0 {
			got = fmt.Sprint(res.Details[0].Output) + res.Details[0].Stderr
		}
		t.Fatalf("a submission could reach the runner: got %q, want %q", got, want)
	}
	reset(t, exec, pc)
	expectHealthy(t, exec, pc, "read-after")
}

// TestAgentSubmissionKillsEverything: a submission that kills every process it can (the runner
// included) fails itself only; the next one gets a new runner and correct verdicts.
func TestAgentSubmissionKillsEverything(t *testing.T) {
	exec, p, pc, _ := agentSetup(t, "python")
	defer p.Release(pc)
	expectHealthy(t, exec, pc, "kill-warm")
	starts := executor.AgentRunnerStarts()

	res := runStdin(t, exec, pc, "python", "kill-all", "import os, signal\nos.kill(-1, signal.SIGKILL)\n", echoDouble)
	if res.Status == models.SubmissionStatusAccepted || res.Passed != 0 {
		t.Fatalf("kill -1 passed: %+v", res)
	}
	t.Logf("kill -1: status %s, internal %q", res.Status, res.InternalError)
	reset(t, exec, pc)
	expectHealthy(t, exec, pc, "kill-after")
	if executor.AgentRunnerStarts() == starts {
		t.Fatal("the runner was not replaced")
	}
}

// TestAgentStoppedRunner: a submission that stops the runner (SIGSTOP) gets a time limit at
// worst; the runner is replaced and the next submission is not slowed or failed.
func TestAgentStoppedRunner(t *testing.T) {
	exec, p, pc, _ := agentSetup(t, "python")
	defer p.Release(pc)
	expectHealthy(t, exec, pc, "stop-warm")

	code := pyRunner + "import signal\nos.kill(runner_pid(), signal.SIGSTOP)\nn = int(input())\nprint(n * 2)\n"
	res := runStdin(t, exec, pc, "python", "stop-runner", code, echoDouble)
	t.Logf("stopped runner: status %s, %d/%d passed, internal %q", res.Status, res.Passed, res.Total, res.InternalError)
	reset(t, exec, pc)
	start := time.Now()
	expectHealthy(t, exec, pc, "stop-after")
	if d := time.Since(start); d > 10*time.Second {
		t.Fatalf("the next submission took %v", d)
	}
}

// TestAgentStoppedRunnerLate: the runner stopped by a process the submission left behind,
// after its own run ended, must not hang the next submission either.
func TestAgentStoppedRunnerLate(t *testing.T) {
	exec, p, pc, _ := agentSetup(t, "python")
	defer p.Release(pc)
	expectHealthy(t, exec, pc, "late-warm")

	code := pyRunner + `import signal, subprocess, sys
pid = runner_pid()
subprocess.Popen([sys.executable, '-c', 'import os, signal, time; time.sleep(0.3); os.kill(%d, signal.SIGSTOP)' % pid], start_new_session=True)
n = int(input())
print(n * 2)
`
	runStdin(t, exec, pc, "python", "late-stop", code, echoDouble[:1])
	time.Sleep(time.Second) // the left-behind process has stopped the runner by now
	reset(t, exec, pc)
	expectHealthy(t, exec, pc, "late-after")
}

// TestAgentRunnerStateIsolated: what a submission can change about the runner without
// privilege (nice value, CPU affinity, resource limits) would pass on to the next
// submission's processes; the runner must be replaced instead.
func TestAgentRunnerStateIsolated(t *testing.T) {
	exec, p, pc, _ := agentSetup(t, "python")
	defer p.Release(pc)
	expectHealthy(t, exec, pc, "state-warm")

	probe := "import os, resource\nprint(os.getpriority(os.PRIO_PROCESS, 0), len(os.sched_getaffinity(0)), resource.getrlimit(resource.RLIMIT_CPU), resource.getrlimit(resource.RLIMIT_NOFILE), resource.getrlimit(resource.RLIMIT_AS))\n"
	baseline := runStdin(t, exec, pc, "python", "state-baseline", probe, []models.TestCase{{Input: []interface{}{""}}})
	reset(t, exec, pc)
	if len(baseline.Details) == 0 {
		t.Fatal("no baseline output")
	}
	want := fmt.Sprint(baseline.Details[0].Output)
	t.Logf("baseline: %s", strings.TrimSpace(want))

	tamper := pyRunner + `import resource
pid = runner_pid()
os.setpriority(os.PRIO_PROCESS, pid, 19)
os.sched_setaffinity(pid, {sorted(os.sched_getaffinity(0))[0]})
resource.prlimit(pid, resource.RLIMIT_CPU, (1, 1))
resource.prlimit(pid, resource.RLIMIT_NOFILE, (16, 16))
resource.prlimit(pid, resource.RLIMIT_AS, (64 << 20, 64 << 20))
print('done')
`
	res := runStdin(t, exec, pc, "python", "state-tamper", tamper, []models.TestCase{{Input: []interface{}{""}, Expected: "done\n"}})
	if res.Passed != 1 {
		t.Logf("tamper run: %+v", res.Details)
	}
	reset(t, exec, pc)

	after := runStdin(t, exec, pc, "python", "state-after", probe, []models.TestCase{{Input: []interface{}{""}, Expected: want}})
	if after.Passed != 1 {
		got := ""
		if len(after.Details) > 0 {
			got = fmt.Sprint(after.Details[0].Output)
		}
		t.Fatalf("the next submission inherited the tampering: got %q, want %q", got, want)
	}
	reset(t, exec, pc)
	expectHealthy(t, exec, pc, "state-healthy")
}

// TestAgentForkBomb: a fork bomb holds every pid the container may have until its time
// limit; the keeper still kills it (in-process, without forking) and the container is reused.
func TestAgentForkBomb(t *testing.T) {
	exec, p, pc, _ := agentSetup(t, "python")
	defer p.Release(pc)
	expectHealthy(t, exec, pc, "fork-warm")

	bomb := "import os\nwhile True:\n    try:\n        os.fork()\n    except OSError:\n        pass\n"
	res := runStdin(t, exec, pc, "python", "fork-bomb", bomb, echoDouble[:1])
	if res.Passed != 0 {
		t.Fatalf("the fork bomb passed: %+v", res)
	}
	t.Logf("fork bomb: status %s, internal %q", res.Status, res.InternalError)
	reset(t, exec, pc)
	expectHealthy(t, exec, pc, "fork-after")
}

// TestAgentMemoryLimit: going over the memory limit is Memory Limit Exceeded as before (the
// OOM killer picks the program, not the agent) and the container stays usable.
func TestAgentMemoryLimit(t *testing.T) {
	if underGVisor() {
		t.Skip("under gVisor an MLE takes the container (S3)")
	}
	exec, p, pc, _ := agentSetup(t, "python")
	defer p.Release(pc)
	expectHealthy(t, exec, pc, "mle-warm")
	starts := executor.AgentRunnerStarts()

	res := runStdin(t, exec, pc, "python", "mle", "a = bytearray(600 << 20)\nprint(len(a))\n", echoDouble[:1])
	if len(res.Details) == 0 || res.Details[0].ErrorType != models.ErrorTypeMemoryLimit {
		t.Fatalf("over the memory limit: %+v", res.Details)
	}
	reset(t, exec, pc)
	expectHealthy(t, exec, pc, "mle-after")
	if executor.AgentRunnerStarts() != starts {
		t.Errorf("the OOM killer took the runner (%d starts, was %d)", executor.AgentRunnerStarts(), starts)
	}
}

// TestAgentLeftoverProcess: a process a submission leaves running is gone before the next one,
// as without the agent (the keeper's kill replaces pkill).
func TestAgentLeftoverProcess(t *testing.T) {
	exec, p, pc, _ := agentSetup(t, "python")
	defer p.Release(pc)
	expectHealthy(t, exec, pc, "left-warm")

	runStdin(t, exec, pc, "python", "left-spawn", "import subprocess\nsubprocess.Popen(['sleep', '300'], start_new_session=True)\nprint(2)\n", echoDouble[:1])
	reset(t, exec, pc)
	check := "import subprocess\nprint(subprocess.run(['pgrep', 'sleep']).returncode)\n"
	res := runStdin(t, exec, pc, "python", "left-check", check, []models.TestCase{{Input: []interface{}{""}, Expected: "1\n"}})
	if res.Passed != 1 {
		t.Fatalf("a process survived into the next submission: %+v", res.Details)
	}
	reset(t, exec, pc)
}

// TestAgentFallbackWithoutBinary: with the agent switched on but an image without it, the
// judge uses plain execs and the verdicts are right. JUDGE_AGENT_FALLBACK_TAG names such an
// image tag (an older build).
func TestAgentFallbackWithoutBinary(t *testing.T) {
	tag := os.Getenv("JUDGE_AGENT_FALLBACK_TAG")
	if tag == "" {
		t.Skip("JUDGE_AGENT_FALLBACK_TAG not set")
	}
	t.Setenv("JUDGE_IMAGE_TAG", tag)
	exec, p, pc, _ := agentSetup(t, "python")
	defer p.Release(pc)
	before, _ := metrics.SnapshotDockerCalls()
	expectHealthy(t, exec, pc, "fallback-1")
	expectHealthy(t, exec, pc, "fallback-2")
	after, _ := metrics.SnapshotDockerCalls()
	if after["exec_create"].Count == before["exec_create"].Count {
		t.Fatal("no execs: the agent seems to be in an image that should not have it")
	}
}

// TestAgentGoroutinesEndWithContainer: a removed container's agent leaves nothing running in
// the judge (its two connections end with the container's execs).
func TestAgentGoroutinesEndWithContainer(t *testing.T) {
	t.Setenv("JUDGE_MERGED_EXECS", "true")
	t.Setenv("JUDGE_AGENT_LANGS", "all")
	runtime.GC()
	time.Sleep(500 * time.Millisecond)
	before := runtime.NumGoroutine()
	for i := 0; i < 3; i++ {
		exec, err := executor.NewExecutor()
		if err != nil {
			t.Skip(err)
		}
		lang := languages.GetLanguage("python")
		p := newTestPool(t, exec.Client(), 1)
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		if err := p.WarmUp(ctx, lang.ID, lang.ImageRef(), 1, 1); err != nil {
			cancel()
			t.Skip(err)
		}
		pc := p.Acquire(ctx, lang.ID)
		cancel()
		expectHealthy(t, exec, pc, fmt.Sprintf("gor-%d", i))
		p.Release(pc)
		p.Shutdown(context.Background())
	}
	var after int
	for i := 0; i < 50; i++ { // removal ends the streams asynchronously
		runtime.GC()
		time.Sleep(100 * time.Millisecond)
		if after = runtime.NumGoroutine(); after <= before+2 {
			return
		}
	}
	var buf bytes.Buffer
	_ = pprof.Lookup("goroutine").WriteTo(&buf, 1)
	t.Fatalf("goroutines before=%d after=%d (3 containers):\n%s", before, after, buf.String())
}
