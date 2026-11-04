import { describe, it, expect } from "vitest";
import { analyze, stripWorkspacePaths, findUnclosedBrace, didYouMean, isPythonSyntaxError, describeSignal } from "./diagnostics.service.js";

// Fixtures are real outputs captured on the exam portal and the testing stack on 2026-11-04
// (docs/EDITOR_UX_PLAN.md, "Realistic mistakes"), with the workspace ids as the judge printed them.
const P = "/app/sub-raw-1793764557356411094-3867768528/";

describe("stripWorkspacePaths", () => {
  it("removes the judge's workspace and shows interpreted sources as main.*", () => {
    expect(stripWorkspacePaths(`${P}main.cpp:5:5: error: x`)).toBe("main.cpp:5:5: error: x");
    expect(stripWorkspacePaths(`File "${P}solution.py", line 3`)).toBe('File "main.py", line 3');
    expect(stripWorkspacePaths("e: file:///app/Main.kt:3:5 Unresolved reference 'x'.")).toBe("e: Main.kt:3:5 Unresolved reference 'x'.");
    expect(stripWorkspacePaths("/home/judge/app/Program.cs(5,13): error CS0103")).toBe("Program.cs(5,13): error CS0103");
  });
});

describe("C++", () => {
  it("cout << vector: one diagnostic on the student's line, not 107 lines of candidates", () => {
    const code = "#include <iostream>\n#include <vector>\n#include <set>\nusing namespace std;\n\nint main() {\n    int n;\n    cin >> n;\n    vector<int> arr(n);\n    for (int i = 0; i < n; i++) cin >> arr[i];\n    vector<int> result;\n    set<int> seen;\n    for (int x : arr) {\n        if (!seen.count(x)) { seen.insert(x); result.push_back(x); }\n    }\n    cout << result << endl;\n    return 0;\n}\n";
    const out = [
      `${P}main.cpp: In function 'int main()':`,
      `${P}main.cpp:16:10: error: no match for 'operator<<' (operand types are 'std::ostream' {aka 'std::basic_ostream<char>'} and 'std::vector<int>')`,
      "   16 |     cout << result << endl;",
      "      |     ~~~~ ^~ ~~~~~~",
      "  • there are 47 candidates",
      `    ${P}main.cpp:16:10:`,
      "/usr/local/include/c++/16.2.0/ostream:116:7: note: candidate 1: 'std::basic_ostream<_CharT, _Traits>::__ostream_type& std::basic_ostream<_CharT, _Traits>::operator<<(__ostream_type& (*)(__ostream_type&))'",
      "  116 |       operator<<(__ostream_type& (*__pf)(__ostream_type&))"
    ].join("\n");
    const d = analyze({ language: "cpp", code, compileOutput: out, kind: "compile" });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ line: 16, column: 10, kind: "compile" });
    expect(d[0].message).toBe("no match for 'operator<<' (operand types are 'std::ostream' and 'std::vector<int>')");
    expect(d[0].hint).toMatch(/can't print a whole vector/);
  });

  it("sort() on a set: the error inside stl_algo.h is moved to the student's line 9", () => {
    const code = "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    int n;\n    cin >> n;\n    set<int> values;\n    for (int i = 0; i < n; i++) { int x; cin >> x; values.insert(x); }\n    sort(values.begin(), values.end());\n    long long best = *values.begin();\n    cout << best << endl;\n    return 0;\n}\n";
    const out = [
      "In file included from /usr/local/include/c++/16.2.0/algorithm:63,",
      "                 from /usr/local/include/c++/16.2.0/x86_64-linux-gnu/bits/stdc++.h:51:",
      "/usr/local/include/c++/16.2.0/bits/stl_algo.h: In instantiation of 'constexpr void std::__sort(_RandomAccessIterator, _RandomAccessIterator, _Compare) [with _RandomAccessIterator = _Rb_tree_const_iterator<int>; _Compare = less<void>]':",
      "/usr/local/include/c++/16.2.0/bits/stl_algo.h:4817:18:   required from 'constexpr void std::sort(_RAIter, _RAIter) [with _RAIter = _Rb_tree_const_iterator<int>]'",
      " 4817 |       std::__sort(__first, __last, __gnu_cxx::__ops::less());",
      "      |       ~~~~~~~~~~~^~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
      `${P}main.cpp:9:9:   required from here`,
      "    9 |     sort(values.begin(), values.end());",
      "      |     ~~~~^~~~~~~~~~~~~~~~~~~~~~~~~~~~~~",
      "/usr/local/include/c++/16.2.0/bits/stl_algo.h:1914:50: error: no match for 'operator-' (operand types are 'std::_Rb_tree_const_iterator<int>' and 'std::_Rb_tree_const_iterator<int>')",
      " 1914 |       std::__introsort_loop(__first, __last, std::__lg(__last - __first) * 2,"
    ].join("\n");
    const d = analyze({ language: "cpp", code, compileOutput: out, kind: "compile" });
    expect(d[0]).toMatchObject({ line: 9 });
    expect(d[0].hint).toMatch(/sort\(\)` only works on a vector/);
  });

  it("three slips: each on its own line, typo with its did-you-mean, greater<int> without ()", () => {
    const code = "#include <iostream>\n#include <vector>\nusing namespace std;\n\nint main() {\n    int n;\n    cin >> n;\n    vector<int> arr(n);\n    for (int i = 0; i < n; i++) cin >> arr[i];\n    sort(arr.begin(), arr.end(), greater<int>);\n    int largest = arr[0], second = -1;\n    for (int i = 1; i < n; i++) {\n        if (arr[i] != largest) { secnd = arr[i]; break; }\n    }\n    cout << second << endl;\n    return 0;\n}\n";
    const out = [
      `${P}main.cpp: In function 'int main()':`,
      `${P}main.cpp:10:46: error: expected primary-expression before ')' token`,
      "   10 |     sort(arr.begin(), arr.end(), greater<int>);",
      "      |                                              ^",
      `${P}main.cpp:10:5: error: 'sort' was not declared in this scope; did you mean 'short'?`,
      "   10 |     sort(arr.begin(), arr.end(), greater<int>);",
      "      |     ^~~~",
      "      |     short",
      `${P}main.cpp:13:34: error: 'secnd' was not declared in this scope; did you mean 'second'?`,
      "   13 |         if (arr[i] != largest) { secnd = arr[i]; break; }",
      "      |                                  ^~~~~",
      "      |                                  second"
    ].join("\n");
    const d = analyze({ language: "cpp", code, compileOutput: out, kind: "compile" });
    expect(d.map((x) => x.line)).toEqual([10, 10, 13]);
    expect(d[0].hint).toMatch(/greater<int>\(\)/);
    expect(d[1].hint).toMatch(/#include <algorithm>/);
    expect(d[2].hint).toBe("`secnd` isn't defined. Did you mean `second`?");
  });

  it("missing '}' points at the else block that is never closed, not at main", () => {
    const code = "#include <iostream>\n#include <stack>\n#include <string>\nusing namespace std;\n\nbool isMatch(char open, char close) {\n    return (open == '(' && close == ')') || (open == '[' && close == ']') || (open == '{' && close == '}');\n}\n\nint main() {\n    string s;\n    getline(cin, s);\n    stack<char> st;\n    for (char c : s) {\n        if (c == '(' || c == '[' || c == '{') {\n            st.push(c);\n        } else {\n            if (st.empty() || !isMatch(st.top(), c)) {\n                cout << \"NO\" << endl;\n                return 0;\n            }\n            st.pop();\n    }\n    cout << (st.empty() ? \"YES\" : \"NO\") << endl;\n    return 0;\n}\n";
    const out = `${P}main.cpp: In function 'int main()':\n${P}main.cpp:26:2: error: expected '}' at end of input\n   26 | }\n      |  ^\n${P}main.cpp:10:12: note: to match this '{'\n   10 | int main() {\n      |            ^\n`;
    const d = analyze({ language: "cpp", code, compileOutput: out, kind: "compile" });
    expect(d[0].line).toBe(17);
    expect(d[0].message).toMatch(/'\{' on line 17 is never closed/);
  });

  it("vector without its header", () => {
    const code = "#include <iostream>\nusing namespace std;\nint main() {\n    int n; cin >> n;\n    vector<int> a(n);\n}\n";
    const out = `${P}main.cpp: In function 'int main()':\n${P}main.cpp:5:5: error: 'vector' was not declared in this scope\n    5 |     vector<int> a(n);\n      |     ^~~~~~\n${P}main.cpp:2:1: note: 'std::vector' is defined in header '<vector>'; this is probably fixable by adding '#include <vector>'`;
    const d = analyze({ language: "cpp", code, compileOutput: out, kind: "compile" });
    expect(d[0]).toMatchObject({ line: 5 });
    expect(d[0].hint).toMatch(/#include <vector>/);
  });

  it("a segfault with an empty stderr is explained", () => {
    const d = analyze({ language: "cpp", code: "int main(){int*p=0;return *p;}", stderr: "", kind: "runtime", exitCode: 139 });
    expect(d[0]).toMatchObject({ line: null, kind: "runtime", message: "Segmentation fault (exit code 139)" });
    expect(d[0].hint).toMatch(/index out of range/);
  });

  it("division by zero at -O2 (SIGILL) is explained", () => {
    const d = analyze({ language: "cpp", code: "", stderr: "", kind: "runtime", exitCode: 132 });
    expect(d[0].hint).toMatch(/division by zero/);
  });
});

describe("C", () => {
  it("missing ';' is reported on the line that's missing it, not the next one", () => {
    const code = "#include <stdio.h>\n\nint gcd(int a, int b) {\n    if (a < 0) a = -a;\n    if (b < 0) b = -b;\n    while (b != 0) {\n        int t = a % b;\n        a = b;\n        b = t;\n    }\n    return a;\n}\n\nint main() {\n    int a, b;\n    scanf(\"%d %d\", &a, &b);\n    int ans = gcd(a, b)\n    pritnf(\"%d\\n\", ans);\n    return 0;\n}\n";
    const out = `${P}main.c: In function 'main':\n${P}main.c:18:5: error: expected ',' or ';' before 'pritnf'\n   18 |     pritnf("%d\\n", ans);\n      |     ^~~~~~\n`;
    const d = analyze({ language: "c", code, compileOutput: out, kind: "compile" });
    expect(d[0]).toMatchObject({ line: 17, column: 24 });
    expect(d[0].hint).toBe("Missing `;` at the end of this line.");
  });

  it("strlen without string.h names the header", () => {
    const code = "#include <stdio.h>\nint main() {\n    char s[1005], t[1005]; int k = 0;\n    fgets(s, sizeof s, stdin);\n    for (int i = 0; i < strlen(s); i++)\n        t[k++] = s[i];\n    return 0;\n}\n";
    const out = `${P}main.c: In function 'main':\n${P}main.c:5:25: error: implicit declaration of function 'strlen' [-Wimplicit-function-declaration]\n    5 |     for (int i = 0; i < strlen(s); i++)\n      |                         ^~~~~~\n${P}main.c:2:1: note: include '<string.h>' or provide a declaration of 'strlen'`;
    const d = analyze({ language: "c", code, compileOutput: out, kind: "compile" });
    expect(d[0]).toMatchObject({ line: 5, column: 25 });
    expect(d[0].hint).toBe("`strlen` needs `#include <string.h>` at the top.");
  });

  it("a misspelled printf suggests printf", () => {
    const code = "#include <stdio.h>\nint main() {\n    pritnf(\"hi\");\n    return 0;\n}\n";
    const out = `${P}main.c:3:5: error: implicit declaration of function 'pritnf'; did you mean 'printf'? [-Wimplicit-function-declaration]\n    3 |     pritnf("hi");\n      |     ^~~~~~`;
    const d = analyze({ language: "c", code, compileOutput: out, kind: "compile" });
    expect(d[0].hint).toBe("`pritnf` doesn't exist. Did you mean `printf`?");
  });

  it("a missing ';' that swallows the next declaration shows one card, not a follow-on 'undeclared'", () => {
    const code = "#include <stdio.h>\nint main(){\n  int n;\n  scanf(\"%d\",&n)\n  long long t=0;\n  for(int i=0;i<n;i++){int x;scanf(\"%d\",&x);t+=x;}\n  printf(\"%lld\\n\",t);\n}";
    const out = [
      `${P}main.c: In function 'main':`,
      `${P}main.c:4:17: error: expected ';' before 'long'`,
      `    4 |   scanf("%d",&n)`,
      `      |                 ^`,
      `      |                 ;`,
      `    5 |   long long t=0;`,
      `      |   ~~~~`,
      `${P}main.c:6:45: error: 't' undeclared (first use in this function)`,
      `    6 |   for(int i=0;i<n;i++){int x;scanf("%d",&x);t+=x;}`,
      `      |                                             ^`
    ].join("\n");
    const d = analyze({ language: "c", code, compileOutput: out, kind: "compile" });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ line: 4, hint: "Missing `;` at the end of this line." });
  });

  it("a real undeclared name is still reported, without guessing for one-letter names", () => {
    const code = "#include <stdio.h>\nint main(){\n  printf(\"%d\", t);\n}";
    const out = `${P}main.c: In function 'main':\n${P}main.c:3:16: error: 't' undeclared (first use in this function)\n    3 |   printf("%d", t);\n      |                ^`;
    const d = analyze({ language: "c", code, compileOutput: out, kind: "compile" });
    expect(d[0]).toMatchObject({ line: 3, hint: "`t` isn't defined: check the spelling, and declare it before this line." });
  });
});

describe("Python", () => {
  it("NameError deep in a call stack: the cause comes first, on the student's line", () => {
    const code = "def read_ints():\n    return list(map(int, input().split()))\n\n\ndef merge(a, b):\n    i = j = 0\n    out = []\n    while i < len(a) and j < len(b):\n        if a[i] <= b[j]:\n            out.append(a[i])\n            i += 1\n        else:\n            out.append(b[j])\n            j += 1\n    out.extend(a[i:])\n    out.extend(b[j:])\n    return reuslt\n\n\ndef main():\n    n, m = read_ints()\n    a = read_ints()\n    b = read_ints()\n    merged = merge(a, b)\n    print(\" \".join(map(str, merged)))\n\n\nmain()\n";
    const tb = `Traceback (most recent call last):\n  File "${P}solution.py", line 28, in <module>\n    main()\n  File "${P}solution.py", line 24, in main\n    merged = merge(a, b)\n  File "${P}solution.py", line 17, in merge\n    return reuslt\nNameError: name 'reuslt' is not defined\n`;
    const d = analyze({ language: "python", code, stderr: tb, kind: "runtime" });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ line: 17, message: "NameError: name 'reuslt' is not defined" });
    expect(d[0].hint).toMatch(/isn't defined/);
  });

  it("suggests a close name from the student's own code", () => {
    const code = "result = 0\nfor x in [1, 2]:\n    result += x\nprint(reuslt)\n";
    const tb = `Traceback (most recent call last):\n  File "${P}solution.py", line 4, in <module>\n    print(reuslt)\n          ^^^^^^\nNameError: name 'reuslt' is not defined. Did you mean: 'result'?\n`;
    const d = analyze({ language: "python", code, stderr: tb, kind: "runtime" });
    expect(d[0].hint).toBe("`reuslt` isn't defined. Did you mean `result`?");
  });

  it("IndentationError is a compile error on the right line", () => {
    const code = "n = int(input())\narr = list(map(int, input().split()))\nbest = arr[0]\ncur = 0\nfor x in arr:\ncur = max(x, cur + x)\n    best = max(best, cur)\nprint(best)\n";
    const err = `  File "${P}solution.py", line 6\n    cur = max(x, cur + x)\n    ^\nIndentationError: expected an indented block after 'for' statement on line 5\n`;
    expect(isPythonSyntaxError(err)).toBe(true);
    const d = analyze({ language: "python", code, stderr: err, kind: "compile" });
    expect(d[0]).toMatchObject({ line: 6, kind: "compile" });
    expect(d[0].hint).toMatch(/must be indented/);
  });

  it("reading a one-line array with int(input()) in a loop", () => {
    const code = "n = int(input())\narr = []\nfor i in range(n):\n    arr.append(int(input()))\nprint(arr)\n";
    const tb = `Traceback (most recent call last):\n  File "${P}solution.py", line 4, in <module>\n    arr.append(int(input()))\n               ^^^^^^^^^^^^\nValueError: invalid literal for int() with base 10: '4 1 7 7 3'\n`;
    const d = analyze({ language: "python", code, stderr: tb, kind: "runtime" });
    expect(d[0]).toMatchObject({ line: 4 });
    expect(d[0].hint).toMatch(/list\(map\(int, input\(\)\.split\(\)\)\)/);
  });

  it("EOFError explains reading more lines than the input has", () => {
    const tb = `Traceback (most recent call last):\n  File "${P}solution.py", line 2, in <module>\n    b = input()\nEOFError: EOF when reading a line\n`;
    const d = analyze({ language: "python", code: "a = input()\nb = input()\n", stderr: tb, kind: "runtime" });
    expect(d[0]).toMatchObject({ line: 2 });
    expect(d[0].hint).toMatch(/more times than the input has lines/);
  });

  it("drops a line that is in the judge's wrapper rather than the student's code", () => {
    const tb = `Traceback (most recent call last):\n  File "/app/wrapper.py", line 88, in <module>\n    result = harness_call()\nZeroDivisionError: division by zero\n`;
    const d = analyze({ language: "python", code: "def f(x):\n    return 1\n", stderr: tb, kind: "runtime", trustLines: false });
    expect(d[0]).toMatchObject({ line: null, message: "ZeroDivisionError: division by zero" });
  });

  it("finds the student's line inside a wrapper by its text", () => {
    const tb = `Traceback (most recent call last):\n  File "/app/wrapper.py", line 88, in <module>\n    out = sumList(nums)\n  File "/app/wrapper.py", line 12, in sumList\n    return total / count\nZeroDivisionError: division by zero\n`;
    const code = "def sumList(nums):\n    total = sum(nums)\n    count = 0\n    return total / count\n";
    const d = analyze({ language: "python", code, stderr: tb, kind: "runtime", trustLines: false });
    expect(d[0]).toMatchObject({ line: 4 });
  });
});

describe("Java", () => {
  it("public class Solution", () => {
    const code = "import java.util.*;\n\npublic class Solution {\n    public static void main(String[] args) {\n    }\n}\n";
    const out = `${P}Main.java:3: error: class Solution is public, should be declared in a file named Solution.java\npublic class Solution {\n       ^\n1 error\n`;
    const d = analyze({ language: "java", code, compileOutput: out, kind: "compile" });
    expect(d[0]).toMatchObject({ line: 3, column: 8 });
    expect(d[0].hint).toMatch(/public class Main/);
  });

  it("Scanner without its import", () => {
    const code = "public class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n    }\n}\n";
    const out = `Main.java:3: error: cannot find symbol\n        Scanner sc = new Scanner(System.in);\n        ^\n  symbol:   class Scanner\n  location: class Main\n1 error\n`;
    const d = analyze({ language: "java", code, compileOutput: out, kind: "compile" });
    expect(d[0]).toMatchObject({ line: 3 });
    expect(d[0].hint).toMatch(/import java\.util\.Scanner;/);
  });

  it("runtime exception points at the student's frame", () => {
    const code = "import java.util.*;\npublic class Main {\n  public static void main(String[] a) {\n    int[] x = new int[3];\n    Scanner s = new Scanner(System.in);\n    int n = s.nextInt();\n    System.out.println(x[n]);\n  }\n}\n";
    const err = 'Exception in thread "main" java.lang.ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 3\n\tat Main.main(Main.java:7)\n';
    const d = analyze({ language: "java", code, stderr: err, kind: "runtime" });
    expect(d[0]).toMatchObject({ line: 7, message: "ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 3" });
    expect(d[0].hint).toBe("Index 5 is outside the array: valid indexes are 0 to 2.");
  });
});

describe("JavaScript", () => {
  it("prompt() explains how to read input in Node", () => {
    const err = `${P}solution.js:1\nconst n=Number(prompt());console.log(n)\n               ^\n\nReferenceError: prompt is not defined\n    at Object.<anonymous> (${P}solution.js:1:16)\n    at Module._compile (node:internal/modules/cjs/loader:1521:14)\n`;
    const d = analyze({ language: "javascript", code: "const n=Number(prompt());console.log(n)", stderr: err, kind: "runtime" });
    expect(d[0]).toMatchObject({ line: 1, column: 16, message: "ReferenceError: prompt is not defined" });
    expect(d[0].hint).toMatch(/readFileSync/);
  });
});

describe("other languages", () => {
  it("C# undefined name with a suggestion, reported once", () => {
    const out = "Program.cs(5,13): error CS0103: The name 'totl' does not exist in the current context [/home/judge/app/app.csproj]\nProgram.cs(5,13): error CS0103: The name 'totl' does not exist in the current context [/home/judge/app/app.csproj]\n";
    const code = "using System;\nclass P {\n  static void Main() {\n    int total = 0;\n    Console.WriteLine(totl);\n  }\n}\n";
    const d = analyze({ language: "csharp", code, compileOutput: out, kind: "compile" });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ line: 5, column: 13 });
    expect(d[0].hint).toBe("`totl` isn't defined. Did you mean `total`?");
  });

  it("Rust uses the compiler's own help line", () => {
    const out = "error[E0425]: cannot find value `secnd` in this scope\n --> main.rs:4:20\n  |\n4 |     println!(\"{}\", secnd);\n  |                    ^^^^^ help: a local variable with a similar name exists: `second`\n\nerror: aborting due to 1 previous error\n";
    const code = "fn main() {\n    let second = 2;\n    let _x = 1;\n    println!(\"{}\", secnd);\n}\n";
    const d = analyze({ language: "rust", code, compileOutput: out, kind: "compile" });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ line: 4, column: 20 });
    expect(d[0].hint).toMatch(/similar name exists: `second`/);
  });

  it("Go unused variable", () => {
    const out = "# solution\n./main.go:5:2: declared and not used: x\n";
    const code = "package main\nimport \"fmt\"\nfunc main() {\n\tfmt.Println(1)\n\tx := 2\n}\n";
    const d = analyze({ language: "go", code, compileOutput: out, kind: "compile" });
    expect(d[0]).toMatchObject({ line: 5 });
    expect(d[0].hint).toMatch(/unused variables/);
  });

  it("Kotlin K2 format", () => {
    const out = "warning: unable to find kotlin-stdlib.jar in the Kotlin home directory\ne: file:///app/Main.kt:3:13 Unresolved reference 'nmu'.\n";
    const code = "fun main() {\n    val num = 3\n    println(nmu)\n}\n";
    const d = analyze({ language: "kotlin", code, compileOutput: out, kind: "compile" });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ line: 3, column: 13 });
    expect(d[0].hint).toBe("`nmu` isn't defined. Did you mean `num`?");
  });

  it("PHP undefined variable", () => {
    const out = `PHP Warning:  Undefined variable $totl in ${P}solution.php on line 3\n`;
    const d = analyze({ language: "php", code: "<?php\n$total = 1;\necho $totl;\n", stderr: out, kind: "runtime" });
    expect(d[0]).toMatchObject({ line: 3 });
    expect(d[0].hint).toBe("`$totl` isn't defined. Did you mean `$total`?");
  });

  it("Ruby NameError", () => {
    const out = "main.rb:2:in '<main>': undefined local variable or method 'totl' for main (NameError)\n";
    const d = analyze({ language: "ruby", code: "total = 1\nputs totl\n", stderr: out, kind: "runtime" });
    expect(d[0]).toMatchObject({ line: 2 });
    expect(d[0].hint).toBe("`totl` isn't defined. Did you mean `total`?");
  });
});

describe("timeouts and fallbacks", () => {
  it("a timeout explains the usual causes", () => {
    const d = analyze({ language: "python", code: "while True: pass", kind: "timeout" });
    expect(d[0]).toMatchObject({ kind: "timeout", line: null, message: "Time limit exceeded" });
  });

  it("unrecognised output still shows its first line", () => {
    const d = analyze({ language: "cpp", code: "", compileOutput: "something odd happened\nmore", kind: "compile" });
    expect(d[0]).toMatchObject({ line: null, message: "something odd happened" });
  });

  it("caps at three diagnostics", () => {
    const out = [1, 2, 3, 4, 5].map((n) => `main.cpp:${n}:1: error: 'x${n}' was not declared in this scope`).join("\n");
    const code = "x1;\nx2;\nx3;\nx4;\nx5;\n";
    expect(analyze({ language: "cpp", code, compileOutput: out, kind: "compile" })).toHaveLength(3);
  });
});

describe("helpers", () => {
  it("didYouMean handles transpositions and ignores far names", () => {
    expect(didYouMean("reuslt", ["result", "res"])).toBe("result");
    expect(didYouMean("secnd", ["second", "largest"])).toBe("second");
    expect(didYouMean("abc", ["xyz"])).toBe(null);
  });

  it("findUnclosedBrace ignores braces in strings and comments", () => {
    const code = "int main() {\n    printf(\"{\");\n    // {\n    if (x) {\n        y();\n}\n";
    expect(findUnclosedBrace(code, "c")).toMatchObject({ line: 4 });
  });

  it("describeSignal", () => {
    expect(describeSignal(139)).toMatch(/^Segmentation fault \(exit code 139\): /);
    expect(describeSignal(1)).toBe("");
  });
});

describe("explainJudgeResult (Run and submission results)", () => {
  it("a Python syntax error reported as a runtime error on every test becomes one compile error", async () => {
    const { explainJudgeResult } = await import("./diagnostics.service.js");
    const err = `  File "${P}solution.py", line 2\n    print(x\n         ^\nSyntaxError: '(' was never closed\n`;
    const r = explainJudgeResult({ status: "Runtime Error", details: [{ errorType: "runtime", stderr: err }, { errorType: "runtime", stderr: err }] },
      { language: "python", code: "x = 1\nprint(x\n", trustLines: true });
    expect(r.status).toBe("Compilation Error");
    expect(r.details).toEqual([]);
    expect(r.stderr).not.toMatch(/sub-raw/);
    expect(r.diagnostics[0]).toMatchObject({ line: 2, kind: "compile" });
  });

  it("explains the first failing test", async () => {
    const { explainJudgeResult } = await import("./diagnostics.service.js");
    const r = explainJudgeResult({ status: "Runtime Error", details: [{ errorType: null, passed: true }, { errorType: "runtime", stderr: "Segmentation fault (core dumped)", exitCode: 139 }] },
      { language: "cpp", code: "int main(){}", trustLines: true });
    expect(r.diagnostics[0]).toMatchObject({ kind: "runtime", message: "Segmentation fault (exit code 139)" });
  });
});

describe("explainRawResult (GO Judge API)", () => {
  it("python syntax error is status 6 with the message in compile_output", async () => {
    const { explainRawResult } = await import("./codeAssessShim.service.js");
    const err = `  File "${P}solution.py", line 1\n    if x\n        ^\nSyntaxError: expected ':'\n`;
    const r = explainRawResult({ stdout: "", stderr: err, compile_output: "", status: { id: 11 }, exit_code: 1 }, { language: "python", code: "if x\n  pass\n" });
    expect(r.status).toEqual({ id: 6, description: "Compilation Error" });
    expect(r.stderr).toBe("");
    expect(r.compile_output).toMatch(/^ {2}File "main.py", line 1/);
    expect(r.diagnostics[0]).toMatchObject({ line: 1, kind: "compile" });
    expect(r.diagnostics[0].hint).toMatch(/Add a `:`/);
  });

  it("a crash that printed nothing gets an explanation in stderr", async () => {
    const { explainRawResult } = await import("./codeAssessShim.service.js");
    const r = explainRawResult({ stdout: "", stderr: "", compile_output: "", status: { id: 11 }, exit_code: 139 }, { language: "cpp", code: "int main(){}" });
    expect(r.stderr).toMatch(/^Segmentation fault \(exit code 139\)/);
    expect(r.status.description).toBe("Runtime Error (NZEC)");
    expect(r.diagnostics[0].message).toBe("Segmentation fault (exit code 139)");
  });

  it("an accepted run has no diagnostics and keeps its output", async () => {
    const { explainRawResult } = await import("./codeAssessShim.service.js");
    const r = explainRawResult({ stdout: "6\n", stderr: "", compile_output: "", status: { id: 3 }, exit_code: 0 }, { language: "python", code: "print(6)" });
    expect(r).toMatchObject({ stdout: "6\n", status: { id: 3, description: "Accepted" }, diagnostics: [] });
  });
});

describe("judge error prefix", () => {
  it("removes the judge's 'compilation failed: ... | stderr=' wrapping", () => {
    const raw = "compilation failed: runtime error: exit code 1 | compilation failed: runtime error: exit code 1 | stderr=/app/sub-run-1793762920127-72175090/Main.java:3: error: class Solution is public, should be declared in a file named Solution.java\npublic class Solution {\n       ^\n1 error";
    expect(stripWorkspacePaths(raw)).toMatch(/^Main\.java:3: error: class Solution is public/);
    const d = analyze({ language: "java", code: "import java.util.*;\n\npublic class Solution {\n}\n", compileOutput: raw, kind: "compile" });
    expect(d[0]).toMatchObject({ line: 3 });
  });
});

describe("message cleanup", () => {
  it("drops GCC's warning-flag name", () => {
    const d = analyze({ language: "c", code: "int main() {\n    pritnf(\"x\");\n}\n", compileOutput: "main.c:2:5: error: implicit declaration of function 'pritnf'; did you mean 'printf'? [-Wimplicit-function-declaration]\n    2 |     pritnf(\"x\");", kind: "compile" });
    expect(d[0].message).toBe("implicit declaration of function 'pritnf'; did you mean 'printf'?");
  });
});
