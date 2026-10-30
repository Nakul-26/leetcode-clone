package adapters

import (
	"fmt"
	"strings"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
	"judge-service-go/pkg/wrapper"
)

type GoAdapter struct{}

func (GoAdapter) Name() string {
	return "go"
}

func (GoAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	return prepareGoFiles(workDir, submissionMsg, problem, "")
}

// PrepareBatchFiles writes the wrapper that runs every test in one process (JUDGE_FIX_PLAN T5).
func (GoAdapter) PrepareBatchFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	return prepareGoFiles(workDir, submissionMsg, problem, "go_batch_wrapper.tpl")
}

func (GoAdapter) BatchRunCommand(testsB64 string) []string {
	return []string{"./main", testsB64}
}

func prepareGoFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem, template string) ([]string, error) {
	lang := languages.GetLanguage("go")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, template)
	if err != nil {
		return nil, err
	}

	// Go needs the user code and wrapper in the same package (main) to compile together.
	// We'll write them as main.go and solution.go.
	solutionCode := submissionMsg.Code
	if !strings.Contains(solutionCode, "package ") {
		solutionCode = "package main\n\n" + solutionCode
	}

	if err := workspace.WriteFile(workDir, "solution.go", []byte(solutionCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write solution.go: %w", err)
	}
	
	// Clear USER_CODE_MARKER in the wrapper since the user code is in a separate file
	wrapperCode = strings.Replace(wrapperCode, "// USER_CODE_MARKER", "", 1)
	
	if err := workspace.WriteFile(workDir, "main.go", []byte(wrapperCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write main.go: %w", err)
	}

	return []string{"solution.go", "main.go"}, nil
}

func (GoAdapter) CompileCommand() []string {
	// Delegate to languages.go's CompileCmd (the offline-safe, single source of truth) —
	// don't hand-roll a second copy that can drift out of sync with it.
	return languages.GetLanguage("go").CompileCmd
}

func (GoAdapter) RunCommand(inputB64 string) []string {
	// Run the 'main' binary from the current directory
	return []string{"./main", inputB64}
}
