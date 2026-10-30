package adapters

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
)

// jvmHeapFlag sizes the heap at 75% of the container's memory limit, which the judge sets to
// the problem's limit before running. A fixed -Xmx256m against the default 256 MB limit left
// no room for the JVM itself, so a program using ~230 MB was SIGKILLed; with no flag at all
// the JVM picks about half the limit and a 180 MB program failed. Measured 2026-10-24
// (JUDGE_FIX_PLAN F3/F4). A heap overflow then exits with java.lang.OutOfMemoryError, which
// the executor reports as Memory Limit Exceeded.
const jvmHeapFlag = "-XX:MaxRAMPercentage=75"

// javaClasspath keeps gson on every Java classpath: the wrappers use it and a submission may too.
const javaClasspath = "/usr/share/java/gson.jar:."

// javacCommand compiles with startup tuning measured 2026-10-30 in judge-java-env at the pool's
// 1 CPU (JUDGE_FIX_PLAN T8): javac's own JIT limited to C1 and the serial collector, since a
// compile is too short for C2 to pay off, and its JDK classes mapped from the class-data
// archive built into the image. Median compile 3.2 s -> 1.6 s. -Xshare:auto means an image
// without the archive just runs as before (checked: no warning, output unchanged).
func javacCommand(sources ...string) []string {
	return append([]string{"javac", "-J-XX:TieredStopAtLevel=1", "-J-XX:+UseSerialGC",
		"-J-Xshare:auto", "-J-XX:SharedArchiveFile=/opt/cds/javac.jsa", "-cp", javaClasspath}, sources...)
}

// javaRunCommand runs a compiled program with the run archive (JDK + Gson classes; median
// startup 450 -> 275 ms). The student's code keeps the full tiered JIT: limiting it to C1 saved
// a little more startup but risks slowing CPU-heavy solutions into a time limit.
func javaRunCommand(args ...string) []string {
	return append([]string{"java", jvmHeapFlag, "-XX:+UseSerialGC",
		"-Xshare:auto", "-XX:SharedArchiveFile=/opt/cds/run.jsa", "-cp", javaClasspath}, args...)
}

type JavaAdapter struct{}

func (JavaAdapter) Name() string {
	return "java"
}

func (JavaAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	tplPath := filepath.Join("pkg", "wrappers", "java_single_wrapper.tpl")
	return prepareJavaWrapper(workDir, submissionMsg, tplPath)
}

func (JavaAdapter) PrepareBatchFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	tplPath := filepath.Join("pkg", "wrappers", "java_batch_wrapper.tpl")
	return prepareJavaWrapper(workDir, submissionMsg, tplPath)
}

// Deliberately doesn't call wrapper.GenerateWrapper: Java's wrapper templates
// (java_single_wrapper.tpl / java_batch_wrapper.tpl) only use the plain
// {{FUNCTION_NAME}} marker, so a direct read + string replace is all that's
// needed here — no test-case literal injection, unlike GenerateWrapper's other
// per-language branches.
func prepareJavaWrapper(workDir string, submissionMsg models.SubmissionMessage, tplPath string) ([]string, error) {
	b, err := os.ReadFile(tplPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read template %s: %w", tplPath, err)
	}

	wrapperCode := strings.ReplaceAll(string(b), "{{FUNCTION_NAME}}", submissionMsg.FunctionName)

	if err := workspace.WriteFile(workDir, "Solution.java", []byte(submissionMsg.Code), 0644); err != nil {
		return nil, fmt.Errorf("failed to write Solution.java: %w", err)
	}
	if err := workspace.WriteFile(workDir, "Main.java", []byte(wrapperCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write Main.java: %w", err)
	}

	return []string{"Solution.java", "Main.java"}, nil
}

func (JavaAdapter) CompileCommand() []string {
	return javacCommand("/app/Solution.java", "/app/Main.java")
}

func (JavaAdapter) RunCommand(inputB64 string) []string {
	return javaRunCommand("Main", inputB64)
}

func (JavaAdapter) BatchRunCommand(testsB64 string) []string {
	return javaRunCommand("Main", testsB64)
}
