package main

import (
	"strings"
	"testing"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/wrapper"
)

// Java's live judging path is JavaAdapter (pkg/central/adapters/java.go), which never
// calls GenerateWrapper. GenerateWrapper only ever sees Java when the
// JUDGE_CENTRAL_COMPARE_JAVA killswitch disables the central adapter, and that fallback
// had no coverage at all: the lang.ID == "java" branch removed in the Medium-findings
// cleanup built a Go text/template out of java_single_wrapper.tpl, which contains only
// plain {{FUNCTION_NAME}} markers and so could never have parsed. This pins the generic
// string-replacement path it now falls through to, so the killswitch stays usable.
func TestGenerateWrapperJavaKillswitchFallback(t *testing.T) {
	if isCentralCompareEnabled("java") {
		t.Setenv(centralCompareJavaEnv, "false")
	}
	if isCentralCompareEnabled("java") {
		t.Fatal("killswitch did not disable the central Java adapter")
	}

	lang := languages.GetLanguage("java")
	if lang == nil {
		t.Fatal("java is not registered in the language table")
	}

	got, err := wrapper.GenerateWrapper(models.Problem{}, lang, "twoSum", "")
	if err != nil {
		t.Fatalf("GenerateWrapper returned an error for java: %v", err)
	}
	if strings.Contains(got, "{{FUNCTION_NAME}}") {
		t.Error("{{FUNCTION_NAME}} was left unsubstituted in the generated java wrapper")
	}
	if !strings.Contains(got, "twoSum") {
		t.Error("submission function name was not injected into the generated java wrapper")
	}
}
