//go:build integration

package main

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"testing"
	"time"

	"judge-service-go/pkg/compilesvc"
	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
)

var workspacePathRe = regexp.MustCompile(`(?:/home/judge)?/app/[^/\s:]+/`)

const javaDouble = "import java.util.*;\npublic class Main { public static void main(String[] a){ long n = new Scanner(System.in).nextLong(); System.out.println(n * 2); } }\n"
const javaBroken = "import java.util.*;\npublic class Main { public static void main(String[] a){ int x = \"no\"; undefinedCall(); } }\n"

// The resident Java compiler (pkg/compilesvc) gives the same verdicts and the same compile
// errors as compiling in the sandbox, recycles itself, takes concurrent compiles, refuses
// what it must, and falls back to the sandbox when it is not there.
func TestCompileService(t *testing.T) {
	t.Setenv("JUDGE_MERGED_EXECS", "true")
	t.Setenv("JUDGE_AGENT_LANGS", "all")
	t.Setenv("JUDGE_COMPILE_SERVICE", "java")
	t.Setenv("JUDGE_COMPILE_SERVICE_RECYCLE", "5")
	exec, p, pc, _ := setupIntegration(t, "java")
	defer p.Release(pc)

	timed := func(id, code string) (*models.SubmissionResult, time.Duration) {
		start := time.Now()
		res := runStdin(t, exec, pc, "java", id, code, echoDouble)
		d := time.Since(start)
		reset(t, exec, pc)
		return res, d
	}

	// In the sandbox, as before.
	var sandboxTotal time.Duration
	for i := 0; i < 5; i++ {
		res, d := timed(fmt.Sprintf("cs-sandbox-%d", i), fmt.Sprintf("%s// %d\n", javaDouble, i))
		if res.Passed != 2 || res.Total != 3 {
			t.Fatalf("sandbox run %d: %d/%d", i, res.Passed, res.Total)
		}
		sandboxTotal += d
	}
	sandboxErr, _ := timed("cs-sandbox-broken", javaBroken)
	if sandboxErr.Status != models.SubmissionStatusCompilationError {
		t.Fatalf("sandbox broken: %s", sandboxErr.Status)
	}

	// Through the service.
	svc := compilesvc.New(exec.Client(), languages.GetLanguage("java").ImageRef())
	defer svc.Close()
	exec.SetExternalCompiler(svc)
	defer exec.SetExternalCompiler(nil)
	var svcTotal time.Duration
	const runs = 12 // over the recycle limit of 5: the server restarts twice
	for i := 0; i < runs; i++ {
		res, d := timed(fmt.Sprintf("cs-svc-%d", i), fmt.Sprintf("%s// svc %d\n", javaDouble, i))
		if res.Passed != 2 || res.Total != 3 || res.InternalError != "" {
			t.Fatalf("service run %d: %d/%d internal %q", i, res.Passed, res.Total, res.InternalError)
		}
		if i > 0 { // the first one starts the server
			svcTotal += d
		}
	}
	compiles, fallbacks, starts := svc.Stats()
	if compiles != runs || fallbacks != 0 || starts < 3 {
		t.Fatalf("compiles %d fallbacks %d server starts %d, want %d 0 >=3", compiles, fallbacks, starts, runs)
	}
	t.Logf("per submission: sandbox compile %v, compile service %v", sandboxTotal/5, svcTotal/(runs-1))

	svcErr, _ := timed("cs-svc-broken", javaBroken)
	if svcErr.Status != models.SubmissionStatusCompilationError {
		t.Fatalf("service broken: %s", svcErr.Status)
	}
	strip := func(s string) string { return workspacePathRe.ReplaceAllString(s, "") }
	if strip(svcErr.Stderr) != strip(sandboxErr.Stderr) {
		t.Fatalf("compile errors differ:\nsandbox: %q\nservice: %q", strip(sandboxErr.Stderr), strip(svcErr.Stderr))
	}

	// Concurrent compiles.
	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, err := svc.CompileJava(context.Background(), map[string][]byte{"Main.java": []byte(fmt.Sprintf("%s// c%d\n", javaDouble, i))}, []string{"-cp", "/usr/share/java/gson.jar:."})
			if err == nil && (r.Exit != 0 || len(r.Files["Main.class"]) == 0) {
				err = fmt.Errorf("exit %d, %d class bytes: %s", r.Exit, len(r.Files["Main.class"]), r.Output)
			}
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent compile: %v", err)
		}
	}

	// Refused: names outside the workspace and annotation processing.
	if _, err := svc.CompileJava(context.Background(), map[string][]byte{"../Main.java": []byte(javaDouble)}, nil); !errors.Is(err, compilesvc.ErrUnavailable) {
		t.Fatalf("a path outside the workspace was accepted: %v", err)
	}
	if _, err := svc.CompileJava(context.Background(), map[string][]byte{"Main.java": []byte(javaDouble)}, []string{"-processor", "Evil"}); !errors.Is(err, compilesvc.ErrUnavailable) {
		t.Fatalf("an annotation processor was accepted: %v", err)
	}
	// The server keeps working after refusing.
	if r, err := svc.CompileJava(context.Background(), map[string][]byte{"Main.java": []byte(javaDouble)}, []string{"-cp", "/usr/share/java/gson.jar:."}); err != nil || r.Exit != 0 {
		t.Fatalf("compile after refusals: %v %+v", err, r)
	}

	// An image without the compile server: the sandbox compiles, verdicts unchanged.
	noServer := compilesvc.New(exec.Client(), languages.GetLanguage("python").ImageRef())
	defer noServer.Close()
	exec.SetExternalCompiler(noServer)
	res, _ := timed("cs-fallback", javaDouble+"// fb\n")
	if res.Passed != 2 || res.Total != 3 {
		t.Fatalf("fallback: %d/%d", res.Passed, res.Total)
	}
	if _, fb, _ := noServer.Stats(); fb == 0 {
		t.Fatal("no fallback recorded")
	}
}
