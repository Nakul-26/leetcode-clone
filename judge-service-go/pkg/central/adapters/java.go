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
	return []string{"javac", "-cp", "/usr/share/java/gson.jar:.", "/app/Solution.java", "/app/Main.java"}
}

func (JavaAdapter) RunCommand(inputB64 string) []string {
	return []string{"java", jvmHeapFlag, "-cp", "/usr/share/java/gson.jar:.", "Main", inputB64}
}

func (JavaAdapter) BatchRunCommand(testsB64 string) []string {
	return []string{"java", jvmHeapFlag, "-cp", "/usr/share/java/gson.jar:.", "Main", testsB64}
}
