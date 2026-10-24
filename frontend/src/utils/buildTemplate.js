import { mapType } from './typeValidator';

export function detectUses(parameters = [], returnType = '') {
  const uses = { tree: false, list: false, graph: false };
  const allTypes = [ ...(parameters || []).map(p => (p.type || '').toString()), (returnType || '').toString() ];
  for (const raw of allTypes) {
    const t = (raw || '').toLowerCase();
    if (!t) continue;
    if (t.includes('tree')) uses.tree = true;
    if (t.includes('linkedlist') || t.includes('listnode') || t === 'list' || t.includes('list')) uses.list = true;
    if (t.includes('graph')) uses.graph = true;
  }
  return uses;
}

export function getDefinitionsSnippet(language, parameters = [], returnType = '') {
  const { tree, list, graph } = detectUses(parameters, returnType);
  if (!tree && !list && !graph) return '';

  // Provide a concise, language-appropriate snippet containing only the structure definitions as comments
  switch ((language || '').toLowerCase()) {
    case 'python': {
      let out = '';
      if (list) out += `# class ListNode:\n#     def __init__(self, val=0, next=None):\n#         self.val = val\n#         self.next = next\n\n`;
      if (tree) out += `# class TreeNode:\n#     def __init__(self, val=0, left=None, right=None):\n#         self.val = val\n#         self.left = left\n#         self.right = right\n\n`;
      if (graph) out += `# class Node:\n#     def __init__(self, val=0, neighbors=None):\n#         self.val = val\n#         self.neighbors = neighbors if neighbors is not None else []\n\n`;
      return out.trim();
    }
    case 'javascript':
    case 'node':
    case 'js':
    case 'typescript':
    case 'ts': {
      let out = '';
      if (list) out += `/*\nclass ListNode {\n  constructor(val=0, next=null) { this.val = val; this.next = next; }\n}\n*/\n\n`;
      if (tree) out += `/*\nclass TreeNode {\n  constructor(val=0, left=null, right=null) { this.val = val; this.left = left; this.right = right; }\n}\n*/\n\n`;
      if (graph) out += `/*\nclass Node {\n  constructor(val=0, neighbors=[]) { this.val = val; this.neighbors = neighbors; }\n}\n*/\n\n`;
      return out.trim();
    }
    case 'go': {
      let out = '';
      if (list) out += `/*\ntype ListNode struct { Val int; Next *ListNode }\n*/\n\n`;
      if (tree) out += `/*\ntype TreeNode struct { Val int; Left *TreeNode; Right *TreeNode }\n*/\n\n`;
      if (graph) out += `/*\ntype Node struct { Val int; Neighbors []*Node }\n*/\n\n`;
      return out.trim();
    }
    case 'cpp': {
      let out = '';
      if (list) out += `/*\nstruct ListNode {\n    int val;\n    ListNode *next;\n    ListNode(int x) : val(x), next(nullptr) {}\n};\n*/\n\n`;
      if (tree) out += `/*\nstruct TreeNode {\n    int val;\n    TreeNode *left;\n    TreeNode *right;\n    TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}\n};\n*/\n\n`;
      return out.trim();
    }
    default: {
      // Default to Java-like definitions (familiar and explicit)
      let out = '';
      if (list) out += `/*\nclass ListNode {\n    int val;\n    ListNode next;\n    ListNode() { val = 0; next = null; }\n    ListNode(int val) { this.val = val; next = null; }\n    ListNode(int val, ListNode next) { this.val = val; this.next = next; }\n}\n*/\n\n`;
      if (tree) out += `/*\nclass TreeNode {\n    int val;\n    TreeNode left;\n    TreeNode right;\n    TreeNode() { val = 0; left = right = null; }\n    TreeNode(int val) { this.val = val; left = right = null; }\n    TreeNode(int val, TreeNode left, TreeNode right) { this.val = val; this.left = left; this.right = right; }\n}\n*/\n\n`;
      if (graph) out += `/*\nclass Node {\n    public int val;\n    public List<Node> neighbors;\n    public Node() { val = 0; neighbors = new ArrayList<>(); }\n    public Node(int val) { this.val = val; neighbors = new ArrayList<>(); }\n    public Node(int val, List<Node> neighbors) { this.val = val; this.neighbors = neighbors; }\n}\n*/\n\n`;
      return out.trim();
    }
  }
}

export default function buildTemplate(language, functionName, parameters = [], returnType = '') {
  const { tree: usesTree, list: usesList, graph: usesGraph } = detectUses(parameters, returnType);
  const paramNames = (parameters || []).map(p => p.name || 'arg');
  const params = paramNames.join(', ');

  if ((language || '').toLowerCase() === 'python') {
    let defs = '';
    if (usesList) defs += `# class ListNode:\n#     def __init__(self, val=0, next=None):\n#         self.val = val\n#         self.next = next\n\n`;
    if (usesTree) defs += `# class TreeNode:\n#     def __init__(self, val=0, left=None, right=None):\n#         self.val = val\n#         self.left = left\n#         self.right = right\n\n`;
    if (usesGraph) defs += `# class Node:\n#     def __init__(self, val=0, neighbors=None):\n#         self.val = val\n#         self.neighbors = neighbors if neighbors is not None else []\n\n`;
    defs += `def ${functionName}(${params}):\n    # your code here\n    pass`;
    return defs;
  }

  if ((language || '').toLowerCase() === 'javascript') {
    let defs = '';
    if (usesList) defs += `/*\nclass ListNode {\n  constructor(val=0, next=null) { this.val = val; this.next = next; }\n}\n*/\n\n`;
    if (usesTree) defs += `/*\nclass TreeNode {\n  constructor(val=0, left=null, right=null) { this.val = val; this.left = left; this.right = right; }\n}\n*/\n\n`;
    if (usesGraph) defs += `/*\nclass Node {\n  constructor(val=0, neighbors=[]) { this.val = val; this.neighbors = neighbors; }\n}\n*/\n\n`;
    defs += `function ${functionName}(${params}) {\n  // your code here\n}`;
    return defs;
  }

  if ((language || '').toLowerCase() === 'typescript') {
    const tsReturnType = mapType('typescript', returnType) || 'any';
    const tsParams = (parameters || []).map(p => `${p.name}: ${mapType('typescript', p.type) || 'any'}`).join(', ');
    
    let defs = '';
    if (usesList) defs += `/*\nclass ListNode {\n  val: number;\n  next: ListNode | null;\n  constructor(val=0, next=null) { this.val = val; this.next = next; }\n}\n*/\n\n`;
    if (usesTree) defs += `/*\nclass TreeNode {\n  val: number;\n  left: TreeNode | null;\n  right: TreeNode | null;\n  constructor(val=0, left=null, right=null) { this.val = val; this.left = left; this.right = right; }\n}\n*/\n\n`;
    if (usesGraph) defs += `/*\nclass Node {\n  val: number;\n  neighbors: Node[];\n  constructor(val=0, neighbors: Node[] = []) { this.val = val; this.neighbors = neighbors; }\n}\n*/\n\n`;
    defs += `function ${functionName}(${tsParams}): ${tsReturnType} {\n  // your code here\n}`;
    return defs;
  }

  if ((language || '').toLowerCase() === 'java') {
    const javaReturnType = mapType('java', returnType) || 'int';
    const javaParams = (parameters || []).map(p => `${mapType('java', p.type) || 'int'} ${p.name || 'arg'}`).join(', ');
    let defs = 'import java.util.*;\n\n';
    if (usesList) {
      defs += `/*\nclass ListNode {\n    int val;\n    ListNode next;\n    ListNode() { val = 0; next = null; }\n    ListNode(int val) { this.val = val; next = null; }\n    ListNode(int val, ListNode next) { this.val = val; this.next = next; }\n}\n*/\n\n`;
    }
    if (usesTree) {
      defs += `/*\nclass TreeNode {\n    int val;\n    TreeNode left;\n    TreeNode right;\n    TreeNode() { val = 0; left = right = null; }\n    TreeNode(int val) { this.val = val; left = right = null; }\n    TreeNode(int val, TreeNode left, TreeNode right) { this.val = val; this.left = left; this.right = right; }\n}\n*/\n\n`;
    }
    if (usesGraph) {
      defs += `/*\nclass Node {\n    public int val;\n    public List<Node> neighbors;\n    public Node() { val = 0; neighbors = new ArrayList<>(); }\n    public Node(int val) { this.val = val; neighbors = new ArrayList<>(); }\n    public Node(int val, List<Node> neighbors) { this.val = val; this.neighbors = neighbors; }\n}\n*/\n\n`;
    }
    defs += `class Solution {\n    public ${javaReturnType} ${functionName}(${javaParams}) {\n        // your code here\n    }\n}`;
    return defs;
  }
  const lang = (language || '').toLowerCase();

  if (lang === 'cpp') {
    const cppReturn = mapType('cpp', returnType) || 'int';
    const cppParams = (parameters || []).map(p => {
      const type = mapType('cpp', p.type);
      const isComplex = type.startsWith('vector') || type === 'string';
      return `${type}${isComplex ? '&' : ''} ${p.name}`;
    }).join(', ');
    
    let template = `#include <iostream>\n#include <vector>\n#include <string>\n#include <algorithm>\n\nusing namespace std;\n\n`;
    if (usesList) {
      template += `/*\nstruct ListNode {\n    int val;\n    ListNode *next;\n    ListNode(int x) : val(x), next(nullptr) {}\n};\n*/\n\n`;
    }
    if (usesTree) {
      template += `/*\nstruct TreeNode {\n    int val;\n    TreeNode *left;\n    TreeNode *right;\n    TreeNode(int x) : val(x), left(nullptr), right(nullptr) {}\n};\n*/\n\n`;
    }
    template += `class Solution {\npublic:\n    ${cppReturn} ${functionName}(${cppParams}) {\n        // your code here\n    }\n};`;
    return template;
  }

  if (lang === 'csharp') {
    const csReturn = mapType('csharp', returnType) || 'int';
    const csParams = (parameters || []).map(p => `${mapType('csharp', p.type)} ${p.name}`).join(', ');
    let defsCS = `using System;\nusing System.Collections.Generic;\n\n`;
    // Show as comments to avoid duplicate type definitions at compile time
    if (usesList) defsCS += `/*\npublic class ListNode { public int val; public ListNode next; public ListNode(int x=0) { val = x; next = null; } }\n*/\n\n`;
    if (usesTree) defsCS += `/*\npublic class TreeNode { public int val; public TreeNode left; public TreeNode right; public TreeNode(int x=0) { val = x; left = right = null; } }\n*/\n\n`;
    if (usesGraph) defsCS += `/*\npublic class Node { public int val; public List<Node> neighbors; public Node() { neighbors = new List<Node>(); } public Node(int v) { val = v; neighbors = new List<Node>(); } }\n*/\n\n`;
    defsCS += `public class Solution {\n    public ${csReturn} ${functionName}(${csParams}) {\n        // your code here\n    }\n}`;
    return defsCS;
  }

  if (lang === 'go') {
    const goReturn = mapType('go', returnType) || '';
    const goParams = (parameters || []).map(p => `${p.name} ${mapType('go', p.type)}`).join(', ');
    let defsGo = `package main\n\n`;
    // Show type definitions as comments to avoid duplicate type names when wrapper also defines helpers
    if (usesList) defsGo += `/*\ntype ListNode struct { Val int; Next *ListNode }\n*/\n\n`;
    if (usesTree) defsGo += `/*\ntype TreeNode struct { Val int; Left *TreeNode; Right *TreeNode }\n*/\n\n`;
    if (usesGraph) defsGo += `/*\ntype Node struct { Val int; Neighbors []*Node }\n*/\n\n`;
    defsGo += `func ${functionName}(${goParams}) ${goReturn} {\n    // your code here\n    return ${goReturn === 'string' ? '""' : goReturn === 'bool' ? 'false' : goReturn.includes('[]') ? 'nil' : '0'}\n}`;
    return defsGo;
  }

  if (lang === 'c') {
    const cReturn = mapType('c', returnType) || 'int';
    const paramsList = [];
    (parameters || []).forEach(p => {
      paramsList.push(`${mapType('c', p.type)} ${p.name}`);
      if (p.type.startsWith('array<')) {
        paramsList.push(`int ${p.name}Size`);
      } else if (p.type.startsWith('matrix<')) {
        paramsList.push(`int ${p.name}Rows`);
        paramsList.push(`int* ${p.name}Cols`);
      }
    });

    if (returnType.startsWith('array<')) {
      paramsList.push(`int* outputSize`);
    } else if (returnType.startsWith('matrix<')) {
      paramsList.push(`int* outputRows`);
      paramsList.push(`int** outputCols`);
    }

    const cParams = paramsList.join(', ');

    let defsC = `#include <stdbool.h>\n#include <stddef.h>\n#include <stdlib.h>\n\n`;
    if (usesList) defsC += `/*\nstruct ListNode {\n    int val;\n    struct ListNode *next;\n};\n*/\n\n`;
    if (usesTree) defsC += `/*\nstruct TreeNode {\n    int val;\n    struct TreeNode *left;\n    struct TreeNode *right;\n};\n*/\n\n`;
    if (usesGraph) defsC += `/*\nstruct Node {\n    int val;\n    int numNeighbors;\n    struct Node **neighbors;\n};\n*/\n\n`;
    
    defsC += `${cReturn} ${functionName}(${cParams}) {\n    // your code here\n    return ${cReturn.includes('*') ? 'NULL' : '0'};\n}`;
    return defsC;
  }

  if (lang === 'ruby') {
    let defsRb = '';
    if (usesList) defsRb += `# class ListNode\n#   attr_accessor :val, :next\n#   def initialize(val = 0, nxt = nil)\n#     @val = val\n#     @next = nxt\n#   end\n# end\n\n`;
    if (usesTree) defsRb += `# class TreeNode\n#   attr_accessor :val, :left, :right\n#   def initialize(val = 0, left = nil, right = nil)\n#     @val = val\n#     @left = left\n#     @right = right\n#   end\n# end\n\n`;
    if (usesGraph) defsRb += `# class Node\n#   attr_accessor :val, :neighbors\n#   def initialize(val = 0, neighbors = [])\n#     @val = val\n#     @neighbors = neighbors\n#   end\n# end\n\n`;
    defsRb += `class Solution\n  def ${functionName}(${params})\n    # your code here\n  end\nend`;
    return defsRb;
  }

  if (lang === 'php') {
    let defsPhp = `<?php\n\n`;
    if (usesList) defsPhp += `/*\nclass ListNode {\n    public $val;\n    public $next;\n    function __construct($val = 0, $next = null) { $this->val = $val; $this->next = $next; }\n}\n*/\n\n`;
    if (usesTree) defsPhp += `/*\nclass TreeNode {\n    public $val;\n    public $left;\n    public $right;\n    function __construct($val = 0, $left = null, $right = null) { $this->val = $val; $this->left = $left; $this->right = $right; }\n}\n*/\n\n`;
    if (usesGraph) defsPhp += `/*\nclass Node {\n    public $val;\n    public $neighbors;\n    function __construct($val = 0, $neighbors = []) { $this->val = $val; $this->neighbors = $neighbors; }\n}\n*/\n\n`;
    const phpParams = paramNames.map(p => `$${p}`).join(', ');
    defsPhp += `class Solution {\n    function ${functionName}(${phpParams}) {\n        // your code here\n    }\n}`;
    return defsPhp;
  }

  if (lang === 'kotlin') {
    const ktReturnType = mapType('kotlin', returnType) || 'Unit';
    const ktParams = (parameters || []).map(p => `${p.name}: ${mapType('kotlin', p.type) || 'Int'}`).join(', ');
    let defsKt = '';
    if (usesList) defsKt += `/*\nclass ListNode(var \`val\`: Int = 0) {\n    var next: ListNode? = null\n}\n*/\n\n`;
    if (usesTree) defsKt += `/*\nclass TreeNode(var \`val\`: Int = 0) {\n    var left: TreeNode? = null\n    var right: TreeNode? = null\n}\n*/\n\n`;
    if (usesGraph) defsKt += `/*\nclass Node(var \`val\`: Int = 0) {\n    var neighbors: MutableList<Node> = mutableListOf()\n}\n*/\n\n`;
    defsKt += `class Solution {\n    fun ${functionName}(${ktParams}): ${ktReturnType} {\n        // your code here\n    }\n}`;
    return defsKt;
  }

  if (lang === 'rust') {
    const rustReturnType = mapType('rust', returnType) || '()';
    const rustParams = (parameters || []).map(p => `${p.name}: ${mapType('rust', p.type) || 'i32'}`).join(', ');
    let defsRs = '';
    if (usesList) defsRs += `/*\npub struct ListNode {\n    pub val: i32,\n    pub next: Option<Box<ListNode>>,\n}\n*/\n\n`;
    if (usesTree) defsRs += `/*\npub struct TreeNode {\n    pub val: i32,\n    pub left: Option<Rc<RefCell<TreeNode>>>,\n    pub right: Option<Rc<RefCell<TreeNode>>>,\n}\n*/\n\n`;
    if (usesGraph) defsRs += `/*\npub struct Node {\n    pub val: i32,\n    pub neighbors: Vec<Option<Rc<RefCell<Node>>>>,\n}\n*/\n\n`;
    defsRs += `struct Solution;\n\nimpl Solution {\n    pub fn ${functionName}(&self, ${rustParams}) -> ${rustReturnType} {\n        // your code here\n    }\n}`;
    return defsRs;
  }

  // Generic fallback: include brief placeholders
  let out = '';
  if (usesList) out += `/* ListNode definition placeholder */\n`;
  if (usesTree) out += `/* TreeNode definition placeholder */\n`;
  if (usesGraph) out += `/* Node (graph) definition placeholder */\n`;
  out += `// ${functionName}(${params})\n// implement here`;
  return out;
}

// Starter code for a stdin problem (JUDGE_FIX_PLAN P8): a whole program that reads the input
// and prints the answer. There is no function signature to build from.
const STDIN_TEMPLATES = {
  python: `import sys\n\ndef main():\n    data = sys.stdin.read().split()\n    # Read the input from data and print the answer\n    print()\n\nmain()\n`,
  javascript: `const data = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/);\n// Read the input from data and print the answer\nconsole.log();\n`,
  typescript: `const data: string[] = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/);\n// Read the input from data and print the answer\nconsole.log();\n`,
  java: `import java.util.*;\nimport java.io.*;\n\npublic class Main {\n    public static void main(String[] args) throws IOException {\n        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));\n        // Read the input and print the answer\n        System.out.println();\n    }\n}\n`,
  cpp: `#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    ios::sync_with_stdio(false);\n    cin.tie(nullptr);\n    // Read the input and print the answer\n    return 0;\n}\n`,
  c: `#include <stdio.h>\n\nint main(void) {\n    // Read the input and print the answer\n    return 0;\n}\n`,
  go: `package main\n\nimport (\n\t"bufio"\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tin := bufio.NewReader(os.Stdin)\n\t_ = in\n\t// Read the input and print the answer\n\tfmt.Println()\n}\n`,
  csharp: `using System;\n\nclass Program {\n    static void Main() {\n        // Read the input with Console.ReadLine() and print the answer\n        Console.WriteLine();\n    }\n}\n`,
  rust: `use std::io::{self, Read};\n\nfn main() {\n    let mut input = String::new();\n    io::stdin().read_to_string(&mut input).unwrap();\n    // Read the input and print the answer\n    println!();\n}\n`,
  ruby: `data = STDIN.read.split\n# Read the input from data and print the answer\nputs\n`,
  php: `<?php\n$data = preg_split('/\\s+/', trim(stream_get_contents(STDIN)));\n// Read the input from $data and print the answer\necho PHP_EOL;\n`,
  kotlin: `fun main() {\n    // Read the input with readLine() and print the answer\n    println()\n}\n`
};

export function buildStdinTemplate(language) {
  return STDIN_TEMPLATES[(language || '').toLowerCase()] || '// Read the input and print the answer\n';
}

// The right starter code for any coding problem.
export function starterCode(language, problem) {
  if ((problem?.problemType || 'function') === 'stdin') return buildStdinTemplate(language);
  return buildTemplate(language, problem?.functionName || 'solution', problem?.parameters, problem?.returnType);
}
