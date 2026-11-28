//go:build integration

package main

import (
	"bytes"
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"judge-service-go/pkg/compilesvc"
	"judge-service-go/pkg/executor"
	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
)

func TestStdinDirectSingleParity(t *testing.T) {
	programs := map[string]string{
		"python": "import sys\nn=int(input())\nif n==3: sys.stderr.write('boom'); sys.exit(3)\nif n==5: print('x'*100000); sys.exit(0)\nif n==4:\n while True: pass\nprint(n*2)\n",
		"cpp":    "#include <bits/stdc++.h>\nint main(){int n;std::cin>>n;if(n==3){std::cerr<<\"boom\";return 3;}if(n==5){std::cout<<std::string(100000,'x');return 0;}std::cout<<n*2<<'\\n';}\n",
		"java":   "public class Main { public static void main(String[] a){int n=new java.util.Scanner(System.in).nextInt();if(n==3){System.err.print(\"boom\");System.exit(3);}if(n==5){System.out.print(\"x\".repeat(100000));return;}System.out.println(n*2);}}\n",
	}
	for _, lang := range []string{"python", "cpp", "java"} {
		t.Run(lang, func(t *testing.T) {
			exec, p, pc, _ := agentSetup(t, lang)
			defer p.Release(pc)
			cases := []int{1, 3, 5, 7}
			if lang == "python" {
				cases = append(cases, 4)
			}
			for _, n := range cases {
				var previous *models.SubmissionResult
				for _, direct := range []bool{false, true} {
					t.Setenv("JUDGE_STDIN_DIRECT_SINGLE", fmt.Sprint(direct))
					problem := models.Problem{Type: models.StdinProblem, TimeLimitMs: 1000,
						TestCases: []models.TestCase{{Input: []interface{}{fmt.Sprintf("%d\n", n)}, Expected: nil}}}
					ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
					msg := models.SubmissionMessage{SubmissionID: fmt.Sprintf("direct-%s-%d-%v", lang, n, direct), Language: lang, Code: programs[lang], ProblemType: models.StdinProblem}
					res, _, err := runSubmissionStdinDetailed(ctx, exec, pc, msg, problem)
					cancel()
					if err != nil || res == nil || len(res.Details) != 1 {
						t.Fatalf("run: %v %+v", err, res)
					}
					reset(t, exec, pc)
					if previous != nil {
						a, b := previous.Details[0], res.Details[0]
						if previous.Status != res.Status || a.ErrorType != b.ErrorType || a.Passed != b.Passed || a.Error != b.Error {
							t.Fatalf("n=%d changed verdict: before=%+v after=%+v", n, a, b)
						}
						if (n == 1 || n == 7) && a.Stdout != b.Stdout {
							t.Fatalf("stdout changed: %q vs %q", a.Stdout, b.Stdout)
						}
						if n == 3 && !strings.Contains(b.Stderr+b.Traceback, "boom") {
							t.Fatal("stderr lost")
						}
					}
					previous = res
				}
			}
		})
	}
}

func TestExternalJavaCacheIntegration(t *testing.T) {
	t.Setenv("JUDGE_COMPILE_CACHE_MB", "16")
	t.Setenv("JUDGE_COMPILE_SERVICE", "java")
	exec, p, pc, _ := agentSetup(t, "java")
	defer p.Release(pc)
	svc := compilesvc.New(exec.Client(), languages.GetLanguage("java").ImageRef())
	defer svc.Close()
	exec.SetExternalCompiler(svc)
	for i := 0; i < 2; i++ {
		res := runStdin(t, exec, pc, "java", fmt.Sprintf("external-cache-%d", i), javaDouble, echoDouble[:1])
		if res.Passed != 1 {
			t.Fatalf("run %d: %+v", i, res)
		}
		reset(t, exec, pc)
	}
	compiles, fallbacks, _ := svc.Stats()
	hits, _, _ := exec.CompileCacheStats()
	if compiles != 1 || fallbacks != 0 || hits != 1 {
		t.Fatalf("compiles=%d fallbacks=%d hits=%d", compiles, fallbacks, hits)
	}
}

func TestCppCompleteHeaderConditionalCompilation(t *testing.T) {
	exec, p, pc, _ := agentSetup(t, "cpp")
	defer p.Release(pc)
	source := "#include <bits/stdc++.h>\nint main(){int n;std::cin>>n;\n#ifdef _GLIBCXX_RANDOM\nstd::cout<<n*2<<'\\n';\n#else\nstd::cout<<n*3<<'\\n';\n#endif\n}\n"
	res := runStdin(t, exec, pc, "cpp", "complete-header", source, echoDouble[:1])
	if res.Passed != 1 {
		t.Fatalf("complete standard header semantics changed: %+v", res)
	}
}

// Small controlled timing comparison, not a throughput or exam simulation.
func TestStdinSingleTiming(t *testing.T) {
	t.Setenv("JUDGE_COMPILE_CACHE_MB", "0")
	programs := map[string]string{
		"python": pythonDouble,
		"cpp":    "#include <bits/stdc++.h>\nint main(){int n;std::cin>>n;std::cout<<n*2<<'\\n';}\n",
		"java":   javaDouble,
	}
	for _, lang := range []string{"python", "cpp", "java"} {
		t.Run(lang, func(t *testing.T) {
			exec, p, pc, _ := agentSetup(t, lang)
			defer p.Release(pc)
			if lang == "java" {
				t.Setenv("JUDGE_COMPILE_SERVICE", "java")
				svc := compilesvc.New(exec.Client(), languages.GetLanguage(lang).ImageRef())
				defer svc.Close()
				exec.SetExternalCompiler(svc)
			}
			times := map[bool][]time.Duration{}
			for i := 0; i < 6; i++ {
				for _, direct := range []bool{false, true} {
					t.Setenv("JUDGE_STDIN_DIRECT_SINGLE", fmt.Sprint(direct))
					start := time.Now()
					res := runStdin(t, exec, pc, lang, fmt.Sprintf("timing-%s-%d-%v", lang, i, direct), programs[lang], echoDouble[:1])
					if res.Passed != 1 {
						t.Fatalf("bad result: %+v", res)
					}
					reset(t, exec, pc)
					if i > 0 {
						times[direct] = append(times[direct], time.Since(start))
					}
				}
			}
			for _, direct := range []bool{false, true} {
				sort.Slice(times[direct], func(i, j int) bool { return times[direct][i] < times[direct][j] })
			}
			t.Logf("compile+run+reset p50, five warm samples: batched=%v direct=%v", times[false][2], times[true][2])
		})
	}
}

// Measures only compilation, using separate short-lived compiler containers.
// It does not change any deployed judge's CPU or worker configuration.
func TestCompileServiceCapacity(t *testing.T) {
	t.Setenv("JUDGE_COMPILE_SERVICE", "java")
	t.Setenv("JUDGE_COMPILE_SERVICE_THREADS", "")
	client, err := executor.NewExecutor()
	if err != nil {
		t.Skipf("Docker unavailable: %v", err)
	}
	if _, err := client.Client().InspectImage(languages.GetLanguage("java").ImageRef()); err != nil {
		t.Skipf("Java testing image unavailable: %v", err)
	}
	removeInstanceContainers(t, client.Client())
	for _, cpus := range []int{2, 4} {
		t.Run(fmt.Sprintf("cpus-%d", cpus), func(t *testing.T) {
			t.Setenv("JUDGE_COMPILE_SERVICE_CPUS", fmt.Sprint(cpus))
			svc := compilesvc.New(client.Client(), languages.GetLanguage("java").ImageRef())
			defer svc.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			compile := func(i int) error {
				source := fmt.Sprintf("%s// capacity %d\n", javaDouble, i)
				res, err := svc.CompileJava(ctx, map[string][]byte{"Main.java": []byte(source)}, nil)
				if err != nil {
					return err
				}
				if res.Exit != 0 || len(res.Files["Main.class"]) == 0 {
					return fmt.Errorf("bad compile: %+v", res)
				}
				return nil
			}
			for i := 0; i < 5; i++ {
				if err := compile(-i - 1); err != nil {
					t.Fatal(err)
				}
			}
			const jobs, concurrency = 80, 8
			var wg sync.WaitGroup
			errors := make(chan error, jobs)
			start := time.Now()
			for worker := 0; worker < concurrency; worker++ {
				wg.Add(1)
				go func(worker int) {
					defer wg.Done()
					for i := worker; i < jobs; i += concurrency {
						if err := compile(i); err != nil {
							errors <- err
						}
					}
				}(worker)
			}
			wg.Wait()
			elapsed := time.Since(start)
			close(errors)
			for err := range errors {
				t.Error(err)
			}
			_, fallbacks, _ := svc.Stats()
			if fallbacks != 0 {
				t.Errorf("fallbacks=%d", fallbacks)
			}
			t.Logf("compile-only: %d unique programs, %d in flight, %v, %.0f compiles/min", jobs, concurrency, elapsed, float64(jobs)/elapsed.Minutes())
		})
	}
}

func TestCompileAdmissionIntegration(t *testing.T) {
	t.Setenv("JUDGE_COMPILE_SERVICE_MAX_PENDING", "2")
	t.Setenv("JUDGE_COMPILE_SERVICE", "java")
	client, err := executor.NewExecutor()
	if err != nil {
		t.Skipf("Docker unavailable: %v", err)
	}
	image := languages.GetLanguage("java").ImageRef()
	if _, err := client.Client().InspectImage(image); err != nil {
		t.Skipf("Java testing image unavailable: %v", err)
	}
	removeInstanceContainers(t, client.Client())
	svc := compilesvc.New(client.Client(), image)
	defer svc.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	start, done := make(chan struct{}), make(chan struct{})
	var peak, queued atomic.Int64
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_, outstanding, waiting := svc.AdmissionStats()
				if outstanding > peak.Load() {
					peak.Store(outstanding)
				}
				if waiting > queued.Load() {
					queued.Store(waiting)
				}
			}
		}
	}()
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			token := fmt.Sprintf("submission-%02d", i)
			source := fmt.Sprintf("public class Main { public static final String TOKEN = %q; }", token)
			res, err := svc.CompileJava(ctx, map[string][]byte{"Main.java": []byte(source)}, nil)
			if err != nil {
				t.Error(err)
				return
			}
			if res.Exit != 0 || !bytes.Contains(res.Files["Main.class"], []byte(token)) {
				t.Errorf("compiler artifacts crossed requests for %s", token)
			}
		}(i)
	}
	close(start)
	wg.Wait()
	cancel()
	<-done
	_, outstanding, waiting := svc.AdmissionStats()
	compiles, fallbacks, _ := svc.Stats()
	if peak.Load() > 2 || queued.Load() == 0 || outstanding != 0 || waiting != 0 || compiles != 12 || fallbacks != 0 {
		t.Fatalf("peak=%d queued=%d outstanding=%d waiting=%d compiles=%d fallbacks=%d", peak.Load(), queued.Load(), outstanding, waiting, compiles, fallbacks)
	}
}
