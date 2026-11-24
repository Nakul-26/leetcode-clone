//go:build integration

package main

import (
	"judge-service-go/pkg/models"
	"strings"
	"testing"
)

func TestProcessContamination(t *testing.T) {
	langsToTest := []string{"cpp", "python"}

	for _, langID := range langsToTest {
		t.Run(langID, func(t *testing.T) {
			exec, p, pc, lang := setupIntegration(t, langID)
			defer p.Release(pc)

			// Step 1: Start a background process
			probSpawn := models.Problem{
				Title: "Spawn Background", FunctionName: "solve", ReturnType: "boolean",
				Parameters: []models.Parameter{},
				TestCases:  []models.TestCase{{Input: []interface{}{}, Expected: true}},
			}

			var codeSpawn string
			switch langID {
			case "python":
				codeSpawn = "import os, subprocess\ndef solve():\n  subprocess.Popen(['sleep', '300'])\n  return True"
			case "cpp":
				codeSpawn = "#include <stdlib.h>\nclass Solution {\npublic:\n  bool solve() {\n    system(\"sleep 300 &\");\n    return true;\n  }\n};"
			}

			res1 := runCertificationTest(t, exec, pc, lang, probSpawn, codeSpawn, "spawn-1")
			if res1.Status != models.SubmissionStatusAccepted {
				t.Fatalf("first run failed: %v", res1.Stderr)
			}

			// Step 2: Check if process still exists in a subsequent run
			probCheck := models.Problem{
				Title: "Check Background", FunctionName: "solve", ReturnType: "boolean",
				Parameters: []models.Parameter{},
				TestCases:  []models.TestCase{{Input: []interface{}{}, Expected: false}},
			}

			var codeCheck string
			switch langID {
			case "python":
				codeCheck = "import subprocess\ndef solve():\n  try:\n    subprocess.check_output(['pgrep', 'sleep'])\n    return True\n  except:\n    return False"
			case "cpp":
				codeCheck = "#include <stdlib.h>\nclass Solution {\npublic:\n  bool solve() {\n    return system(\"pgrep sleep\") == 0;\n  }\n};"
			}

			res2 := runCertificationTest(t, exec, pc, lang, probCheck, codeCheck, "spawn-2")

			if res2.Status != models.SubmissionStatusAccepted {
				if res2.Status == models.SubmissionStatusWrongAnswer {
					t.Errorf("PROCESS CONTAMINATION DETECTED for %s: 'sleep' process still running!", langID)
				} else {
					// It's possible pgrep is missing in the container, but it should be there in most dev images
					if strings.Contains(res2.Stderr, "not found") {
						t.Logf("pgrep not found in %s container, skipping test", langID)
						return
					}
					t.Fatalf("second run failed with %v: %v", res2.Status, res2.Stderr)
				}
			}
		})
	}
}
