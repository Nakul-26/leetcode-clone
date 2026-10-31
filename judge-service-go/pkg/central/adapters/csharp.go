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
	return csharpCompileCommand("Harness")
}

// csharpCompileScript compiles Program.cs with the SDK's Roslyn compiler (csc.dll) directly
// instead of `dotnet build` (JUDGE_FIX_PLAN T9): MSBuild's start-up and restore cost seconds
// for a one-file program. Measured on one core: best 4.8 -> 3.4 s, median 7.7 -> 3.9 s, and
// that was dotnet build reusing its own obj/ folder, which a fresh workspace never has. It
// adds what the SDK would: the implicit global usings of a console project, nullable
// warnings, an optimised build, and the runtime config `dotnet out/app.dll` needs. With no
// SDK compiler or reference pack where expected, it falls back to dotnet build. $1 is the
// entry class ("" to let the compiler find Main).
const csharpCompileScript = `main=$1
csc=$(ls /usr/share/dotnet/sdk/*/Roslyn/bincore/csc.dll 2>/dev/null | tail -n 1)
ref=$(ls -d /usr/share/dotnet/packs/Microsoft.NETCore.App.Ref/*/ref/net*.0 2>/dev/null | tail -n 1)
if [ -z "$csc" ] || [ -z "$ref" ]; then
	cp /home/judge/app/app.csproj . && exec dotnet build -c Release -o out ${main:+/p:StartupObject=$main}
fi
tfm=$(basename "$ref")
ver=$(basename "$(dirname "$(dirname "$ref")")" | cut -d. -f1,2).0
mkdir -p out
printf 'global using System;\nglobal using System.Collections.Generic;\nglobal using System.IO;\nglobal using System.Linq;\nglobal using System.Net.Http;\nglobal using System.Threading;\nglobal using System.Threading.Tasks;\n' > judge-global-usings.cs
printf '{"runtimeOptions":{"tfm":"%s","framework":{"name":"Microsoft.NETCore.App","version":"%s"}}}\n' "$tfm" "$ver" > out/app.runtimeconfig.json
set --
for f in "$ref"/*.dll; do set -- "$@" "-r:$f"; done
exec dotnet exec "$csc" -nologo -optimize+ -nullable:enable -langversion:latest -target:exe ${main:+-main:$main} -define:TRACE,RELEASE,NET,NETCOREAPP -out:out/app.dll "$@" Program.cs judge-global-usings.cs`

func csharpCompileCommand(mainClass string) []string {
	return []string{"sh", "-c", csharpCompileScript, "csc-judge", mainClass}
}
