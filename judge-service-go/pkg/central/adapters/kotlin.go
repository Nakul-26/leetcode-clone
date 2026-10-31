package adapters

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
)

type KotlinAdapter struct{}

func (KotlinAdapter) Name() string {
	return "kotlin"
}

func (KotlinAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	tplPath := filepath.Join("pkg", "wrappers", "kotlin_wrapper.tpl")
	b, err := os.ReadFile(tplPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read template %s: %w", tplPath, err)
	}

	wrapperCode := strings.ReplaceAll(string(b), "{{FUNCTION_NAME}}", submissionMsg.FunctionName)

	if err := workspace.WriteFile(workDir, "Solution.kt", []byte(submissionMsg.Code), 0644); err != nil {
		return nil, fmt.Errorf("failed to write Solution.kt: %w", err)
	}
	if err := workspace.WriteFile(workDir, "Harness.kt", []byte(wrapperCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write Harness.kt: %w", err)
	}

	return []string{"Solution.kt", "Harness.kt"}, nil
}

// PrepareBatchFiles writes the wrapper that runs every test in one process (JUDGE_FIX_PLAN T5).
func (KotlinAdapter) PrepareBatchFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	tplPath := filepath.Join("pkg", "wrappers", "kotlin_batch_wrapper.tpl")
	b, err := os.ReadFile(tplPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read template %s: %w", tplPath, err)
	}
	wrapperCode := strings.ReplaceAll(string(b), "{{FUNCTION_NAME}}", submissionMsg.FunctionName)
	if err := workspace.WriteFile(workDir, "Solution.kt", []byte(submissionMsg.Code), 0644); err != nil {
		return nil, fmt.Errorf("failed to write Solution.kt: %w", err)
	}
	if err := workspace.WriteFile(workDir, "Harness.kt", []byte(wrapperCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write Harness.kt: %w", err)
	}
	return []string{"Solution.kt", "Harness.kt"}, nil
}

func (k KotlinAdapter) BatchRunCommand(testsB64 string) []string {
	return k.RunCommand(testsB64)
}

func (KotlinAdapter) CompileCommand() []string {
	return []string{"kotlinc", "-cp", "/usr/share/java/gson.jar", "-d", "/app/out", "/app/Solution.kt", "/app/Harness.kt"}
}

func (KotlinAdapter) RunCommand(inputB64 string) []string {
	return []string{"java", jvmHeapFlag, "-cp", "/app/out:/opt/kotlinc/lib/kotlin-stdlib.jar:/usr/share/java/gson.jar", "HarnessKt", inputB64}
}
