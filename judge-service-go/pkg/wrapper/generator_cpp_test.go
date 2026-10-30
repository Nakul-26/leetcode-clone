package wrapper

import (
	"os"
	"strings"
	"testing"

	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/models"
)

// The C++ wrappers (JUDGE_FIX_PLAN T11): judge_io in place of nlohmann::json, and
// <bits/stdc++.h> as the first include so g++ can use the image's precompiled header.
func TestGenerateCppWrapper(t *testing.T) {
	wd, _ := os.Getwd()
	if err := os.Chdir("../.."); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chdir(wd) })

	p := models.Problem{
		ReturnType: "array<number>",
		Parameters: []models.Parameter{{Name: "nums", Type: "array<number>"}, {Name: "target", Type: "number"}},
	}
	for _, tpl := range []string{"cpp_single_wrapper.tpl", "cpp_batch_wrapper.tpl"} {
		code, err := GenerateWrapper(p, languages.GetLanguage("cpp"), "twoSum", tpl)
		if err != nil {
			t.Fatalf("%s: %v", tpl, err)
		}
		if first := firstCodeLine(code); first != "#include <bits/stdc++.h>" {
			t.Errorf("%s: first code line is %q, want the <bits/stdc++.h> include", tpl, first)
		}
		for _, want := range []string{
			"namespace judge_io {",
			"#pragma GCC pop_options",
			"std::vector<int> arg0 = judge_io::get<std::vector<int>>(judge_io::at(inputs, 0));",
			"int arg1 = judge_io::get<int>(judge_io::at(inputs, 1));",
			"std::vector<int> output = sol.twoSum(arg0, arg1);",
			"judge_io::print_output(test_no, output);",
		} {
			if !strings.Contains(code, want) {
				t.Errorf("%s: missing %q", tpl, want)
			}
		}
		for _, gone := range []string{"nlohmann/json.hpp", "JUDGE_IO_MARKER", "GENERATED_CALL_MARKER"} {
			if strings.Contains(code, gone) {
				t.Errorf("%s: still contains %q", tpl, gone)
			}
		}
		if strings.Index(code, "namespace judge_io {") > strings.Index(code, `#include "solution.cpp"`) {
			t.Errorf("%s: judge_io must come before the solution", tpl)
		}
	}

	void := models.Problem{ReturnType: "void", Parameters: []models.Parameter{{Name: "nums", Type: "array<number>"}}}
	code, err := GenerateWrapper(void, languages.GetLanguage("cpp"), "sortIt", "cpp_batch_wrapper.tpl")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(code, "sol.sortIt(arg0);\n        judge_io::print_output(test_no, arg0);") {
		t.Errorf("void solution should print its first argument")
	}
}

// firstCodeLine is the first line that is neither blank nor a // comment.
func firstCodeLine(code string) string {
	for _, line := range strings.Split(code, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "//") {
			return line
		}
	}
	return ""
}
