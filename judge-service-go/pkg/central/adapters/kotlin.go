package adapters

import (
	"fmt"
	"os"
	"path/filepath"

	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
)

type KotlinAdapter struct{}

func (KotlinAdapter) Name() string {
	return "kotlin"
}

// The harnesses (pkg/wrappers/kotlin_wrapper.tpl and kotlin_batch_wrapper.tpl) are compiled
// into judge-kotlin-env at /opt/judge-harness/{single,batch} (JUDGE_FIX_PLAN T9), so a
// submission compiles only Solution.kt: ~4 s instead of ~13 s on one core. The harness source
// still goes into the workspace, and the compile step falls back to compiling it too when the
// image has no prebuilt harness (an image built before T9). The harness reads the function to
// call from judge-function.
const (
	kotlinHarnessSingle = "/opt/judge-harness/single"
	kotlinHarnessBatch  = "/opt/judge-harness/batch"
)

func (KotlinAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	return prepareKotlinFiles(workDir, submissionMsg, "kotlin_wrapper.tpl")
}

// PrepareBatchFiles writes the files for the harness that runs every test in one process
// (JUDGE_FIX_PLAN T5).
func (KotlinAdapter) PrepareBatchFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	return prepareKotlinFiles(workDir, submissionMsg, "kotlin_batch_wrapper.tpl")
}

func prepareKotlinFiles(workDir string, submissionMsg models.SubmissionMessage, template string) ([]string, error) {
	tplPath := filepath.Join("pkg", "wrappers", template)
	harness, err := os.ReadFile(tplPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read template %s: %w", tplPath, err)
	}
	if err := workspace.WriteFile(workDir, "Solution.kt", []byte(submissionMsg.Code), 0644); err != nil {
		return nil, fmt.Errorf("failed to write Solution.kt: %w", err)
	}
	if err := workspace.WriteFile(workDir, "Harness.kt", harness, 0644); err != nil {
		return nil, fmt.Errorf("failed to write Harness.kt: %w", err)
	}
	if err := workspace.WriteFile(workDir, "judge-function", []byte(submissionMsg.FunctionName), 0644); err != nil {
		return nil, fmt.Errorf("failed to write judge-function: %w", err)
	}
	return []string{"Solution.kt", "Harness.kt", "judge-function"}, nil
}

// kotlincJVMFlags give kotlinc's own JVM a fast start (C1 only, serial GC), as for javac (T8):
// 12.7 -> 7.6 s for Solution.kt + Harness.kt on one core, and ~4 s for Solution.kt alone.
var kotlincJVMFlags = []string{"-J-XX:TieredStopAtLevel=1", "-J-XX:+UseSerialGC"}

// CompileCommand compiles Solution.kt, plus Harness.kt only when the image has no prebuilt
// harness. The paths are passed as arguments so the judge's /app rewriting reaches them.
func (KotlinAdapter) CompileCommand() []string {
	script := `out=$1; solution=$2; harness=$3; shift 3
if [ -f ` + kotlinHarnessSingle + `/HarnessKt.class ] && [ -f ` + kotlinHarnessBatch + `/HarnessKt.class ]; then
	exec kotlinc "$@" -cp /usr/share/java/gson.jar -d "$out" "$solution"
fi
exec kotlinc "$@" -cp /usr/share/java/gson.jar -d "$out" "$solution" "$harness"`
	return append([]string{"sh", "-c", script, "kotlinc", "/app/out", "/app/Solution.kt", "/app/Harness.kt"}, kotlincJVMFlags...)
}

// kotlinRunCommand puts /app/out first, so a harness compiled there by the fallback wins over
// the prebuilt one.
func kotlinRunCommand(harnessDir string, arg string) []string {
	return []string{"java", jvmHeapFlag, "-cp", "/app/out:" + harnessDir + ":/opt/kotlinc/lib/kotlin-stdlib.jar:/usr/share/java/gson.jar", "HarnessKt", arg}
}

func (KotlinAdapter) RunCommand(inputB64 string) []string {
	return kotlinRunCommand(kotlinHarnessSingle, inputB64)
}

func (KotlinAdapter) BatchRunCommand(testsB64 string) []string {
	return kotlinRunCommand(kotlinHarnessBatch, testsB64)
}
