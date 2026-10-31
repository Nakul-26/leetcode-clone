package adapters

import (
	"fmt"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
	"judge-service-go/pkg/wrapper"
)

type RustAdapter struct{}

func (RustAdapter) Name() string {
	return "rust"
}

func (RustAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("rust")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "rust_wrapper.tpl")
	if err != nil {
		return nil, err
	}

	// Rust needs the user's code in its own file, included verbatim into the
	// harness via `include!`, so it shares scope with the harness (no `pub`
	// requirements, matching the plain "struct Solution;" convention used on
	// LeetCode-style judges).
	if err := workspace.WriteFile(workDir, "solution.rs", []byte(submissionMsg.Code), 0644); err != nil {
		return nil, fmt.Errorf("failed to write solution.rs: %w", err)
	}

	if err := workspace.WriteFile(workDir, "main.rs", []byte(wrapperCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write main.rs: %w", err)
	}

	return []string{"solution.rs", "main.rs"}, nil
}

// PrepareBatchFiles writes the wrapper that runs every test in one process (JUDGE_FIX_PLAN T5).
func (RustAdapter) PrepareBatchFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("rust")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "rust_batch_wrapper.tpl")
	if err != nil {
		return nil, err
	}
	if err := workspace.WriteFile(workDir, "solution.rs", []byte(submissionMsg.Code), 0644); err != nil {
		return nil, fmt.Errorf("failed to write solution.rs: %w", err)
	}
	if err := workspace.WriteFile(workDir, "main.rs", []byte(wrapperCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write main.rs: %w", err)
	}
	return []string{"solution.rs", "main.rs"}, nil
}

func (RustAdapter) BatchRunCommand(testsB64 string) []string {
	return []string{"/app/main", testsB64}
}

func (RustAdapter) CompileCommand() []string {
	return []string{"rustc", "--edition", "2021", "-O", "-o", "/app/main", "/app/main.rs"}
}

func (RustAdapter) RunCommand(inputB64 string) []string {
	return []string{"/app/main", inputB64}
}
