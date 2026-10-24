package adapters

import (
	"fmt"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
	"judge-service-go/pkg/wrapper"
)

type CAdapter struct{}

func (CAdapter) Name() string {
	return "c"
}

func (CAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("c")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "c_wrapper.tpl")
	if err != nil {
		return nil, err
	}

	if err := workspace.WriteFile(workDir, "solution.c", []byte(submissionMsg.Code), 0644); err != nil {
		return nil, fmt.Errorf("failed to write solution.c: %w", err)
	}
	if err := workspace.WriteFile(workDir, "main.c", []byte(wrapperCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write main.c: %w", err)
	}

	return []string{"solution.c", "main.c"}, nil
}

func (CAdapter) CompileCommand() []string {
	return []string{"gcc", "-O2", "-o", "/app/main", "/app/main.c", "-ljson-c", "-lm"}
}

func (CAdapter) RunCommand(inputB64 string) []string {
	return []string{"/app/main", inputB64}
}
