//go:build integration

package main

import (
	"context"
	"fmt"
	"testing"
	"time"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
)

// The compile cache (pkg/executor/compile_cache.go) on real sandboxes, with and without the
// agent: the same program compiled again is a hit with the same verdicts, different code is
// a miss, and a compile error is never kept. Both stdin paths: submissions and /raw-run.
func TestCompileCache(t *testing.T) {
	programs := map[string][2]string{ // two different correct programs per language
		"cpp":  {"#include <bits/stdc++.h>\nint main(){ long long n; std::cin >> n; std::cout << n * 2 << \"\\n\"; }\n", "#include <iostream>\nint main(){ long long n; std::cin >> n; std::cout << (n + n) << std::endl; }\n"},
		"java": {"import java.util.*;\npublic class Main { public static void main(String[] a){ long n = new Scanner(System.in).nextLong(); System.out.println(n * 2); } }\n", "import java.util.*;\npublic class Main { public static void main(String[] a){ long n = new Scanner(System.in).nextLong(); System.out.println(n + n); } }\n"},
		"rust": {"use std::io::Read;\nfn main(){ let mut s = String::new(); std::io::stdin().read_to_string(&mut s).unwrap(); let n: i64 = s.trim().parse().unwrap(); println!(\"{}\", n * 2); }\n", "use std::io::Read;\nfn main(){ let mut s = String::new(); std::io::stdin().read_to_string(&mut s).unwrap(); let n: i64 = s.trim().parse().unwrap(); println!(\"{}\", n + n); }\n"},
	}
	broken := map[string]string{"cpp": "int main( { }\n", "java": "public class Main { void x( }\n", "rust": "fn main( {}\n"}

	for _, agent := range []string{"", "all"} {
		for _, langID := range []string{"cpp", "java", "rust"} {
			t.Run(fmt.Sprintf("%s/agent=%q", langID, agent), func(t *testing.T) {
				t.Setenv("JUDGE_MERGED_EXECS", "true")
				t.Setenv("JUDGE_AGENT_LANGS", agent)
				t.Setenv("JUDGE_COMPILE_CACHE_MB", "64")
				exec, p, pc, _ := setupIntegration(t, langID)
				defer p.Release(pc)

				run := func(id, code string) (*models.SubmissionResult, time.Duration) {
					start := time.Now()
					res := runStdin(t, exec, pc, langID, id, code, echoDouble)
					d := time.Since(start)
					reset(t, exec, pc)
					return res, d
				}
				expect := func(id string, res *models.SubmissionResult) {
					t.Helper()
					if res.Passed != 2 || res.Total != 3 || res.InternalError != "" {
						t.Fatalf("%s: %d/%d passed, internal %q, status %s", id, res.Passed, res.Total, res.InternalError, res.Status)
					}
				}
				stats := func() (int64, int64, int64) { return exec.CompileCacheStats() }

				res, cold := run("cc-1", programs[langID][0])
				expect("first", res)
				h, m, s := stats()
				if h != 0 || m != 1 || s != 1 {
					t.Fatalf("after the first compile: hits %d misses %d stored %d, want 0 1 1", h, m, s)
				}

				res, warm := run("cc-2", programs[langID][0])
				expect("same code again", res)
				if h, _, _ := stats(); h != 1 {
					t.Fatalf("the same code again was not a hit (hits %d)", h)
				}
				t.Logf("same code: %v compiled, %v from the cache", cold, warm)

				res, _ = run("cc-3", programs[langID][1])
				expect("other code", res)
				if h, m, s := stats(); h != 1 || m != 2 || s != 2 {
					t.Fatalf("other code: hits %d misses %d stored %d, want 1 2 2", h, m, s)
				}

				res, _ = run("cc-4", broken[langID])
				if res.Status != models.SubmissionStatusCompilationError {
					t.Fatalf("broken code: status %s, want Compilation Error", res.Status)
				}
				if _, _, s := stats(); s != 2 {
					t.Fatalf("a compile error was kept (stored %d)", s)
				}
				res, _ = run("cc-5", broken[langID])
				if res.Status != models.SubmissionStatusCompilationError {
					t.Fatalf("broken code again: status %s, want Compilation Error (from the cache?)", res.Status)
				}

				// /raw-run: the first program is cached, so this run is a hit too.
				lang := languages.GetLanguage(langID)
				ws, err := workspace.NewSubmissionWorkspace(pc.WorkDir, "cc-raw")
				if err != nil {
					t.Fatal(err)
				}
				defer workspace.CleanupSubmissionWorkspace(ws.HostPath)
				files, compileCmd, runCmd, err := rawRunFilesAndCommands(lang, programs[langID][0], ws.HostPath)
				if err != nil {
					t.Fatal(err)
				}
				hitsBefore, _, _ := stats()
				ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
				defer cancel()
				stdout, stderr, compileOut, exitCode, execErr := exec.RunRawWithStdin(ctx, pc.ID, files, ws.HostPath, ws.ContainerPath, compileCmd, runCmd, 5*time.Second, 256, []byte("21\n"))
				if execErr != nil || exitCode != 0 || stdout != "42\n" {
					t.Fatalf("raw run: stdout %q stderr %q compile %q exit %d err %v", stdout, stderr, compileOut, exitCode, execErr)
				}
				if h, _, _ := stats(); h != hitsBefore+1 {
					t.Fatalf("raw run of cached code was not a hit")
				}
				reset(t, exec, pc)
			})
		}
	}
}
