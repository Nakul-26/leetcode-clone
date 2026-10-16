package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"judge-service-go/pkg/central/adapters"
	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
)

// The stdin path is what the public GO Judge public API surface runs on once
// submissions go through the queue, so any language /raw-run accepted today but
// the stdin registry lacks would be a silent regression for that caller. These
// seven had no stdin adapter at all, Java included — the second most used
// language in exams.
func TestEveryLanguageHasAStdinAdapter(t *testing.T) {
	for id := range languages.Languages {
		if _, ok := adapters.GetStdinAdapter(id); !ok {
			t.Errorf("language %q has no stdin adapter, so stdin-mode submissions in it fail", id)
		}
	}

	// Named explicitly so a future language added to only one of the two
	// registries is caught by name rather than by a count mismatch.
	for _, id := range []string{"java", "csharp", "typescript", "rust", "ruby", "php", "kotlin"} {
		if _, ok := adapters.GetStdinAdapter(id); !ok {
			t.Errorf("regression: %q lost its stdin adapter", id)
		}
	}
}

func TestStdinAdapterRegistryCoversNoUnknownLanguages(t *testing.T) {
	for id := range adapters.StdinAdapterRegistry {
		if languages.GetLanguage(id) == nil {
			t.Errorf("stdin adapter %q has no matching entry in languages.Languages", id)
		}
	}
}

// rawRunFilesAndCommands now delegates to the registry rather than keeping its
// own switch. This asserts the delegation really happened for every language —
// the two definitions drifting apart is the bug being prevented.
func TestRawRunDelegatesToStdinAdapters(t *testing.T) {
	for id := range languages.Languages {
		t.Run(id, func(t *testing.T) {
			lang := languages.GetLanguage(id)
			adapter, ok := adapters.GetStdinAdapter(id)
			if !ok {
				t.Fatalf("no stdin adapter for %q", id)
			}

			files, compileCmd, runCmd, err := rawRunFilesAndCommands(lang, "print(1)", t.TempDir())
			if err != nil {
				t.Fatalf("rawRunFilesAndCommands: %v", err)
			}

			if got, want := strings.Join(runCmd, " "), strings.Join(adapter.RunCommand(), " "); got != want {
				t.Errorf("run command drifted from adapter:\n raw-run: %s\n adapter: %s", got, want)
			}
			if got, want := strings.Join(compileCmd, " "), strings.Join(adapters.StdinCompileCommand(adapter), " "); got != want {
				t.Errorf("compile command drifted from adapter:\n raw-run: %s\n adapter: %s", got, want)
			}
			if len(files) != 1 {
				t.Errorf("expected exactly one source file, got %v", files)
			}
		})
	}
}

func TestStdinAdapterWritesTheFileItRuns(t *testing.T) {
	for id, adapter := range adapters.StdinAdapterRegistry {
		t.Run(id, func(t *testing.T) {
			dir := t.TempDir()
			files, err := adapter.PrepareFiles(dir, "source body")
			if err != nil {
				t.Fatalf("PrepareFiles: %v", err)
			}
			if len(files) != 1 {
				t.Fatalf("expected one file, got %v", files)
			}

			body, err := os.ReadFile(filepath.Join(dir, files[0]))
			if err != nil {
				t.Fatalf("source file not written where the run command expects it: %v", err)
			}
			if string(body) != "source body" {
				t.Errorf("source written as %q, want %q", body, "source body")
			}

			// A compiled language whose compile command is empty would silently skip
			// compiling and then try to execute a binary that was never built.
			if compiling, ok := adapter.(adapters.CompilingStdinLanguageAdapter); ok {
				if len(compiling.CompileCommand()) == 0 {
					t.Error("declares itself compiling but returns an empty compile command")
				}
			}
			if len(adapter.RunCommand()) == 0 {
				t.Error("empty run command")
			}
		})
	}
}

// languages.go documents why these exports exist: with the network disabled an
// unconfigured `go build` can try to reach the module proxy or check for a
// toolchain switch and hang for the whole sandbox timeout instead of failing
// fast. The stdin adapter was missing them, so this pins them.
func TestGoStdinCompileIsOfflineSafe(t *testing.T) {
	adapter, ok := adapters.GetStdinAdapter("go")
	if !ok {
		t.Fatal("no go stdin adapter")
	}
	cmd := strings.Join(adapters.StdinCompileCommand(adapter), " ")
	for _, flag := range []string{"GOPROXY=off", "GOSUMDB=off", "GOTOOLCHAIN=local", "GOFLAGS=-mod=mod"} {
		if !strings.Contains(cmd, flag) {
			t.Errorf("go compile command is missing %s, so an offline build can hang: %s", flag, cmd)
		}
	}
}

func TestCompiledStdinLanguagesOptimise(t *testing.T) {
	// C and C++ dominate exam submissions and previously compiled at the default
	// -O0 through the raw path, which was the single cheapest performance fix
	// available on that path.
	for _, id := range []string{"c", "cpp"} {
		adapter, ok := adapters.GetStdinAdapter(id)
		if !ok {
			t.Fatalf("no %s stdin adapter", id)
		}
		cmd := adapters.StdinCompileCommand(adapter)
		if !containsArg(cmd, "-O2") {
			t.Errorf("%s compiles without -O2: %v", id, cmd)
		}
	}

	// A Java submission that can allocate without bound can exhaust the sandbox's
	// memory ceiling on its own.
	java, _ := adapters.GetStdinAdapter("java")
	if !containsArg(java.RunCommand(), "-Xmx256m") {
		t.Errorf("java run command does not bound the heap: %v", java.RunCommand())
	}
}

func containsArg(cmd []string, arg string) bool {
	for _, part := range cmd {
		if part == arg || strings.Contains(part, arg) {
			return true
		}
	}
	return false
}

func TestAdHocProblemIsStdinModeAndCarriesItsOwnTests(t *testing.T) {
	msg := models.SubmissionMessage{
		SchemaVersion: "1",
		SubmissionID:  "507f1f77bcf86cd799439011",
		Kind:          models.SubmissionKindAdHoc,
		ProblemType:   models.StdinProblem,
		Language:      "python",
		Code:          "print(input())",
		Tests:         []models.TestCase{{Input: []interface{}{"hi"}, Expected: "hi"}},
		TimeLimitMs:   4321,
		MemoryLimitMb: 123,
	}

	problem := adHocProblem(msg)

	if problem.EffectiveType() != models.StdinProblem {
		t.Errorf("type = %q, want stdin", problem.EffectiveType())
	}
	if len(problem.TestCases) != 1 || problem.TestCases[0].Expected != "hi" {
		t.Errorf("tests not carried over: %+v", problem.TestCases)
	}
	if problem.TimeLimitMs != 4321 || problem.MemoryLimitMb != 123 {
		t.Errorf("caller limits dropped: time=%d memory=%d", problem.TimeLimitMs, problem.MemoryLimitMb)
	}
	// ValidateBasic is what processSubmission runs next; an ad-hoc problem that
	// cannot pass it would be nacked as bad data.
	if err := problem.ValidateBasic(); err != nil {
		t.Errorf("ad-hoc problem fails ValidateBasic: %v", err)
	}
}

func TestAdHocProblemWithNoExpectedOutputIsValid(t *testing.T) {
	// The GO Judge surface has no expected output: the caller compares results
	// itself. Such a test case must validate, and be reported rather than judged.
	msg := models.SubmissionMessage{
		Kind:        models.SubmissionKindAdHoc,
		ProblemType: models.StdinProblem,
		Tests:       []models.TestCase{{Input: []interface{}{"5\n"}, Expected: nil}},
	}
	problem := adHocProblem(msg)
	if err := problem.ValidateBasic(); err != nil {
		t.Fatalf("a test with no expected output must be valid: %v", err)
	}
}

func TestStdinTestExpectedDistinguishesAbsentFromMalformed(t *testing.T) {
	cases := []struct {
		name     string
		expected interface{}
		wantText string
		wantHas  bool
		wantOk   bool
	}{
		{"present", "42\n", "42\n", true, true},
		{"absent means do not judge", nil, "", false, true},
		{"empty string is still an expectation", "", "", true, true},
		{"malformed is bad test data", 42, "", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			text, has, ok := stdinTestExpected(models.TestCase{Expected: tc.expected})
			if text != tc.wantText || has != tc.wantHas || ok != tc.wantOk {
				t.Errorf("got (%q, %v, %v), want (%q, %v, %v)",
					text, has, ok, tc.wantText, tc.wantHas, tc.wantOk)
			}
		})
	}
}

func TestSubmissionMessageValidateAdHocRules(t *testing.T) {
	base := func() models.SubmissionMessage {
		return models.SubmissionMessage{
			SchemaVersion: "1",
			SubmissionID:  "507f1f77bcf86cd799439011",
			Kind:          models.SubmissionKindAdHoc,
			ProblemType:   models.StdinProblem,
			Language:      "python",
			Code:          "print(1)",
			Tests:         []models.TestCase{{Input: []interface{}{""}, Expected: nil}},
		}
	}

	wellFormed := base()
	if err := wellFormed.Validate(); err != nil {
		t.Fatalf("a well-formed ad-hoc submission must validate: %v", err)
	}

	// An ad-hoc submission needs no functionName, which is what makes it able to
	// skip the wrapper entirely.
	t.Run("rejects a problemId", func(t *testing.T) {
		msg := base()
		msg.ProblemID = "507f1f77bcf86cd799439012"
		if err := msg.Validate(); err == nil {
			t.Error("an ad-hoc submission naming a problem is ambiguous and must be rejected")
		}
	})

	t.Run("rejects function mode", func(t *testing.T) {
		msg := base()
		msg.ProblemType = models.FunctionProblem
		if err := msg.Validate(); err == nil {
			t.Error("ad-hoc function-mode has no wrapper to generate and must be rejected")
		}
	})

	t.Run("rejects an empty test list", func(t *testing.T) {
		msg := base()
		msg.Tests = nil
		if err := msg.Validate(); err == nil {
			t.Error("an ad-hoc submission with no tests would execute nothing")
		}
	})

	// The guard that matters most: a normal submission that loses its problemId
	// must still fail rather than degrade into an unjudged ad-hoc run.
	t.Run("a non-ad-hoc submission still requires a problemId", func(t *testing.T) {
		msg := base()
		msg.Kind = ""
		msg.FunctionName = "solve"
		if err := msg.Validate(); err == nil {
			t.Error("a submission with no kind and no problemId must be rejected")
		}
	})
}

func TestAdHocSourceIsNotUnescaped(t *testing.T) {
	bs := string(rune(92))
	src := "std::cout << \"x" + bs + "n\";"
	adhoc := models.SubmissionMessage{Kind: models.SubmissionKindAdHoc, Code: src}
	if got := stdinSourceFor(adhoc); got != src {
		t.Errorf("ad-hoc source was rewritten: %q", got)
	}
	// Stored-problem behaviour is deliberately unchanged.
	stored := models.SubmissionMessage{Code: src}
	if got := stdinSourceFor(stored); got == src {
		t.Errorf("stored-problem stdin source should still be unescaped")
	}
}
