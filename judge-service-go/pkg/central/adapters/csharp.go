package adapters

import (
	"fmt"
	"strings"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/workspace"
	"judge-service-go/pkg/wrapper"
)

type CSharpAdapter struct{}

func (CSharpAdapter) Name() string {
	return "csharp"
}

func (CSharpAdapter) PrepareFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("csharp")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "csharp_wrapper.tpl")
	if err != nil {
		return nil, err
	}

	finalCode := strings.Replace(wrapperCode, "// USER_CODE_MARKER", submissionMsg.Code, 1)

	if err := workspace.WriteFile(workDir, "Program.cs", []byte(finalCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write Program.cs: %w", err)
	}

	return []string{"Program.cs"}, nil
}

// PrepareBatchFiles writes the wrapper that runs every test in one process (JUDGE_FIX_PLAN T5).
func (CSharpAdapter) PrepareBatchFiles(workDir string, submissionMsg models.SubmissionMessage, problem models.Problem) ([]string, error) {
	lang := languages.GetLanguage("csharp")
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "csharp_batch_wrapper.tpl")
	if err != nil {
		return nil, err
	}
	finalCode := strings.Replace(wrapperCode, "// USER_CODE_MARKER", submissionMsg.Code, 1)
	if err := workspace.WriteFile(workDir, "Program.cs", []byte(finalCode), 0644); err != nil {
		return nil, fmt.Errorf("failed to write Program.cs: %w", err)
	}
	return []string{"Program.cs"}, nil
}

func (CSharpAdapter) BatchRunCommand(testsB64 string) []string {
	return []string{"dotnet", "out/app.dll", testsB64}
}

func (CSharpAdapter) RunCommand(inputB64 string) []string {
	return []string{"dotnet", "out/app.dll", inputB64}
}

func (CSharpAdapter) CompileCommand() []string {
	return []string{"sh", "-c", "cp /home/judge/app/app.csproj . && dotnet build -c Release -o out /p:StartupObject=Harness"}
}
