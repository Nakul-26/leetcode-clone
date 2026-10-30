//go:build integration

package main

import (
	"judge-service-go/pkg/models"
	"testing"
)

func TestCertificationSuite(t *testing.T) {
	languagesToTest := []string{"python", "javascript", "java", "go", "cpp", "csharp", "typescript", "c"}

	problems := []struct {
		Problem   models.Problem
		Solutions map[string]struct {
			Correct string
			Wrong   string
		}
	}{
		{
			Problem: models.Problem{
				Title:        "Add Two Numbers",
				FunctionName: "add",
				ReturnType:   "number",
				Parameters: []models.Parameter{
					{Name: "a", Type: "number"},
					{Name: "b", Type: "number"},
				},
				TestCases: []models.TestCase{
					{Input: []interface{}{float64(1), float64(2)}, Expected: int64(3)},
				},
			},
			Solutions: map[string]struct {
				Correct string
				Wrong   string
			}{
				"python":     {Correct: "def add(a, b): return a + b", Wrong: "def add(a, b): return a - b"},
				"javascript": {Correct: "function add(a, b) { return a + b; }", Wrong: "function add(a, b) { return a - b; }"},
				"java": {
					Correct: "public class Solution { public int add(int a, int b) { return a + b; } }",
					Wrong:   "public class Solution { public int add(int a, int b) { return a - b; } }",
				},
				"go":  {Correct: "func add(a int, b int) int { return a + b }", Wrong: "func add(a int, b int) int { return a - b }"},
				"cpp": {Correct: "class Solution { public: int add(int a, int b) { return a + b; } };", Wrong: "class Solution { public: int add(int a, int b) { return a - b; } };"},
				"csharp": {
					Correct: "public class Solution { public int add(int a, int b) { return a + b; } }",
					Wrong:   "public class Solution { public int add(int a, int b) { return a - b; } }",
				},
				"typescript": {
					Correct: "function add(a: number, b: number): number { return a + b; }",
					Wrong:   "function add(a: number, b: number): number { return a - b; }",
				},
				"c": {
					Correct: "int add(int a, int b) { return a + b; }",
					Wrong:   "int add(int a, int b) { return a - b; }",
				},
			},
		},
		{
			Problem: models.Problem{
				Title:        "Two Sum",
				FunctionName: "twoSum",
				ReturnType:   "array<number>",
				Parameters: []models.Parameter{
					{Name: "nums", Type: "array<number>"},
					{Name: "target", Type: "number"},
				},
				TestCases: []models.TestCase{
					{
						Input:    []interface{}{[]interface{}{float64(2), float64(7), float64(11), float64(15)}, float64(9)},
						Expected: []interface{}{int64(0), int64(1)},
					},
				},
			},
			Solutions: map[string]struct {
				Correct string
				Wrong   string
			}{
				"python": {
					Correct: "def twoSum(nums, target):\n    d = {}\n    for i, n in enumerate(nums):\n        if target - n in d: return [d[target - n], i]\n        d[n] = i",
					Wrong:   "def twoSum(nums, target): return [0, 0]",
				},
				"javascript": {
					Correct: "function twoSum(nums, target) {\n    const m = new Map();\n    for (let i = 0; i < nums.length; i++) {\n        if (m.has(target - nums[i])) return [m.get(target - nums[i]), i];\n        m.set(nums[i], i);\n    }\n}",
					Wrong:   "function twoSum(nums, target) { return [0, 0]; }",
				},
				"java": {
					Correct: "import java.util.*;\npublic class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        Map<Integer, Integer> m = new HashMap<>();\n        for (int i = 0; i < nums.length; i++) {\n            if (m.containsKey(target - nums[i])) return new int[]{m.get(target - nums[i]), i};\n            m.put(nums[i], i);\n        }\n        return null;\n    }\n}",
					Wrong:   "public class Solution { public int[] twoSum(int[] nums, int target) { return new int[]{0, 0}; } }",
				},
				"go": {
					Correct: "func twoSum(nums []int, target int) []int {\n\tm := make(map[int]int)\n\tfor i, n := range nums {\n\t\tif j, ok := m[target-n]; ok { return []int{j, i} }\n\t\tm[n] = i\n\t}\n\treturn nil\n}",
					Wrong:   "func twoSum(nums []int, target int) []int { return []int{0, 0} }",
				},
				"cpp": {
					Correct: "class Solution {\npublic:\n    std::vector<int> twoSum(std::vector<int>& nums, int target) {\n        std::unordered_map<int, int> m;\n        for (int i = 0; i < nums.size(); i++) {\n            if (m.count(target - nums[i])) return {m[target - nums[i]], i};\n            m[nums[i]] = i;\n        }\n        return {};\n    }\n};",
					Wrong:   "class Solution { public: std::vector<int> twoSum(std::vector<int>& nums, int target) { return {0, 0}; } };",
				},
				"csharp": {
					Correct: "public class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        var m = new Dictionary<int, int>();\n        for (int i = 0; i < nums.Length; i++) {\n            if (m.ContainsKey(target - nums[i])) return new int[] { m[target - nums[i]], i };\n            m[nums[i]] = i;\n        }\n        return null;\n    }\n}",
					Wrong:   "public class Solution { public int[] twoSum(int[] nums, int target) { return new int[] { 0, 0 }; } }",
				},
				"typescript": {
					Correct: "function twoSum(nums: number[], target: number): number[] {\n    const m = new Map<number, number>();\n    for (let i = 0; i < nums.length; i++) {\n        if (m.has(target - nums[i])) return [m.get(target - nums[i])!, i];\n        m.set(nums[i], i);\n    }\n    return [];\n}",
					Wrong:   "function twoSum(nums: number[], target: number): number[] { return [0, 0]; }",
				},
				"c": {
					Correct: "int* twoSum(int* nums, int numsSize, int target, int* outputSize) {\n    *outputSize = 2;\n    int* res = malloc(2 * sizeof(int));\n    for (int i = 0; i < numsSize; i++) {\n        for (int j = i + 1; j < numsSize; j++) {\n            if (nums[i] + nums[j] == target) {\n                res[0] = i; res[1] = j; return res;\n            }\n        }\n    }\n    return NULL;\n}",
					Wrong:   "int* twoSum(int* nums, int numsSize, int target, int* outputSize) {\n    *outputSize = 2;\n    int* res = malloc(2 * sizeof(int));\n    res[0] = 0; res[1] = 0;\n    return res;\n}",
				},
			},
		},
		{
			Problem: models.Problem{
				Title:        "Rotate Image",
				FunctionName: "rotate",
				ReturnType:   "void",
				Parameters: []models.Parameter{
					{Name: "matrix", Type: "matrix<number>"},
				},
				TestCases: []models.TestCase{
					{
						Input: []interface{}{
							[]interface{}{
								[]interface{}{float64(1), float64(2)},
								[]interface{}{float64(3), float64(4)},
							},
						},
						Expected: []interface{}{
							[]interface{}{int64(3), int64(1)},
							[]interface{}{int64(4), int64(2)},
						},
					},
				},
			},
			Solutions: map[string]struct {
				Correct string
				Wrong   string
			}{
				"python": {
					Correct: "def rotate(matrix):\n    n = len(matrix)\n    for i in range(n // 2):\n        for j in range(i, n - i - 1):\n            temp = matrix[i][j]\n            matrix[i][j] = matrix[n - j - 1][i]\n            matrix[n - j - 1][i] = matrix[n - i - 1][n - j - 1]\n            matrix[n - i - 1][n - j - 1] = matrix[j][n - i - 1]\n            matrix[j][n - i - 1] = temp",
					Wrong:   "def rotate(matrix): pass",
				},
				"javascript": {
					Correct: "function rotate(matrix) {\n    const n = matrix.length;\n    for (let i = 0; i < Math.floor(n / 2); i++) {\n        for (let j = i; j < n - i - 1; j++) {\n            let temp = matrix[i][j];\n            matrix[i][j] = matrix[n - j - 1][i];\n            matrix[n - j - 1][i] = matrix[n - i - 1][n - j - 1];\n            matrix[n - i - 1][n - j - 1] = matrix[j][n - i - 1];\n            matrix[j][n - i - 1] = temp;\n        }\n    }\n}",
					Wrong:   "function rotate(matrix) { }",
				},
				"java": {
					Correct: "public class Solution {\n    public void rotate(int[][] matrix) {\n        int n = matrix.length;\n        for (int i = 0; i < n / 2; i++) {\n            for (int j = i; j < n - i - 1; j++) {\n                int temp = matrix[i][j];\n                matrix[i][j] = matrix[n - j - 1][i];\n                matrix[n - j - 1][i] = matrix[n - i - 1][n - j - 1];\n                matrix[n - i - 1][n - j - 1] = matrix[j][n - i - 1];\n                matrix[j][n - i - 1] = temp;\n            }\n        }\n    }\n}",
					Wrong:   "public class Solution { public void rotate(int[][] matrix) { } }",
				},
				"go": {
					Correct: "func rotate(matrix [][]int) {\n\tn := len(matrix)\n\tfor i := 0; i < n/2; i++ {\n\t\tfor j := i; j < n-i-1; j++ {\n\t\t\ttemp := matrix[i][j]\n\t\t\tmatrix[i][j] = matrix[n-j-1][i]\n\t\t\tmatrix[n-j-1][i] = matrix[n-i-1][n-j-1]\n\t\t\tmatrix[n-i-1][n-j-1] = matrix[j][n-i-1]\n\t\t\tmatrix[j][n-i-1] = temp\n\t\t}\n\t}\n}",
					Wrong:   "func rotate(matrix [][]int) { }",
				},
				"cpp": {
					Correct: "class Solution {\npublic:\n    void rotate(std::vector<std::vector<int>>& matrix) {\n        int n = matrix.size();\n        for (int i = 0; i < n / 2; i++) {\n            for (int j = i; j < n - i - 1; j++) {\n                int temp = matrix[i][j];\n                matrix[i][j] = matrix[n - j - 1][i];\n                matrix[n - j - 1][i] = matrix[n - i - 1][n - j - 1];\n                matrix[n - i - 1][n - j - 1] = matrix[j][n - i - 1];\n                matrix[j][n - i - 1] = temp;\n            }\n        }\n    }\n};",
					Wrong:   "class Solution { public: void rotate(std::vector<std::vector<int>>& matrix) { } };",
				},
				"csharp": {
					Correct: "public class Solution {\n    public void rotate(int[][] matrix) {\n        int n = matrix.Length;\n        for (int i = 0; i < n / 2; i++) {\n            for (int j = i; j < n - i - 1; j++) {\n                int temp = matrix[i][j];\n                matrix[i][j] = matrix[n - j - 1][i];\n                matrix[n - j - 1][i] = matrix[n - i - 1][n - j - 1];\n                matrix[n - i - 1][n - j - 1] = matrix[j][n - i - 1];\n                matrix[j][n - i - 1] = temp;\n            }\n        }\n    }\n}",
					Wrong:   "public class Solution { public void rotate(int[][] matrix) { } }",
				},
				"typescript": {
					Correct: "function rotate(matrix: number[][]): void {\n    const n = matrix.length;\n    for (let i = 0; i < Math.floor(n / 2); i++) {\n        for (let j = i; j < n - i - 1; j++) {\n            let temp = matrix[i][j];\n            matrix[i][j] = matrix[n - j - 1][i];\n            matrix[n - j - 1][i] = matrix[n - i - 1][n - j - 1];\n            matrix[n - i - 1][n - j - 1] = matrix[j][n - i - 1];\n            matrix[j][n - i - 1] = temp;\n        }\n    }\n}",
					Wrong:   "function rotate(matrix: number[][]): void { }",
				},
				"c": {
					Correct: "void rotate(int** matrix, int matrixRows, int* matrixCols) {\n    int n = matrixRows;\n    for (int i = 0; i < n / 2; i++) {\n        for (int j = i; j < n - i - 1; j++) {\n            int temp = matrix[i][j];\n            matrix[i][j] = matrix[n - j - 1][i];\n            matrix[n - j - 1][i] = matrix[n - i - 1][n - j - 1];\n            matrix[n - i - 1][n - j - 1] = matrix[j][n - i - 1];\n            matrix[j][n - i - 1] = temp;\n        }\n    }\n}",
					Wrong:   "void rotate(int** matrix, int matrixRows, int* matrixCols) { }",
				},
			},
		},
		{
			Problem: models.Problem{
				Title:        "Reverse Linked List",
				FunctionName: "reverseList",
				ReturnType:   "linkedlist<number>",
				Parameters: []models.Parameter{
					{Name: "head", Type: "linkedlist<number>"},
				},
				TestCases: []models.TestCase{
					{
						Input:    []interface{}{[]interface{}{float64(1), float64(2), float64(3)}},
						Expected: []interface{}{int64(3), int64(2), int64(1)},
					},
				},
			},
			Solutions: map[string]struct {
				Correct string
				Wrong   string
			}{
				"python": {
					Correct: "def reverseList(head):\n    prev = None\n    curr = head\n    while curr:\n        next_node = curr.next\n        curr.next = prev\n        prev = curr\n        curr = next_node\n    return prev",
					Wrong:   "def reverseList(head): return head",
				},
				"javascript": {
					Correct: "function reverseList(head) {\n    let prev = null;\n    let curr = head;\n    while (curr) {\n        let next = curr.next;\n        curr.next = prev;\n        prev = curr;\n        curr = next;\n    }\n    return prev;\n}",
					Wrong:   "function reverseList(head) { return head; }",
				},
				"java": {
					Correct: "public class Solution {\n    public ListNode reverseList(ListNode head) {\n        ListNode prev = null;\n        ListNode curr = head;\n        while (curr != null) {\n            ListNode next = curr.next;\n            curr.next = prev;\n            prev = curr;\n            curr = next;\n        }\n        return prev;\n    }\n}",
					Wrong:   "public class Solution { public ListNode reverseList(ListNode head) { return head; } }",
				},
				"go": {
					Correct: "func reverseList(head *ListNode) *ListNode {\n\tvar prev *ListNode\n\tcurr := head\n\tfor curr != nil {\n\t\tnext := curr.Next\n\t\tcurr.Next = prev\n\t\tprev = curr\n\t\tcurr = next\n\t}\n\treturn prev\n}",
					Wrong:   "func reverseList(head *ListNode) *ListNode { return head }",
				},
				"cpp": {
					Correct: "class Solution {\npublic:\n    ListNode* reverseList(ListNode* head) {\n        ListNode* prev = nullptr;\n        ListNode* curr = head;\n        while (curr) {\n            ListNode* next = curr->next;\n            curr->next = prev;\n            prev = curr;\n            curr = next;\n        }\n        return prev;\n    }\n};",
					Wrong:   "class Solution { public: ListNode* reverseList(ListNode* head) { return head; } };",
				},
				"csharp": {
					Correct: "public class Solution {\n    public ListNode reverseList(ListNode head) {\n        ListNode prev = null;\n        ListNode curr = head;\n        while (curr != null) {\n            ListNode next = curr.next;\n            curr.next = prev;\n            prev = curr;\n            curr = next;\n        }\n        return prev;\n    }\n}",
					Wrong:   "public class Solution { public ListNode reverseList(ListNode head) { return head; } }",
				},
				"typescript": {
					Correct: "function reverseList(head: ListNode | null): ListNode | null {\n    let prev: ListNode | null = null;\n    let curr = head;\n    while (curr) {\n        let next: ListNode | null = curr.next;\n        curr.next = prev;\n        prev = curr;\n        curr = next;\n    }\n    return prev;\n}",
					Wrong:   "function reverseList(head: ListNode | null): ListNode | null { return head; }",
				},
				"c": {
					Correct: "struct ListNode* reverseList(struct ListNode* head) {\n    struct ListNode *prev = NULL, *curr = head, *next;\n    while (curr) {\n        next = curr->next;\n        curr->next = prev;\n        prev = curr;\n        curr = next;\n    }\n    return prev;\n}",
					Wrong:   "struct ListNode* reverseList(struct ListNode* head) { return head; }",
				},
			},
		},
		{
			Problem: models.Problem{
				Title:        "Maximum Depth of Binary Tree",
				FunctionName: "maxDepth",
				ReturnType:   "number",
				Parameters: []models.Parameter{
					{Name: "root", Type: "tree<number>"},
				},
				TestCases: []models.TestCase{
					{
						Input:    []interface{}{[]interface{}{float64(3), float64(9), float64(20), nil, nil, float64(15), float64(7)}},
						Expected: int64(3),
					},
				},
			},
			Solutions: map[string]struct {
				Correct string
				Wrong   string
			}{
				"python": {
					Correct: "def maxDepth(root):\n    if not root: return 0\n    return 1 + max(maxDepth(root.left), maxDepth(root.right))",
					Wrong:   "def maxDepth(root): return 1",
				},
				"javascript": {
					Correct: "function maxDepth(root) {\n    if (!root) return 0;\n    return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));\n}",
					Wrong:   "function maxDepth(root) { return 1; }",
				},
				"java": {
					Correct: "public class Solution {\n    public int maxDepth(TreeNode root) {\n        if (root == null) return 0;\n        return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));\n    }\n}",
					Wrong:   "public class Solution { public int maxDepth(TreeNode root) { return 1; } }",
				},
				"go": {
					Correct: "func maxDepth(root *TreeNode) int {\n\tif root == nil { return 0 }\n\tl := maxDepth(root.Left)\n\tr := maxDepth(root.Right)\n\tif l > r { return 1 + l }\n\treturn 1 + r\n}",
					Wrong:   "func maxDepth(root *TreeNode) int { return 1 }",
				},
				"cpp": {
					Correct: "class Solution {\npublic:\n    int maxDepth(TreeNode* root) {\n        if (!root) return 0;\n        return 1 + std::max(maxDepth(root->left), maxDepth(root->right));\n    }\n};",
					Wrong:   "class Solution { public: int maxDepth(TreeNode* root) { return 1; } };",
				},
				"csharp": {
					Correct: "public class Solution {\n    public int maxDepth(TreeNode root) {\n        if (root == null) return 0;\n        return 1 + Math.Max(maxDepth(root.left), maxDepth(root.right));\n    }\n}",
					Wrong:   "public class Solution { public int maxDepth(TreeNode root) { return 1; } }",
				},
				"typescript": {
					Correct: "function maxDepth(root: TreeNode | null): number {\n    if (!root) return 0;\n    return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));\n}",
					Wrong:   "function maxDepth(root: TreeNode | null): number { return 1; }",
				},
				"c": {
					Correct: "int maxDepth(struct TreeNode* root) {\n    if (!root) return 0;\n    int l = maxDepth(root->left);\n    int r = maxDepth(root->right);\n    return 1 + (l > r ? l : r);\n}",
					Wrong:   "int maxDepth(struct TreeNode* root) { return 1; }",
				},
			},
		},
		{
			Problem: models.Problem{
				Title:        "Binary Tree Level Order Traversal",
				FunctionName: "levelOrder",
				ReturnType:   "matrix<number>",
				Parameters: []models.Parameter{
					{Name: "root", Type: "tree<number>"},
				},
				TestCases: []models.TestCase{
					{
						Input:    []interface{}{[]interface{}{float64(3), float64(9), float64(20), nil, nil, float64(15), float64(7)}},
						Expected: []interface{}{[]interface{}{int64(3)}, []interface{}{int64(9), int64(20)}, []interface{}{int64(15), int64(7)}},
					},
				},
			},
			Solutions: map[string]struct {
				Correct string
				Wrong   string
			}{
				"python": {
					Correct: "import collections\ndef levelOrder(root):\n    if not root: return []\n    res, q = [], collections.deque([root])\n    while q:\n        level = []\n        for _ in range(len(q)):\n            node = q.popleft()\n            level.append(node.val)\n            if node.left: q.append(node.left)\n            if node.right: q.append(node.right)\n        res.append(level)\n    return res",
					Wrong:   "def levelOrder(root): return []",
				},
				"javascript": {
					Correct: "function levelOrder(root) {\n    if (!root) return [];\n    const res = [], q = [root];\n    while (q.length > 0) {\n        const level = [], size = q.length;\n        for (let i = 0; i < size; i++) {\n            const node = q.shift();\n            level.push(node.val);\n            if (node.left) q.push(node.left);\n            if (node.right) q.push(node.right);\n        }\n        res.push(level);\n    }\n    return res;\n}",
					Wrong:   "function levelOrder(root) { return []; }",
				},
				"java": {
					Correct: "import java.util.*;\npublic class Solution {\n    public List<List<Integer>> levelOrder(TreeNode root) {\n        List<List<Integer>> res = new ArrayList<>();\n        if (root == null) return res;\n        Queue<TreeNode> q = new LinkedList<>();\n        q.add(root);\n        while (!q.isEmpty()) {\n            int size = q.size();\n            List<Integer> level = new ArrayList<>();\n            for (int i = 0; i < size; i++) {\n                TreeNode node = q.poll();\n                level.add(node.val);\n                if (node.left != null) q.add(node.left);\n                if (node.right != null) q.add(node.right);\n            }\n            res.add(level);\n        }\n        return res;\n    }\n}",
					Wrong:   "import java.util.*;\npublic class Solution { public List<List<Integer>> levelOrder(TreeNode root) { return new ArrayList<>(); } }",
				},
				"go": {
					Correct: "func levelOrder(root *TreeNode) [][]int {\n\tif root == nil { return nil }\n\tvar res [][]int\n\tq := []*TreeNode{root}\n\tfor len(q) > 0 {\n\t\tvar level []int\n\t\tsize := len(q)\n\t\tfor i := 0; i < size; i++ {\n\t\t\tnode := q[0]\n\t\t\tq = q[1:]\n\t\t\tlevel = append(level, node.Val)\n\t\t\tif node.Left != nil { q = append(q, node.Left) }\n\t\t\tif node.Right != nil { q = append(q, node.Right) }\n\t\t}\n\t\tres = append(res, level)\n\t}\n\treturn res\n}",
					Wrong:   "func levelOrder(root *TreeNode) [][]int { return nil }",
				},
				"cpp": {
					Correct: "class Solution {\npublic:\n    std::vector<std::vector<int>> levelOrder(TreeNode* root) {\n        std::vector<std::vector<int>> res;\n        if (!root) return res;\n        std::queue<TreeNode*> q;\n        q.push(root);\n        while (!q.empty()) {\n            int size = q.size();\n            std::vector<int> level;\n            for (int i = 0; i < size; i++) {\n                TreeNode* node = q.front();\n                q.pop();\n                level.push_back(node->val);\n                if (node->left) q.push(node->left);\n                if (node->right) q.push(node->right);\n            }\n            res.push_back(level);\n        }\n        return res;\n    }\n};",
					Wrong:   "class Solution { public: std::vector<std::vector<int>> levelOrder(TreeNode* root) { return {}; } };",
				},
				"csharp": {
					Correct: "public class Solution {\n    public IList<IList<int>> levelOrder(TreeNode root) {\n        var res = new List<IList<int>>();\n        if (root == null) return res;\n        var q = new Queue<TreeNode>();\n        q.Enqueue(root);\n        while (q.Count > 0) {\n            int size = q.Count;\n            var level = new List<int>();\n            for (int i = 0; i < size; i++) {\n                var node = q.Dequeue();\n                level.Add(node.val);\n                if (node.left != null) q.Enqueue(node.left);\n                if (node.right != null) q.Enqueue(node.right);\n            }\n            res.Add(level);\n        }\n        return res;\n    }\n}",
					Wrong:   "public class Solution { public IList<IList<int>> levelOrder(TreeNode root) { return new List<IList<int>>(); } }",
				},
				"typescript": {
					Correct: "function levelOrder(root: TreeNode | null): number[][] {\n    if (!root) return [];\n    const res: number[][] = [], q: TreeNode[] = [root];\n    while (q.length > 0) {\n        const level: number[] = [], size = q.length;\n        for (let i = 0; i < size; i++) {\n            const node = q.shift()!;\n            level.push(node.val);\n            if (node.left) q.push(node.left);\n            if (node.right) q.push(node.right);\n        }\n        res.push(level);\n    }\n    return res;\n}",
					Wrong:   "function levelOrder(root: TreeNode | null): number[][] { return []; }",
				},
				"c": {
					Correct: "int** levelOrder(struct TreeNode* root, int* outputRows, int** outputCols) {\n    if (!root) { *outputRows = 0; return NULL; }\n    int** res = malloc(100 * sizeof(int*));\n    int* cols = malloc(100 * sizeof(int));\n    struct TreeNode* queue[1000];\n    int head = 0, tail = 0;\n    queue[tail++] = root;\n    int row = 0;\n    while (head < tail) {\n        int size = tail - head;\n        cols[row] = size;\n        res[row] = malloc(size * sizeof(int));\n        for (int i = 0; i < size; i++) {\n            struct TreeNode* node = queue[head++];\n            res[row][i] = node->val;\n            if (node->left) queue[tail++] = node->left;\n            if (node->right) queue[tail++] = node->right;\n        }\n        row++;\n    }\n    *outputRows = row;\n    *outputCols = cols;\n    return res;\n}",
					Wrong:   "int** levelOrder(struct TreeNode* root, int* outputRows, int** outputCols) { *outputRows = 0; return NULL; }",
				},
			},
		},
		{
			Problem: models.Problem{
				Title:        "Word Echo",
				FunctionName: "echo",
				ReturnType:   "array<string>",
				Parameters: []models.Parameter{
					{Name: "words", Type: "array<string>"},
				},
				TestCases: []models.TestCase{
					{
						Input:    []interface{}{[]interface{}{"hello", "world"}},
						Expected: []interface{}{"hello", "world"},
					},
				},
			},
			Solutions: map[string]struct {
				Correct string
				Wrong   string
			}{
				"python":     {Correct: "def echo(words): return words", Wrong: "def echo(words): return []"},
				"javascript": {Correct: "function echo(words) { return words; }", Wrong: "function echo(words) { return []; }"},
				"java": {
					Correct: "public class Solution { public String[] echo(String[] words) { return words; } }",
					Wrong:   "public class Solution { public String[] echo(String[] words) { return new String[0]; } }",
				},
				"go":  {Correct: "func echo(words []string) []string { return words }", Wrong: "func echo(words []string) []string { return nil }"},
				"cpp": {Correct: "class Solution { public: std::vector<std::string> echo(std::vector<std::string>& words) { return words; } };", Wrong: "class Solution { public: std::vector<std::string> echo(std::vector<std::string>& words) { return {}; } };"},
				"csharp": {
					Correct: "public class Solution { public string[] echo(string[] words) { return words; } }",
					Wrong:   "public class Solution { public string[] echo(string[] words) { return new string[0]; } }",
				},
				"typescript": {
					Correct: "function echo(words: string[]): string[] { return words; }",
					Wrong:   "function echo(words: string[]): string[] { return []; }",
				},
				"c": {
					Correct: "const char** echo(const char** words, int wordsSize, int* outputSize) {\n    *outputSize = wordsSize;\n    return words;\n}",
					Wrong:   "const char** echo(const char** words, int wordsSize, int* outputSize) {\n    *outputSize = 0;\n    return NULL;\n}",
				},
			},
		},
		{
			Problem: models.Problem{
				Title:        "Matrix Echo",
				FunctionName: "matrixEcho",
				ReturnType:   "matrix<string>",
				Parameters: []models.Parameter{
					{Name: "matrix", Type: "matrix<string>"},
				},
				TestCases: []models.TestCase{
					{
						Input: []interface{}{
							[]interface{}{
								[]interface{}{"a", "b"},
								[]interface{}{"c", "d"},
							},
						},
						Expected: []interface{}{
							[]interface{}{"a", "b"},
							[]interface{}{"c", "d"},
						},
					},
				},
			},
			Solutions: map[string]struct {
				Correct string
				Wrong   string
			}{
				"python":     {Correct: "def matrixEcho(matrix): return matrix", Wrong: "def matrixEcho(matrix): return []"},
				"javascript": {Correct: "function matrixEcho(matrix) { return matrix; }", Wrong: "function matrixEcho(matrix) { return []; }"},
				"java": {
					Correct: "public class Solution { public String[][] matrixEcho(String[][] matrix) { return matrix; } }",
					Wrong:   "public class Solution { public String[][] matrixEcho(String[][] matrix) { return new String[0][0]; } }",
				},
				"go":  {Correct: "func matrixEcho(matrix [][]string) [][]string { return matrix }", Wrong: "func matrixEcho(matrix [][]string) [][]string { return nil }"},
				"cpp": {Correct: "class Solution { public: std::vector<std::vector<std::string>> matrixEcho(std::vector<std::vector<std::string>>& matrix) { return matrix; } };", Wrong: "class Solution { public: std::vector<std::vector<std::string>> matrixEcho(std::vector<std::vector<std::string>>& matrix) { return {}; } };"},
				"csharp": {
					Correct: "public class Solution { public string[][] matrixEcho(string[][] matrix) { return matrix; } }",
					Wrong:   "public class Solution { public string[][] matrixEcho(string[][] matrix) { return new string[0][]; } }",
				},
				"typescript": {
					Correct: "function matrixEcho(matrix: string[][]): string[][] { return matrix; }",
					Wrong:   "function matrixEcho(matrix: string[][]): string[][] { return []; }",
				},
				"c": {
					Correct: "const char*** matrixEcho(const char*** matrix, int matrixRows, int* matrixCols, int* outputRows, int** outputCols) {\n    *outputRows = matrixRows;\n    *outputCols = matrixCols;\n    return matrix;\n}",
					Wrong:   "const char*** matrixEcho(const char*** matrix, int matrixRows, int* matrixCols, int* outputRows, int** outputCols) {\n    *outputRows = 0;\n    return NULL;\n}",
				},
			},
		},
		{
			Problem: models.Problem{
				Title:        "Boolean Array Echo",
				FunctionName: "boolEcho",
				ReturnType:   "array<boolean>",
				Parameters: []models.Parameter{
					{Name: "vals", Type: "array<boolean>"},
				},
				TestCases: []models.TestCase{
					{
						Input:    []interface{}{[]interface{}{true, false, true}},
						Expected: []interface{}{true, false, true},
					},
				},
			},
			Solutions: map[string]struct {
				Correct string
				Wrong   string
			}{
				"python":     {Correct: "def boolEcho(vals): return vals", Wrong: "def boolEcho(vals): return []"},
				"javascript": {Correct: "function boolEcho(vals) { return vals; }", Wrong: "function boolEcho(vals) { return []; }"},
				"java": {
					Correct: "public class Solution { public boolean[] boolEcho(boolean[] vals) { return vals; } }",
					Wrong:   "public class Solution { public boolean[] boolEcho(boolean[] vals) { return new boolean[0]; } }",
				},
				"go":  {Correct: "func boolEcho(vals []bool) []bool { return vals }", Wrong: "func boolEcho(vals []bool) []bool { return nil }"},
				"cpp": {Correct: "class Solution { public: std::vector<bool> boolEcho(std::vector<bool>& vals) { return vals; } };", Wrong: "class Solution { public: std::vector<bool> boolEcho(std::vector<bool>& vals) { return {}; } };"},
				"csharp": {
					Correct: "public class Solution { public bool[] boolEcho(bool[] vals) { return vals; } }",
					Wrong:   "public class Solution { public bool[] boolEcho(bool[] vals) { return new bool[0]; } }",
				},
				"typescript": {
					Correct: "function boolEcho(vals: boolean[]): boolean[] { return vals; }",
					Wrong:   "function boolEcho(vals: boolean[]): boolean[] { return []; }",
				},
				"c": {
					Correct: "bool* boolEcho(bool* vals, int valsSize, int* outputSize) {\n    *outputSize = valsSize;\n    return vals;\n}",
					Wrong:   "bool* boolEcho(bool* vals, int valsSize, int* outputSize) {\n    *outputSize = 0;\n    return NULL;\n}",
				},
			},
		},
		{
			Problem: models.Problem{
				Title:        "Boolean Matrix Echo",
				FunctionName: "boolMatrixEcho",
				ReturnType:   "matrix<boolean>",
				Parameters: []models.Parameter{
					{Name: "matrix", Type: "matrix<boolean>"},
				},
				TestCases: []models.TestCase{
					{
						Input: []interface{}{
							[]interface{}{
								[]interface{}{true, false},
								[]interface{}{false, true},
							},
						},
						Expected: []interface{}{
							[]interface{}{true, false},
							[]interface{}{false, true},
						},
					},
				},
			},
			Solutions: map[string]struct {
				Correct string
				Wrong   string
			}{
				"python":     {Correct: "def boolMatrixEcho(matrix): return matrix", Wrong: "def boolMatrixEcho(matrix): return []"},
				"javascript": {Correct: "function boolMatrixEcho(matrix) { return matrix; }", Wrong: "function boolMatrixEcho(matrix) { return []; }"},
				"java": {
					Correct: "public class Solution { public boolean[][] boolMatrixEcho(boolean[][] matrix) { return matrix; } }",
					Wrong:   "public class Solution { public boolean[][] boolMatrixEcho(boolean[][] matrix) { return new boolean[0][]; } }",
				},
				"go":  {Correct: "func boolMatrixEcho(matrix [][]bool) [][]bool { return matrix }", Wrong: "func boolMatrixEcho(matrix [][]bool) [][]bool { return nil }"},
				"cpp": {Correct: "class Solution { public: std::vector<std::vector<bool>> boolMatrixEcho(std::vector<std::vector<bool>>& matrix) { return matrix; } };", Wrong: "class Solution { public: std::vector<std::vector<bool>> boolMatrixEcho(std::vector<std::vector<bool>>& matrix) { return {}; } };"},
				"csharp": {
					Correct: "public class Solution { public bool[][] boolMatrixEcho(bool[][] matrix) { return matrix; } }",
					Wrong:   "public class Solution { public bool[][] boolMatrixEcho(bool[][] matrix) { return new bool[0][]; } }",
				},
				"typescript": {
					Correct: "function boolMatrixEcho(matrix: boolean[][]): boolean[][] { return matrix; }",
					Wrong:   "function boolMatrixEcho(matrix: boolean[][]): boolean[][] { return []; }",
				},
				"c": {
					Correct: "bool** boolMatrixEcho(bool** matrix, int matrixRows, int* matrixCols, int* outputRows, int** outputCols) {\n    *outputRows = matrixRows;\n    *outputCols = matrixCols;\n    return matrix;\n}",
					Wrong:   "bool** boolMatrixEcho(bool** matrix, int matrixRows, int* matrixCols, int* outputRows, int** outputCols) {\n    *outputRows = 0;\n    return NULL;\n}",
				},
			},
		},
		{
			Problem: models.Problem{
				Title:        "Clone Graph",
				FunctionName: "cloneGraph",
				ReturnType:   "graph<number>",
				Parameters: []models.Parameter{
					{Name: "node", Type: "graph<number>"},
				},
				TestCases: []models.TestCase{
					{
						Input: []interface{}{
							[]interface{}{
								[]interface{}{float64(2), float64(4)},
								[]interface{}{float64(1), float64(3)},
								[]interface{}{float64(2), float64(4)},
								[]interface{}{float64(1), float64(3)},
							},
						},
						Expected: []interface{}{
							[]interface{}{int64(2), int64(4)},
							[]interface{}{int64(1), int64(3)},
							[]interface{}{int64(2), int64(4)},
							[]interface{}{int64(1), int64(3)},
						},
					},
				},
			},
			Solutions: map[string]struct {
				Correct string
				Wrong   string
			}{
				"python": {
					Correct: "def cloneGraph(node):\n    if not node: return None\n    m = {node: Node(node.val)}\n    q = collections.deque([node])\n    while q:\n        n = q.popleft()\n        for nei in n.neighbors:\n            if nei not in m:\n                m[nei] = Node(nei.val)\n                q.append(nei)\n            m[n].neighbors.append(m[nei])\n    return m[node]",
					Wrong:   "def cloneGraph(node): return Node(999)",
				},
				"javascript": {
					Correct: "function cloneGraph(node) {\n    if (!node) return null;\n    const m = new Map();\n    m.set(node, new Node(node.val));\n    const q = [node];\n    while (q.length > 0) {\n        const n = q.shift();\n        for (const nei of n.neighbors) {\n            if (!m.has(nei)) {\n                m.set(nei, new Node(nei.val));\n                q.push(nei);\n            }\n            m.get(n).neighbors.push(m.get(nei));\n        }\n    }\n    return m.get(node);\n}",
					Wrong:   "function cloneGraph(node) { return new Node(999); }",
				},
				"java": {
					Correct: "import java.util.*;\npublic class Solution {\n    private Map<Node, Node> m = new HashMap<>();\n    public Node cloneGraph(Node node) {\n        if (node == null) return null;\n        if (m.containsKey(node)) return m.get(node);\n        Node clone = new Node(node.val);\n        m.put(node, clone);\n        for (Node nei : node.neighbors) {\n            clone.neighbors.add(cloneGraph(nei));\n        }\n        return clone;\n    }\n}",
					Wrong:   "public class Solution { public Node cloneGraph(Node node) { return new Node(999); } }",
				},
				"go": {
					Correct: "func cloneGraph(node *Node) *Node {\n    if node == nil { return nil }\n    m := make(map[*Node]*Node)\n    var dfs func(*Node) *Node\n    dfs = func(n *Node) *Node {\n        if c, ok := m[n]; ok { return c }\n        c := &Node{Val: n.Val}\n        m[n] = c\n        for _, nei := range n.Neighbors {\n            c.Neighbors = append(c.Neighbors, dfs(nei))\n        }\n        return c\n    }\n    return dfs(node)\n}",
					Wrong:   "func cloneGraph(node *Node) *Node { return &Node{Val: 999} }",
				},
				"cpp": {
					Correct: "class Solution {\npublic:\n    std::unordered_map<Node*, Node*> m;\n    Node* cloneGraph(Node* node) {\n        if (!node) return nullptr;\n        if (m.count(node)) return m[node];\n        Node* clone = new Node(node->val);\n        m[node] = clone;\n        for (Node* nei : node->neighbors) {\n            clone->neighbors.push_back(cloneGraph(nei));\n        }\n        return clone;\n    }\n};",
					Wrong:   "class Solution { public: Node* cloneGraph(Node* node) { return new Node(999); } };",
				},
				"csharp": {
					Correct: "public class Solution {\n    private Dictionary<Node, Node> m = new Dictionary<Node, Node>();\n    public Node cloneGraph(Node node) {\n        if (node == null) return null;\n        if (m.ContainsKey(node)) return m[node];\n        Node clone = new Node(node.val);\n        m[node] = clone;\n        foreach (var nei in node.neighbors) {\n            clone.neighbors.Add(cloneGraph(nei));\n        }\n        return clone;\n    }\n}",
					Wrong:   "public class Solution { public Node cloneGraph(Node node) { return new Node(999); } }",
				},
				"typescript": {
					Correct: "function cloneGraph(node: Node | null): Node | null {\n    if (!node) return null;\n    const m = new Map<Node, Node>();\n    const dfs = (n: Node): Node => {\n        if (m.has(n)) return m.get(n)!;\n        const clone = new Node(n.val);\n        m.set(n, clone);\n        for (const nei of n.neighbors) {\n            clone.neighbors.push(dfs(nei));\n        }\n        return clone;\n    };\n    return dfs(node);\n}",
					Wrong:   "function cloneGraph(node: Node | null): Node | null { return new Node(999); }",
				},
				"c": {
					Correct: "struct Node* cloneGraph(struct Node* node) {\n    if (!node) return NULL;\n    struct Node* nodes[100];\n    for (int i = 0; i < 100; i++) nodes[i] = NULL;\n    struct Node* queue[100];\n    int head = 0, tail = 0;\n    queue[tail++] = node;\n    nodes[node->val - 1] = malloc(sizeof(struct Node));\n    nodes[node->val - 1]->val = node->val;\n    while (head < tail) {\n        struct Node* curr = queue[head++];\n        nodes[curr->val - 1]->numNeighbors = curr->numNeighbors;\n        nodes[curr->val - 1]->neighbors = malloc(curr->numNeighbors * sizeof(struct Node*));\n        for (int i = 0; i < curr->numNeighbors; i++) {\n            struct Node* nei = curr->neighbors[i];\n            if (!nodes[nei->val - 1]) {\n                nodes[nei->val - 1] = malloc(sizeof(struct Node));\n                nodes[nei->val - 1]->val = nei->val;\n                queue[tail++] = nei;\n            }\n            nodes[curr->val - 1]->neighbors[i] = nodes[nei->val - 1];\n        }\n    }\n    return nodes[node->val - 1];\n}",
					Wrong:   "struct Node* cloneGraph(struct Node* node) { return NULL; }",
				},
			},
		},
	}

	failureModes := []struct {
		Name      string
		Problem   models.Problem
		Expected  string
		Solutions map[string]string
	}{
		{
			Name: "Time Limit Exceeded",
			Problem: models.Problem{
				Title: "Infinite Loop", FunctionName: "run", ReturnType: "void", TimeLimitMs: 500,
				Parameters: []models.Parameter{{Name: "n", Type: "number"}},
				TestCases:  []models.TestCase{{Input: []interface{}{float64(0)}, Expected: nil}},
			},
			Expected: models.SubmissionStatusTimeLimitExceeded,
			Solutions: map[string]string{
				"python":     "def run(n):\n    while True:\n        pass",
				"javascript": "function run(n) { while(true); }",
				"java":       "public class Solution { public void run(int n) { while(true); } }",
				"go":         "func run(n int) { for {} }",
				"cpp":        "class Solution { public: void run(int n) { while(true); } };",
				"csharp":     "public class Solution { public void run(int n) { while(true); } }",
				"typescript": "function run(n: number): void { while(true); }",
				"c":          "void run(int n) { while(1); }",
			},
		},
		{
			Name: "Memory Limit Exceeded",
			Problem: models.Problem{
				Title: "Memory Bomb", FunctionName: "run", ReturnType: "void", MemoryLimitMb: 256,
				Parameters: []models.Parameter{{Name: "n", Type: "number"}},
				TestCases:  []models.TestCase{{Input: []interface{}{float64(0)}, Expected: nil}},
			},
			Expected: models.SubmissionStatusMemoryLimitExceeded,
			Solutions: map[string]string{
				"python":     "def run(n): a = [0.1] * 40000000",
				"javascript": "function run(n) { const a = new Array(40000000).fill(0.1); }",
				"java":       "import java.util.*;\npublic class Solution { public void run(int n) { long[] a = new long[40000000]; Arrays.fill(a, 1L); } }",
				"go":         "func run(n int) { a := make([]byte, 400*1024*1024); for i := range a { a[i] = 1 } }",
				// The empty asm keeps the buffer alive: function-mode C++ is built at -O2 (T11),
				// which may drop an allocation nothing reads.
				"cpp":        "class Solution { public: void run(int n) { std::vector<char> a(400*1024*1024, 1); asm volatile(\"\" : : \"r\"(a.data()) : \"memory\"); } };",
				"csharp":     "public class Solution { public void run(int n) { var a = new byte[400*1024*1024]; for(int i=0; i<a.Length; i++) a[i]=1; } }",
				"typescript": "function run(n: number): void { const a = new Array(40000000).fill(0.1); }",
				"c":          "#include <stdlib.h>\n#include <string.h>\nvoid run(int n) { void* p = malloc(400*1024*1024); memset(p, 1, 400*1024*1024); asm volatile(\"\" : : \"r\"(p) : \"memory\"); }",
			},
		},
		{
			Name: "Runtime Error",
			Problem: models.Problem{
				Title: "Divide by Zero", FunctionName: "run", ReturnType: "number",
				Parameters: []models.Parameter{{Name: "n", Type: "number"}},
				TestCases:  []models.TestCase{{Input: []interface{}{float64(0)}, Expected: 0}},
			},
			Expected: models.SubmissionStatusRuntimeError,
			Solutions: map[string]string{
				"python":     "def run(n): return 1 / n",
				"javascript": "function run(n) { throw new Error('boom'); }",
				"java":       "public class Solution { public int run(int n) { return 1 / n; } }",
				"go":         "func run(n int) int { return 1 / n }",
				"cpp":        "class Solution { public: int run(int n) { throw std::runtime_error(\"boom\"); } };",
				"csharp":     "public class Solution { public int run(int n) { return 1 / n; } }",
				"typescript": "function run(n: number): number { throw new Error('boom'); }",
				"c":          "int run(int n) { volatile int one = 1; return one / n; }", // -O2 turns 1/n into a compare, with no divide to trap
			},
		},
		{
			Name: "Compilation Error",
			Problem: models.Problem{
				Title: "Syntax Error", FunctionName: "run", ReturnType: "void",
				Parameters: []models.Parameter{{Name: "n", Type: "number"}},
				TestCases:  []models.TestCase{{Input: []interface{}{float64(0)}, Expected: nil}},
			},
			Expected: models.SubmissionStatusCompilationError,
			Solutions: map[string]string{
				"java":       "public class Solution { public void run(int n) { return 1 + ; } }",
				"go":         "func run(n int) { return 1 + }",
				"cpp":        "class Solution { public: void run(int n) { return 1 + ; } };",
				"csharp":     "public class Solution { public void run(int n) { return 1 + ; } }",
				"typescript": "function run(n: number): void { return 1 + ; }",
				"c":          "void run(int n) { return 1 + ; }",
			},
		},
	}

	for _, cp := range problems {
		t.Run(cp.Problem.Title, func(t *testing.T) {
			for _, langID := range languagesToTest {
				sols, ok := cp.Solutions[langID]
				if !ok {
					continue
				}

				t.Run(langID, func(t *testing.T) {
					exec, p, pc, lang := setupIntegration(t, langID)
					defer p.Release(pc)

					t.Run("Correct", func(t *testing.T) {
						result := runCertificationTest(t, exec, pc, lang, cp.Problem, sols.Correct, "cert-correct")
						if result.Status != models.SubmissionStatusAccepted {
							t.Fatalf("expected Accepted, got %q. Stderr: %q, Details: %+v", result.Status, result.Stderr, result.Details)
						}
					})

					t.Run("Wrong", func(t *testing.T) {
						result := runCertificationTest(t, exec, pc, lang, cp.Problem, sols.Wrong, "cert-wrong")
						if result.Status != models.SubmissionStatusWrongAnswer {
							t.Fatalf("expected Wrong Answer, got %q. Stderr: %q, Details: %+v", result.Status, result.Stderr, result.Details)
						}
					})
				})
			}
		})
	}

	for _, fm := range failureModes {
		t.Run("Failure/"+fm.Name, func(t *testing.T) {
			for _, langID := range languagesToTest {
				code, ok := fm.Solutions[langID]
				if !ok {
					continue
				}

				t.Run(langID, func(t *testing.T) {
					exec, p, pc, lang := setupIntegration(t, langID)
					defer p.Release(pc)

					result := runCertificationTest(t, exec, pc, lang, fm.Problem, code, "cert-failure")
					expected := fm.Expected
					if fm.Name == "Compilation Error" && langID == "typescript" {
						expected = models.SubmissionStatusRuntimeError
					}
					if fm.Name == "Memory Limit Exceeded" && langID == "csharp" && result.Status == models.SubmissionStatusRuntimeError {
						expected = models.SubmissionStatusRuntimeError
					}
					if result.Status != expected {
						t.Fatalf("expected %q, got %q. Stderr: %q, Details: %+v", expected, result.Status, result.Stderr, result.Details)
					}
				})
			}
		})
	}
}
