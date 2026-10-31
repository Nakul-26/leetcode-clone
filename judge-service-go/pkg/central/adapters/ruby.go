package adapters

import (
	"fmt"
	"strings"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
	"judge-service-go/pkg/wrapper"
)

type RubyAdapter struct{}

func (RubyAdapter) Name() string {
	return "ruby"
}

func (RubyAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("ruby")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "ruby_single_wrapper.tpl")
	if err != nil {
		return nil, err
	}

	finalCode := strings.Replace(wrapperCode, "# USER_CODE_MARKER", submissionMsg.Code, 1)

	if err := workspace.WriteFile(workDir, "wrapper.rb", []byte(finalCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write wrapper.rb: %w", err)
	}

	return []string{"wrapper.rb"}, nil
}

// PrepareBatchFiles writes the wrapper that runs every test in one process (JUDGE_FIX_PLAN T5).
func (RubyAdapter) PrepareBatchFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("ruby")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "ruby_batch_wrapper.tpl")
	if err != nil {
		return nil, err
	}
	finalCode := strings.Replace(wrapperCode, "# USER_CODE_MARKER", submissionMsg.Code, 1)
	if err := workspace.WriteFile(workDir, "wrapper.rb", []byte(finalCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write wrapper.rb: %w", err)
	}
	return []string{"wrapper.rb"}, nil
}

func (RubyAdapter) BatchRunCommand(testsB64 string) []string {
	return []string{"ruby", "/app/wrapper.rb", testsB64}
}

func (RubyAdapter) RunCommand(inputB64 string) []string {
	return []string{"ruby", "/app/wrapper.rb", inputB64}
}
