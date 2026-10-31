package adapters

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// judge-kotlin-env compiles copies of the Kotlin harnesses into the image (JUDGE_FIX_PLAN T9).
// The image build cannot read pkg/wrappers, so the copies live next to its Dockerfile; this
// keeps them identical to the templates the judge writes into each workspace.
func TestKotlinImageHarnessesMatchTheTemplates(t *testing.T) {
	root := filepath.Join("..", "..", "..")
	for template, copy := range map[string]string{
		"kotlin_wrapper.tpl":       "single/Harness.kt",
		"kotlin_batch_wrapper.tpl": "batch/Harness.kt",
	} {
		want, err := os.ReadFile(filepath.Join(root, "pkg", "wrappers", template))
		if err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(filepath.Join(root, "environments", "kotlin", "harness", copy))
		if err != nil {
			t.Fatal(err)
		}
		norm := func(b []byte) string { return strings.ReplaceAll(string(b), "\r\n", "\n") }
		if norm(got) != norm(want) {
			t.Errorf("environments/kotlin/harness/%s differs from pkg/wrappers/%s: copy the template over it", copy, template)
		}
		if strings.Contains(norm(want), "{{") {
			t.Errorf("%s has a placeholder; the prebuilt harness cannot be filled in per submission", template)
		}
	}
}
