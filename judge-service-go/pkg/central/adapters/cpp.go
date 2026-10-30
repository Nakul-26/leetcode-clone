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

// -O2, the same as stdin mode, and nothing else: the image's precompiled <bits/stdc++.h> was
// built with exactly these flags, and g++ silently skips it when they differ. The wrapper
// no longer uses nlohmann::json (JUDGE_FIX_PLAN T11), which had made -O2 too slow to build
// here (-O1 was used instead). Measured 2026-10-30 on one core: 5.4 s -> 1.2 s per compile.
func (CppAdapter) CompileCommand() []string {
	return []string{"g++", "-O2", "-o", "/app/main", "/app/main.cpp"}
}

func (CppAdapter) RunCommand(inputB64 string) []string {
	return []string{"/app/main", inputB64}
}

func (CppAdapter) BatchRunCommand(testsB64 string) []string {
	return []string{"/app/main", testsB64}
}
