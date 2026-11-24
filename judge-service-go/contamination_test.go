//go:build integration

package main

import (
	"judge-service-go/pkg/models"
	"testing"
)

func TestContainerContamination(t *testing.T) {
	langsToTest := []string{"go", "cpp", "c"}

	for _, langID := range langsToTest {
		t.Run(langID, func(t *testing.T) {
			exec, p, pc, lang := setupIntegration(t, langID)
			defer p.Release(pc)

			// Problem 1: Write to /tmp
			probWrite := models.Problem{
				Title: "Contamination Write", FunctionName: "solve", ReturnType: "boolean",
				Parameters: []models.Parameter{},
				TestCases:  []models.TestCase{{Input: []interface{}{}, Expected: true}},
			}

			var codeWrite string
			switch langID {
			case "python":
				codeWrite = "def solve():\n  with open('/tmp/contamination.txt', 'w') as f: f.write('hello')\n  return True"
			case "javascript":
				codeWrite = "const fs = require('fs');\nfunction solve() {\n  fs.writeFileSync('/tmp/contamination.txt', 'hello');\n  return true;\n}"
			case "go":
				codeWrite = "import \"os\"\nfunc solve() bool {\n  os.WriteFile(\"/tmp/contamination.txt\", []byte(\"hello\"), 0644)\n  return true\n}"
			case "cpp":
				codeWrite = "#include <fstream>\nclass Solution {\npublic:\n  bool solve() {\n    std::ofstream f(\"/tmp/contamination.txt\");\n    f << \"hello\";\n    return true;\n  }\n};"
			case "c":
				codeWrite = "#include <stdio.h>\n#include <stdbool.h>\nbool solve() {\n  FILE *f = fopen(\"/tmp/contamination.txt\", \"w\");\n  if (f) { fprintf(f, \"hello\"); fclose(f); }\n  return true;\n}"
			}

			res1 := runCertificationTest(t, exec, pc, lang, probWrite, codeWrite, "contam-1")
			if res1.Status != models.SubmissionStatusAccepted {
				t.Fatalf("first run failed: %v", res1.Stderr)
			}

			// Problem 2: Check if file exists
			probRead := models.Problem{
				Title: "Contamination Read", FunctionName: "solve", ReturnType: "boolean",
				Parameters: []models.Parameter{},
				TestCases:  []models.TestCase{{Input: []interface{}{}, Expected: false}},
			}

			var codeRead string
			switch langID {
			case "python":
				codeRead = "import os\ndef solve(): return os.path.exists('/tmp/contamination.txt')"
			case "javascript":
				codeRead = "const fs = require('fs');\nfunction solve() { return fs.existsSync('/tmp/contamination.txt'); }"
			case "go":
				codeRead = "import \"os\"\nfunc solve() bool {\n  _, err := os.Stat(\"/tmp/contamination.txt\")\n  return err == nil\n}"
			case "cpp":
				codeRead = "#include <fstream>\nclass Solution {\npublic:\n  bool solve() {\n    std::ifstream f(\"/tmp/contamination.txt\");\n    return f.good();\n  }\n};"
			case "c":
				codeRead = "#include <stdio.h>\n#include <stdbool.h>\nbool solve() {\n  FILE *f = fopen(\"/tmp/contamination.txt\", \"r\");\n  if (f) { fclose(f); return true; }\n  return false;\n}"
			}

			res2 := runCertificationTest(t, exec, pc, lang, probRead, codeRead, "contam-2")

			if res2.Status != models.SubmissionStatusAccepted {
				if res2.Status == models.SubmissionStatusWrongAnswer {
					t.Errorf("CONTAMINATION DETECTED for %s: /tmp/contamination.txt exists!", langID)
				} else {
					t.Fatalf("second run failed with %v: %v", res2.Status, res2.Stderr)
				}
			}
		})
	}
}
