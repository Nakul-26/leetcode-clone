//go:build integration

package main

import (
	"testing"

	"judge-service-go/pkg/models"
)

func treeProblem(functionName string) models.Problem {
	return models.Problem{
		Title:        "Max Depth of Binary Tree",
		FunctionName: functionName,
		ReturnType:   "number",
		Parameters: []models.Parameter{
			{Name: "root", Type: "tree<number>"},
		},
		TestCases: []models.TestCase{
			{
				Input:    []interface{}{[]interface{}{float64(3), float64(9), float64(20), nil, nil, float64(15), float64(7)}},
				Expected: float64(3),
			},
			{
				Input:    []interface{}{[]interface{}{float64(1), nil, float64(2)}},
				Expected: float64(2),
			},
		},
		CompareConfig: models.CompareConfig{Mode: "EXACT"},
	}
}

func linkedListProblem(functionName string) models.Problem {
	return models.Problem{
		Title:        "Reverse Linked List",
		FunctionName: functionName,
		ReturnType:   "linkedlist<number>",
		Parameters: []models.Parameter{
			{Name: "head", Type: "linkedlist<number>"},
		},
		TestCases: []models.TestCase{
			{
				Input:    []interface{}{[]interface{}{float64(1), float64(2), float64(3)}},
				Expected: []interface{}{float64(3), float64(2), float64(1)},
			},
		},
		CompareConfig: models.CompareConfig{Mode: "EXACT"},
	}
}

func reverseStringProblem(functionName string) models.Problem {
	return models.Problem{
		Title:        "Reverse String",
		FunctionName: functionName,
		ReturnType:   "void",
		Parameters: []models.Parameter{
			{Name: "s", Type: "array<string>"},
		},
		TestCases: []models.TestCase{
			{
				Input:    []interface{}{[]interface{}{"h", "e", "l", "l", "o"}},
				Expected: []interface{}{"o", "l", "l", "e", "h"},
			},
		},
		CompareConfig: models.CompareConfig{Mode: "EXACT"},
	}
}

func rotateMatrixProblem(functionName string) models.Problem {
	return models.Problem{
		Title:        "Rotate Image",
		FunctionName: functionName,
		ReturnType:   "void",
		Parameters: []models.Parameter{
			{Name: "matrix", Type: "matrix<number>"},
		},
		TestCases: []models.TestCase{
			{
				Input: []interface{}{[]interface{}{
					[]interface{}{float64(1), float64(2), float64(3)},
					[]interface{}{float64(4), float64(5), float64(6)},
					[]interface{}{float64(7), float64(8), float64(9)},
				}},
				Expected: []interface{}{
					[]interface{}{float64(7), float64(4), float64(1)},
					[]interface{}{float64(8), float64(5), float64(2)},
					[]interface{}{float64(9), float64(6), float64(3)},
				},
			},
		},
		CompareConfig: models.CompareConfig{Mode: "EXACT"},
	}
}

func TestPython_Tree(t *testing.T) {
	exec, p, pc, lang := setupPythonIntegration(t)
	defer p.Release(pc)
	problem := treeProblem("maxDepth")
	code := `
def maxDepth(root):
    if not root:
        return 0
    return 1 + max(maxDepth(root.left), maxDepth(root.right))
`
	result := runCentralOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestJS_Tree(t *testing.T) {
	exec, p, pc, lang := setupJSIntegration(t)
	defer p.Release(pc)
	problem := treeProblem("maxDepth")
	code := `
function maxDepth(root) {
    if (!root) return 0;
    return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));
}
`
	result := runCentralJSOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestJava_Tree(t *testing.T) {
	exec, p, pc, lang := setupJavaIntegration(t)
	defer p.Release(pc)
	problem := treeProblem("maxDepth")
	code := `
class Solution {
    public int maxDepth(TreeNode root) {
        if (root == null) return 0;
        return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));
    }
}
`
	result := runCentralJavaOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestPython_LinkedList(t *testing.T) {
	exec, p, pc, lang := setupPythonIntegration(t)
	defer p.Release(pc)
	problem := linkedListProblem("reverseList")
	code := `
def reverseList(head):
    prev = None
    curr = head
    while curr:
        nxt = curr.next
        curr.next = prev
        prev = curr
        curr = nxt
    return prev
`
	result := runCentralOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestJS_LinkedList(t *testing.T) {
	exec, p, pc, lang := setupJSIntegration(t)
	defer p.Release(pc)
	problem := linkedListProblem("reverseList")
	code := `
function reverseList(head) {
    let prev = null;
    let curr = head;
    while (curr) {
        let nxt = curr.next;
        curr.next = prev;
        prev = curr;
        curr = nxt;
    }
    return prev;
}
`
	result := runCentralJSOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestJava_LinkedList(t *testing.T) {
	exec, p, pc, lang := setupJavaIntegration(t)
	defer p.Release(pc)
	problem := linkedListProblem("reverseList")
	code := `
class Solution {
    public ListNode reverseList(ListNode head) {
        ListNode prev = null;
        ListNode curr = head;
        while (curr != null) {
            ListNode next = curr.next;
            curr.next = prev;
            prev = curr;
            curr = next;
        }
        return prev;
    }
}
`
	result := runCentralJavaOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestPython_ReverseString_InPlace(t *testing.T) {
	exec, p, pc, lang := setupPythonIntegration(t)
	defer p.Release(pc)
	problem := reverseStringProblem("reverseString")
	code := `
def reverseString(s):
    s.reverse()
`
	result := runCentralOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestJS_ReverseString_InPlace(t *testing.T) {
	exec, p, pc, lang := setupJSIntegration(t)
	defer p.Release(pc)
	problem := reverseStringProblem("reverseString")
	code := `
function reverseString(s) {
    s.reverse();
}
`
	result := runCentralJSOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestJava_ReverseString_InPlace(t *testing.T) {
	exec, p, pc, lang := setupJavaIntegration(t)
	defer p.Release(pc)
	problem := reverseStringProblem("reverseString")
	code := `
class Solution {
    public void reverseString(String[] s) {
        for (int i = 0; i < s.length / 2; i++) {
            String temp = s[i];
            s[i] = s[s.length - 1 - i];
            s[s.length - 1 - i] = temp;
        }
    }
}
`
	result := runCentralJavaOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestPython_RotateMatrix_InPlace(t *testing.T) {
	exec, p, pc, lang := setupPythonIntegration(t)
	defer p.Release(pc)
	problem := rotateMatrixProblem("rotate")
	code := `
def rotate(matrix):
    n = len(matrix)
    for i in range(n // 2):
        for j in range(i, n - i - 1):
            temp = matrix[i][j]
            matrix[i][j] = matrix[n - 1 - j][i]
            matrix[n - 1 - j][i] = matrix[n - 1 - i][n - 1 - j]
            matrix[n - 1 - i][n - 1 - j] = matrix[j][n - 1 - i]
            matrix[j][n - 1 - i] = temp
`
	result := runCentralOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestJS_RotateMatrix_InPlace(t *testing.T) {
	exec, p, pc, lang := setupJSIntegration(t)
	defer p.Release(pc)
	problem := rotateMatrixProblem("rotate")
	code := `
function rotate(matrix) {
    const n = matrix.length;
    for (let i = 0; i < Math.floor(n / 2); i++) {
        for (let j = i; j < n - i - 1; j++) {
            let temp = matrix[i][j];
            matrix[i][j] = matrix[n - 1 - j][i];
            matrix[n - 1 - j][i] = matrix[n - 1 - i][n - 1 - j];
            matrix[n - 1 - i][n - 1 - j] = matrix[j][n - 1 - i];
            matrix[j][n - 1 - i] = temp;
        }
    }
}
`
	result := runCentralJSOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestJava_RotateMatrix_InPlace(t *testing.T) {
	exec, p, pc, lang := setupJavaIntegration(t)
	defer p.Release(pc)
	problem := rotateMatrixProblem("rotate")
	code := `
class Solution {
    public void rotate(int[][] matrix) {
        int n = matrix.length;
        for (int i = 0; i < n / 2; i++) {
            for (int j = i; j < n - i - 1; j++) {
                int temp = matrix[i][j];
                matrix[i][j] = matrix[n - 1 - j][i];
                matrix[n - 1 - j][i] = matrix[n - 1 - i][n - 1 - j];
                matrix[n - 1 - i][n - 1 - j] = matrix[j][n - 1 - i];
                matrix[j][n - 1 - i] = temp;
            }
        }
    }
}
`
	result := runCentralJavaOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestCpp_Tree(t *testing.T) {
	exec, p, pc, lang := setupCppIntegration(t)
	defer p.Release(pc)
	problem := treeProblem("maxDepth")
	code := `
#include <algorithm>
class Solution {
public:
    int maxDepth(TreeNode* root) {
        if (!root) return 0;
        return 1 + std::max(maxDepth(root->left), maxDepth(root->right));
    }
};
`
	result := runCentralCppOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}

func TestCpp_LinkedList(t *testing.T) {
	exec, p, pc, lang := setupCppIntegration(t)
	defer p.Release(pc)
	problem := linkedListProblem("reverseList")
	code := `
class Solution {
public:
    ListNode* reverseList(ListNode* head) {
        ListNode* prev = nullptr;
        ListNode* curr = head;
        while (curr) {
            ListNode* nxt = curr->next;
            curr->next = prev;
            prev = curr;
            curr = nxt;
        }
        return prev;
    }
};
`
	result := runCentralCppOnce(t, exec, pc, lang, problem, code)
	if result.Status != models.SubmissionStatusAccepted || result.Passed != result.Total {
		t.Fatalf("expected accepted result, got %+v", result)
	}
}
