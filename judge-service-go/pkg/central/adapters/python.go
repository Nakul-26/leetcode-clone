package adapters

import (
	"fmt"
	"strings"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
	"judge-service-go/pkg/wrapper"
)

type PythonAdapter struct{}

func (PythonAdapter) Name() string {
	return "python"
}

func (PythonAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("python")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "python_single_wrapper.tpl")
	if err != nil {
		return nil, err
	}

	finalCode := strings.Replace(wrapperCode, "// USER_CODE_MARKER", submissionMsg.Code, 1)
	finalCode = strings.Replace(finalCode, "# USER_CODE_MARKER", submissionMsg.Code, 1)

	if err := workspace.WriteFile(workDir, "wrapper.py", []byte(finalCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write wrapper.py: %w", err)
	}

	return []string{"wrapper.py"}, nil
}

func (PythonAdapter) PrepareBatchFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("python")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "python_batch_wrapper.tpl")
	if err != nil {
		return nil, err
	}

	finalCode := strings.Replace(wrapperCode, "// USER_CODE_MARKER", submissionMsg.Code, 1)
	finalCode = strings.Replace(finalCode, "# USER_CODE_MARKER", submissionMsg.Code, 1)

	if err := workspace.WriteFile(workDir, "wrapper.py", []byte(finalCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write wrapper.py: %w", err)
	}

	return []string{"wrapper.py"}, nil
}

func (PythonAdapter) RunCommand(inputB64 string) []string {
	return []string{"python", "/app/wrapper.py", inputB64}
}

func (PythonAdapter) BatchRunCommand(testsB64 string) []string {
	return []string{"python", "/app/wrapper.py", testsB64}
}
