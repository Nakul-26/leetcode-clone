package adapters

import (
	"fmt"

	"judge-service-go/pkg/workspace"
)

// StdinLanguageAdapter isolates language-specific source preparation and
// execution for ProblemType: stdin (pkg/models/problem_type.go). Unlike
// LanguageAdapter, there is no generated wrapper — the user's program is
// written to disk as-is and reads its own input from stdin, so RunCommand
// takes no per-call argument (test input is piped in by
// executor.RunInContainerWithStdin instead).
type StdinLanguageAdapter interface {
	Name() string
	PrepareFiles(workDir string, code string) ([]string, error)
	RunCommand() []string
}

// CompilingStdinLanguageAdapter is implemented by stdin adapters whose
// language needs a compile step before RunCommand can execute.
type CompilingStdinLanguageAdapter interface {
	StdinLanguageAdapter
	CompileCommand() []string
}

// This registry is the single definition of "how do I build and run a
// standalone program that reads stdin and writes stdout" for every supported
// language. main.go's rawRunFilesAndCommands (the /raw-run endpoint) resolves
// its files and commands from here too, so the queue-backed stdin path and the
// synchronous raw path cannot drift apart.
//
// They previously did drift, in ways that mattered:
//   - Only python, javascript, cpp, c and go had stdin adapters at all, so the
//     stdin path silently rejected the other seven languages — including Java,
//     the second most used language in exams. /raw-run supported all twelve.
//   - cpp and c compiled at -O2 here but at the default -O0 via
//     languages.go's CompileCmd, which /raw-run reused.
//   - This file's Go compile command omitted the GOPROXY=off/GOTOOLCHAIN=local
//     hardening that languages.go documents as necessary: without it a build in
//     a network-disabled sandbox can hang until the sandbox timeout instead of
//     failing fast.
//
// Paths are written as /app/... and rewritten to the real per-submission
// workspace by executor.rewriteCommandForWorkspace, which also sets it as the
// working directory — so a relative path such as `.` on a classpath resolves to
// the same place.
//
// Two concrete types rather than one with a nillable compile command, so that
// "needs compiling" stays a type-level fact: the runner's
// CompilingStdinLanguageAdapter type assertion is the only thing that decides
// whether a compile step runs.

// interpretedStdinAdapter runs source directly, with no build step.
type interpretedStdinAdapter struct {
	name     string
	fileName string
	runCmd   []string
}

func (a interpretedStdinAdapter) Name() string { return a.name }

func (a interpretedStdinAdapter) PrepareFiles(workDir string, code string) ([]string, error) {
	return writeStdinSource(workDir, a.fileName, code)
}

func (a interpretedStdinAdapter) RunCommand() []string { return a.runCmd }

// compiledStdinAdapter builds an artifact once, then executes it per test case.
type compiledStdinAdapter struct {
	name       string
	fileName   string
	compileCmd []string
	runCmd     []string
}

func (a compiledStdinAdapter) Name() string { return a.name }

func (a compiledStdinAdapter) PrepareFiles(workDir string, code string) ([]string, error) {
	return writeStdinSource(workDir, a.fileName, code)
}

func (a compiledStdinAdapter) CompileCommand() []string { return a.compileCmd }

func (a compiledStdinAdapter) RunCommand() []string { return a.runCmd }

func writeStdinSource(workDir, fileName, code string) ([]string, error) {
	if err := workspace.WriteFile(workDir, fileName, []byte(code), 0644); err != nil {
		return nil, fmt.Errorf("failed to write %s: %w", fileName, err)
	}
	return []string{fileName}, nil
}

// StdinAdapterRegistry mirrors AdapterRegistry's dispatch shape for the stdin
// problem model, and now covers the same twelve languages as
// languages.Languages.
//
// Two languages constrain what the student may submit, because the run command
// has to name an entry point before the source exists:
//   - Java: the program's class must be `Main` (compiled as Main.java).
//   - Kotlin: the file compiles to class `MainKt`, i.e. a top-level `fun main()`.
var StdinAdapterRegistry = map[string]StdinLanguageAdapter{
	"python": interpretedStdinAdapter{
		name: "python", fileName: "solution.py",
		runCmd: []string{"python", "/app/solution.py"},
	},
	"javascript": interpretedStdinAdapter{
		name: "javascript", fileName: "solution.js",
		runCmd: []string{"node", "/app/solution.js"},
	},
	"typescript": interpretedStdinAdapter{
		name: "typescript", fileName: "solution.ts",
		runCmd: []string{"tsx", "/app/solution.ts"},
	},
	"ruby": interpretedStdinAdapter{
		name: "ruby", fileName: "solution.rb",
		runCmd: []string{"ruby", "/app/solution.rb"},
	},
	"php": interpretedStdinAdapter{
		name: "php", fileName: "solution.php",
		runCmd: []string{"php", "/app/solution.php"},
	},
	"c": compiledStdinAdapter{
		name: "c", fileName: "main.c",
		// -ljson-c is kept from languages.go's CompileCmd even though a stdin
		// program has no reason to use it: dropping a link flag could only break
		// a submission that does, and linking it unused costs nothing.
		compileCmd: []string{"gcc", "-O2", "-o", "/app/main", "/app/main.c", "-ljson-c", "-lm"},
		runCmd:     []string{"/app/main"},
	},
	"cpp": compiledStdinAdapter{
		name: "cpp", fileName: "main.cpp",
		compileCmd: []string{"g++", "-O2", "-o", "/app/main", "/app/main.cpp"},
		runCmd:     []string{"/app/main"},
	},
	"go": compiledStdinAdapter{
		name: "go", fileName: "main.go",
		// The environment exports are load-bearing, not cargo-culted: with the
		// network disabled, an unconfigured `go build` can try to reach the module
		// proxy or check for a toolchain switch and hang for the full sandbox
		// timeout rather than failing fast (see languages.go).
		compileCmd: []string{"sh", "-c",
			"export GOFLAGS=-mod=mod GOPROXY=off GOSUMDB=off GO111MODULE=on GOTOOLCHAIN=local; " +
				"go mod init solution 2>/dev/null || true; go build -o main ."},
		runCmd: []string{"./main"},
	},
	"rust": compiledStdinAdapter{
		name: "rust", fileName: "main.rs",
		compileCmd: []string{"rustc", "--edition", "2021", "-O", "-o", "/app/main", "/app/main.rs"},
		runCmd:     []string{"/app/main"},
	},
	"java": compiledStdinAdapter{
		name: "java", fileName: "Main.java",
		// gson stays on both paths' classpath because the image ships it and a
		// submission may import it; jvmHeapFlag sizes the heap from the
		// problem's memory limit (see java.go).
		compileCmd: []string{"javac", "-cp", "/usr/share/java/gson.jar:.", "/app/Main.java"},
		runCmd:     []string{"java", jvmHeapFlag, "-cp", "/usr/share/java/gson.jar:.", "Main"},
	},
	"kotlin": compiledStdinAdapter{
		name: "kotlin", fileName: "Main.kt",
		// Unlike the wrapper flow (Solution.kt + Harness.kt), a stdin submission is
		// a single self-contained file whose own top-level main() is the entry point.
		compileCmd: []string{"kotlinc", "-cp", "/usr/share/java/gson.jar", "-d", "/app/out", "/app/Main.kt"},
		runCmd:     []string{"java", jvmHeapFlag, "-cp", "/app/out:/opt/kotlinc/lib/kotlin-stdlib.jar:/usr/share/java/gson.jar", "MainKt"},
	},
	"csharp": compiledStdinAdapter{
		name: "csharp", fileName: "Program.cs",
		// The image pre-warms a `dotnet new console` project at /home/judge/app so
		// the first real build isn't paying SDK/restore cold-start cost. No
		// /p:StartupObject override here: unlike the wrapper flow there is no
		// Harness class competing with the student's entry point.
		compileCmd: []string{"sh", "-c", "cp /home/judge/app/app.csproj . && dotnet build -c Release -o out"},
		runCmd:     []string{"dotnet", "out/app.dll"},
	},
}

func GetStdinAdapter(language string) (StdinLanguageAdapter, bool) {
	adapter, ok := StdinAdapterRegistry[language]
	return adapter, ok
}

// StdinCompileCommand returns the adapter's compile command, or nil when the
// language is interpreted. Exposed so callers that drive compile and run
// themselves (main.go's /raw-run) don't each have to repeat the
// CompilingStdinLanguageAdapter type assertion.
func StdinCompileCommand(adapter StdinLanguageAdapter) []string {
	if compiling, ok := adapter.(CompilingStdinLanguageAdapter); ok {
		return compiling.CompileCommand()
	}
	return nil
}
