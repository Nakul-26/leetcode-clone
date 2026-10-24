package adapters

import (
	"fmt"
	"strings"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
	"judge-service-go/pkg/wrapper"
)

type JavaScriptAdapter struct{}

func (JavaScriptAdapter) Name() string {
	return "javascript"
}

func (JavaScriptAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("javascript")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "js_single_wrapper.tpl")
	if err != nil {
		return nil, err
	}

	finalCode := strings.Replace(wrapperCode, "// USER_CODE_MARKER", submissionMsg.Code, 1)

	if err := workspace.WriteFile(workDir, "wrapper.js", []byte(finalCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write wrapper.js: %w", err)
	}

	return []string{"wrapper.js"}, nil
}

func (JavaScriptAdapter) PrepareBatchFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("javascript")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "js_batch_wrapper.tpl")
	if err != nil {
		return nil, err
	}

	finalCode := strings.Replace(wrapperCode, "// USER_CODE_MARKER", submissionMsg.Code, 1)

	if err := workspace.WriteFile(workDir, "wrapper.js", []byte(finalCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write wrapper.js: %w", err)
	}

	return []string{"wrapper.js"}, nil
}

func (JavaScriptAdapter) RunCommand(inputB64 string) []string {
	return []string{"node", "/app/wrapper.js", inputB64}
}

func (JavaScriptAdapter) BatchRunCommand(testsB64 string) []string {
	return []string{"node", "/app/wrapper.js", testsB64}
}

