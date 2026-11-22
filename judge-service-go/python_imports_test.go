//go:build integration

package main

import (
	"testing"

	"judge-service-go/pkg/models"
)

// TestPythonStandardImports: function-mode Python solutions can import the standard library.
// The wrapper used to remove the exec and compile builtins, which Python's import system needs
// to load any module without a compiled .pyc (the image has none), so `from typing import List`,
// heapq, bisect, copy, random, datetime and most of the library failed.
func TestPythonStandardImports(t *testing.T) {
	exec, p, pc, lang := setupIntegration(t, "python")
	defer p.Release(pc)

	problem := models.Problem{
		Title: "Imports", FunctionName: "solve", ReturnType: "number",
		Parameters: []models.Parameter{{Name: "nums", Type: "array<number>"}},
		TestCases:  []models.TestCase{{Input: []interface{}{[]interface{}{5, 1, 4}}, Expected: 3}},
	}
	code := `from typing import List
import heapq, bisect, copy, random, datetime, string, queue, decimal, fractions, statistics
from dataclasses import dataclass

class Solution:
    def solve(self, nums: List[int]) -> int:
        h = copy.copy(nums)
        heapq.heapify(h)
        smallest = heapq.heappop(h)
        s = sorted(nums)
        return bisect.bisect_left(s, 5) + smallest - 1 + int(statistics.median([1, 1, 1]))
`
	res := runCertificationTest(t, exec, pc, lang, problem, code, "python-imports")
	if res.Status != models.SubmissionStatusAccepted {
		t.Fatalf("status %v, stderr: %s", res.Status, res.Stderr)
	}
}
