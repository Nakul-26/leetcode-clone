package adapters

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

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

	return withJudgeIOHash(workDir, []string{"solution.cpp", "main.cpp"})
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

	return withJudgeIOHash(workDir, []string{"solution.cpp", "main.cpp"})
}

// The judge I/O helper's function bodies are compiled into judge-cpp-env once, at
// /opt/judge-cpp/judge_io.o (see pkg/wrappers/cpp_judge_io.inc). Linking it is only safe when
// the image's copy of the helper is the one pasted into main.cpp: the structs must match. So
// the judge writes the hash of its copy next to the code, the image keeps the hash of its own,
// and the compile uses the object only when they are equal.
const (
	cppJudgeIOObject = "/opt/judge-cpp/judge_io.o"
	cppJudgeIOHash   = "/opt/judge-cpp/judge_io.sha"
)

// withJudgeIOHash writes judge-io.sha, the SHA-256 of the helper GenerateWrapper pastes in.
func withJudgeIOHash(workDir string, files []string) ([]string, error) {
	inc, err := os.ReadFile(filepath.Join("pkg", "wrappers", "cpp_judge_io.inc"))
	if err != nil {
		return nil, fmt.Errorf("failed to read cpp_judge_io.inc: %w", err)
	}
	sum := sha256.Sum256(inc)
	if err := workspace.WriteFile(workDir, "judge-io.sha", []byte(hex.EncodeToString(sum[:])), 0644); err != nil {
		return nil, fmt.Errorf("failed to write judge-io.sha: %w", err)
	}
	return append(files, "judge-io.sha"), nil
}

// C++20 and -O2, the same as stdin mode: the image's precompiled <bits/stdc++.h> was
// built with exactly these flags, and g++ silently skips it when they differ. The wrapper
// no longer uses nlohmann::json (JUDGE_FIX_PLAN T11), which had made -O2 too slow to build
// here (-O1 was used instead). Measured 2026-10-30 on one core: 5.4 s -> 1.2 s per compile.
//
// With the prebuilt helper (above) the compile adds -DJUDGE_IO_PREBUILT, which leaves out the
// helper's bodies, and links the object; -D does not stop the precompiled header from being
// used (checked with g++ -H). Without it, or with a different helper, it compiles as before.
func (CppAdapter) CompileCommand() []string {
	script := `out=$1; src=$2; sha=$3; shift 3
if [ -f ` + cppJudgeIOObject + ` ] && [ -f ` + cppJudgeIOHash + ` ] && [ -f "$sha" ] && [ "$(cat "$sha")" = "$(cat ` + cppJudgeIOHash + `)" ]; then
	exec g++ -std=gnu++20 -O2 -DJUDGE_IO_PREBUILT -o "$out" "$src" ` + cppJudgeIOObject + `
fi
exec g++ -std=gnu++20 -O2 -o "$out" "$src"`
	return []string{"sh", "-c", script, "g++", "/app/main", "/app/main.cpp", "/app/judge-io.sha"}
}

func (CppAdapter) RunCommand(inputB64 string) []string {
	return []string{"/app/main", inputB64}
}

func (CppAdapter) BatchRunCommand(testsB64 string) []string {
	return []string{"/app/main", testsB64}
}
