package adapters

import (
	"fmt"
	"strings"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
	"judge-service-go/pkg/wrapper"
)

type PHPAdapter struct{}

func (PHPAdapter) Name() string {
	return "php"
}

// normalizePHPUserCode strips an optional leading "<?php" tag and trailing
// "?>" close tag from user-submitted code, since it is spliced into the
// middle of an already-open <?php block in the wrapper template.
func normalizePHPUserCode(code string) string {
	code = strings.TrimSpace(code)
	if strings.HasPrefix(code, "<?php") {
		code = strings.TrimPrefix(code, "<?php")
	} else if strings.HasPrefix(code, "<?") {
		code = strings.TrimPrefix(code, "<?")
	}
	code = strings.TrimSuffix(strings.TrimSpace(code), "?>")
	return code
}

func (PHPAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("php")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "php_wrapper.tpl")
	if err != nil {
		return nil, err
	}

	userCode := normalizePHPUserCode(submissionMsg.Code)
	finalCode := strings.Replace(wrapperCode, "// USER_CODE_MARKER", userCode, 1)

	if err := workspace.WriteFile(workDir, "wrapper.php", []byte(finalCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write wrapper.php: %w", err)
	}

	return []string{"wrapper.php"}, nil
}

// PrepareBatchFiles writes the wrapper that runs every test in one process (JUDGE_FIX_PLAN T5).
func (PHPAdapter) PrepareBatchFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("php")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "php_batch_wrapper.tpl")
	if err != nil {
		return nil, err
	}
	finalCode := strings.Replace(wrapperCode, "// USER_CODE_MARKER", normalizePHPUserCode(submissionMsg.Code), 1)
	if err := workspace.WriteFile(workDir, "wrapper.php", []byte(finalCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write wrapper.php: %w", err)
	}
	return []string{"wrapper.php"}, nil
}

func (PHPAdapter) BatchRunCommand(testsB64 string) []string {
	return []string{"php", "/app/wrapper.php", testsB64}
}

func (PHPAdapter) RunCommand(inputB64 string) []string {
	return []string{"php", "/app/wrapper.php", inputB64}
}
