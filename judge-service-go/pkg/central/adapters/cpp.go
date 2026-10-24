package adapters

import (
	"fmt"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
	"judge-service-go/pkg/wrapper"
)

type CppAdapter struct{}

func (CppAdapter) Name() string {
	return "cpp"
}

func (CppAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("cpp")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "cpp_single_wrapper.tpl")
	if err != nil {
		return nil, err
	}

	if err := workspace.WriteFile(workDir, "solution.cpp", []byte(submissionMsg.Code), 0644); err != nil {
		return nil, fmt.Errorf("failed to write solution.cpp: %w", err)
	}
	if err := workspace.WriteFile(workDir, "main.cpp", []byte(wrapperCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write main.cpp: %w", err)
	}

	return []string{"solution.cpp", "main.cpp"}, nil
}

func (CppAdapter) PrepareBatchFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("cpp")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "cpp_batch_wrapper.tpl")
	if err != nil {
		return nil, err
	}

	if err := workspace.WriteFile(workDir, "solution.cpp", []byte(submissionMsg.Code), 0644); err != nil {
		return nil, fmt.Errorf("failed to write solution.cpp: %w", err)
	}
	if err := workspace.WriteFile(workDir, "main.cpp", []byte(wrapperCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write main.cpp: %w", err)
	}

	return []string{"solution.cpp", "main.cpp"}, nil
}

func (CppAdapter) CompileCommand() []string {
	return []string{"g++", "-O2", "-o", "/app/main", "/app/main.cpp"}
}

func (CppAdapter) RunCommand(inputB64 string) []string {
	return []string{"/app/main", inputB64}
}

func (CppAdapter) BatchRunCommand(testsB64 string) []string {
	return []string{"/app/main", testsB64}
}
