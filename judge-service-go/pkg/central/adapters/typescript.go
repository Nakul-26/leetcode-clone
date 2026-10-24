package adapters

import (
	"fmt"
	"strings"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
	"judge-service-go/pkg/wrapper"
)

type TypeScriptAdapter struct{}

func (TypeScriptAdapter) Name() string {
	return "typescript"
}

func (TypeScriptAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("typescript")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "ts_wrapper.tpl")
	if err != nil {
		return nil, err
	}

	finalCode := strings.Replace(wrapperCode, "// USER_CODE_MARKER", submissionMsg.Code, 1)

	if err := workspace.WriteFile(workDir, "wrapper.ts", []byte(finalCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write wrapper.ts: %w", err)
	}

	return []string{"wrapper.ts"}, nil
}

func (TypeScriptAdapter) RunCommand(inputB64 string) []string {
	return []string{"tsx", "/app/wrapper.ts", inputB64}
}
