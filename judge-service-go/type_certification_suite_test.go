//go:build integration

package main

import (
	"judge-service-go/pkg/models"
	"testing"
)

func TestTypeCertificationSuite(t *testing.T) {
	languagesToTest := []string{"python", "javascript", "java", "go", "cpp", "csharp", "typescript", "c"}

	problems := []struct {
		Problem   models.Problem
		Solutions map[string]string
	}{
		{
			Problem: models.Problem{
				Title:        "Empty Array",
				FunctionName: "emptyArray",
				ReturnType:   "array<number>",
				Parameters: []models.Parameter{
					{Name: "nums", Type: "array<number>"},
				},
				TestCases: []models.TestCase{
					{Input: []interface{}{[]interface{}{}}, Expected: []interface{}{}},
				},
			},
			Solutions: map[string]string{
				"python":     "def emptyArray(nums): return nums",
				"javascript": "function emptyArray(nums) { return nums; }",
				"java":       "public class Solution { public int[] emptyArray(int[] nums) { return nums; } }",
				"go":         "func emptyArray(nums []int) []int { return nums }",
				"cpp":        "class Solution { public: std::vector<int> emptyArray(std::vector<int>& nums) { return nums; } };",
				"csharp":     "public class Solution { public int[] emptyArray(int[] nums) { return nums; } }",
				"typescript": "function emptyArray(nums: number[]): number[] { return nums; }",
				"c":          "int* emptyArray(int* nums, int numsSize, int* outputSize) { *outputSize = numsSize; return nums; }",
			},
		},
		{
			Problem: models.Problem{
				Title:        "Ragged Matrix",
				FunctionName: "raggedMatrix",
				ReturnType:   "matrix<number>",
				Parameters: []models.Parameter{
					{Name: "matrix", Type: "matrix<number>"},
				},
				TestCases: []models.TestCase{
					{
						Input: []interface{}{
							[]interface{}{
								[]interface{}{float64(1)},
								[]interface{}{float64(2), float64(3)},
								[]interface{}{},
								[]interface{}{float64(4), float64(5), float64(6)},
							},
						},
						Expected: []interface{}{
							[]interface{}{int64(1)},
							[]interface{}{int64(2), int64(3)},
							[]interface{}{},
							[]interface{}{int64(4), int64(5), int64(6)},
						},
					},
				},
			},
			Solutions: map[string]string{
				"python":     "def raggedMatrix(matrix): return matrix",
				"javascript": "function raggedMatrix(matrix) { return matrix; }",
				"java":       "public class Solution { public int[][] raggedMatrix(int[][] matrix) { return matrix; } }",
				"go":         "func raggedMatrix(matrix [][]int) [][]int { return matrix }",
				"cpp":        "class Solution { public: std::vector<std::vector<int>> raggedMatrix(std::vector<std::vector<int>>& matrix) { return matrix; } };",
				"csharp":     "public class Solution { public int[][] raggedMatrix(int[][] matrix) { return matrix; } }",
				"typescript": "function raggedMatrix(matrix: number[][]): number[][] { return matrix; }",
				"c":          "int** raggedMatrix(int** matrix, int matrixRows, int* matrixCols, int* outputRows, int** outputCols) { *outputRows = matrixRows; *outputCols = matrixCols; return matrix; }",
			},
		},
		{
			Problem: models.Problem{
				Title:        "Empty Matrix",
				FunctionName: "emptyMatrix",
				ReturnType:   "matrix<number>",
				Parameters: []models.Parameter{
					{Name: "matrix", Type: "matrix<number>"},
				},
				TestCases: []models.TestCase{
					{Input: []interface{}{[]interface{}{}}, Expected: []interface{}{}},
				},
			},
			Solutions: map[string]string{
				"python":     "def emptyMatrix(matrix): return matrix",
				"javascript": "function emptyMatrix(matrix) { return matrix; }",
				"java":       "public class Solution { public int[][] emptyMatrix(int[][] matrix) { return matrix; } }",
				"go":         "func emptyMatrix(matrix [][]int) [][]int { return matrix }",
				"cpp":        "class Solution { public: std::vector<std::vector<int>> emptyMatrix(std::vector<std::vector<int>>& matrix) { return matrix; } };",
				"csharp":     "public class Solution { public int[][] emptyMatrix(int[][] matrix) { return matrix; } }",
				"typescript": "function emptyMatrix(matrix: number[][]): number[][] { return matrix; }",
				"c":          "int** emptyMatrix(int** matrix, int matrixRows, int* matrixCols, int* outputRows, int** outputCols) { *outputRows = matrixRows; *outputCols = matrixCols; return matrix; }",
			},
		},
	}

	for _, cp := range problems {
		t.Run(cp.Problem.Title, func(t *testing.T) {
			for _, langID := range languagesToTest {
				code, ok := cp.Solutions[langID]
				if !ok {
					continue
				}

				t.Run(langID, func(t *testing.T) {
					exec, p, pc, lang := setupIntegration(t, langID)
					defer p.Release(pc)

					result := runCertificationTest(t, exec, pc, lang, cp.Problem, code, "type-cert")
					if result.Status != models.SubmissionStatusAccepted {
						t.Fatalf("expected Accepted, got %q. Stderr: %q, Details: %+v", result.Status, result.Stderr, result.Details)
					}
				})
			}
		})
	}
}
