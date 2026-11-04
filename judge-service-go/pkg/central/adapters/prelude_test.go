package adapters

import (
	"strings"
	"testing"
)

// Lines of student code before line 1 of their own source, as the compiler will number them.
func linesBefore(t *testing.T, out, code string) int {
	t.Helper()
	i := strings.Index(out, code)
	if i < 0 {
		t.Fatalf("student code not found unchanged in:\n%s", out)
	}
	return strings.Count(out[:i], "\n")
}

func TestCPreludeAddsWhatIsUsed(t *testing.T) {
	code := "#include <stdio.h>\nint main() {\n    char s[100];\n    fgets(s, sizeof s, stdin);\n    printf(\"%zu %c\\n\", strlen(s), toupper(s[0]));\n}\n"
	src, header := WithPrelude("c", code)
	if src != code {
		t.Errorf("C source must be compiled exactly as written")
	}
	// stdio.h is already included, so only the two missing headers.
	if header != "#include <string.h>\n#include <ctype.h>\n" {
		t.Errorf("header = %q", header)
	}
}

func TestCPreludeLeavesTheStudentsOwnFunctionAlone(t *testing.T) {
	// "Write your own strlen" is a common exam question; <string.h> would make it a conflicting declaration.
	code := "#include <stdio.h>\nint strlen(char *s) {\n    int n = 0;\n    while (s[n]) n++;\n    return n;\n}\nint main() { printf(\"%d\\n\", strlen(\"abc\")); }\n"
	if src, header := WithPrelude("c", code); src != code || header != "" {
		t.Errorf("nothing must be added, got header %q", header)
	}
}

func TestCPreludeIgnoresNamesInStringsAndComments(t *testing.T) {
	code := "#include <stdio.h>\n// strlen( is not used here\nint main() { printf(\"sqrt(4)\\n\"); }\n"
	if src, header := WithPrelude("c", code); src != code || header != "" {
		t.Errorf("nothing must be added, got header %q", header)
	}
}

func TestCppPreludeAddsContainersAndAlgorithms(t *testing.T) {
	code := "#include <iostream>\nusing namespace std;\nint main() {\n    int n; cin >> n;\n    vector<int> a(n);\n    for (auto &x : a) cin >> x;\n    sort(a.begin(), a.end(), greater<int>());\n    cout << a[0] << endl;\n}\n"
	src, header := WithPrelude("cpp", code)
	// iostream is already included, so only what's missing.
	if src != code || header != "#include <vector>\n#include <algorithm>\n#include <functional>\n" {
		t.Errorf("header = %q", header)
	}
}

func TestCppPreludeKeepsBitsStdcAndOwnNames(t *testing.T) {
	bits := "#include <bits/stdc++.h>\nusing namespace std;\nint main() { vector<int> v; sort(v.begin(), v.end()); }\n"
	if _, out := WithPrelude("cpp", bits); out != "" {
		t.Errorf("bits/stdc++.h covers everything; got:\n%s", out)
	}
	// A variable named count is not std::count; pulling in <algorithm> could make it ambiguous.
	own := "#include <iostream>\nusing namespace std;\nint count = 0;\nint main() { count++; cout << count; }\n"
	if _, out := WithPrelude("cpp", own); out != "" {
		t.Errorf("a variable named count must not add <algorithm>; got:\n%s", out)
	}
	member := "#include <iostream>\n#include <set>\nusing namespace std;\nint main() { set<int> s; cout << s.count(1); }\n"
	if _, out := WithPrelude("cpp", member); out != "" {
		t.Errorf("s.count( is a member call, not std::count; got:\n%s", out)
	}
}

func TestJavaPreludeJoinsImportsOntoLineOne(t *testing.T) {
	code := "public class Main {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        List<Integer> a = new ArrayList<>();\n        System.out.println(new BigInteger(\"1\"));\n    }\n}\n"
	out := javaSource(code)
	if !strings.HasPrefix(out, "import java.util.*; import java.math.*; public class Main {") {
		t.Errorf("imports must be joined onto line 1, got:\n%s", out)
	}
	if strings.Count(out, "\n") != strings.Count(code, "\n") {
		t.Errorf("line count changed")
	}
}

func TestJavaPreludeSpecificImportDoesNotCoverThePackage(t *testing.T) {
	code := "import java.util.Scanner;\npublic class Main {\n    public static void main(String[] a) {\n        ArrayList<Integer> x = new ArrayList<>();\n    }\n}\n"
	if out := javaSource(code); !strings.HasPrefix(out, "import java.util.*; import java.util.Scanner;") {
		t.Errorf("got:\n%s", out)
	}
}

func TestJavaPreludeRunsAnyPublicClassWithMain(t *testing.T) {
	code := "import java.util.*;\n\npublic class Solution {\n    public static void main(String[] args) {\n        System.out.println(6);\n    }\n}\n"
	out := javaSource(code)
	if !strings.Contains(out, "\nclass Solution {\n") || strings.Contains(out, "public class Solution") {
		t.Errorf("Solution must become package-private, got:\n%s", out)
	}
	if !strings.HasSuffix(out, "class Main { public static void main(String[] args) throws Exception { Solution.main(args); } }\n") {
		t.Errorf("a Main that calls Solution.main must be appended, got:\n%s", out)
	}
	if linesBefore(t, out, "class Solution {") != linesBefore(t, code, "public class Solution {") {
		t.Errorf("the class must stay on the same line")
	}
}

func TestJavaPreludeLeavesMainAndPackagesAlone(t *testing.T) {
	main := "import java.util.*;\npublic class Main {\n    public static void main(String[] a) { new Scanner(System.in); }\n}\n"
	if out := javaSource(main); out != main {
		t.Errorf("got:\n%s", out)
	}
	pkg := "package app;\npublic class Solution { public static void main(String[] a) { new Scanner(System.in); } }\n"
	if out := javaSource(pkg); out != pkg {
		t.Errorf("imports can't go before a package line; got:\n%s", out)
	}
}

func TestCsharpPreludeAddsUsings(t *testing.T) {
	code := "class Program {\n    static void Main() {\n        var xs = new List<int> { 3, 1 };\n        Console.WriteLine(xs.Max());\n    }\n}\n"
	out := csharpSource(code)
	if !strings.HasPrefix(out, "using System; using System.Collections.Generic; using System.Linq; class Program {") {
		t.Errorf("got:\n%s", out)
	}
	directive := "#nullable enable\nclass P { static void Main() { Console.WriteLine(1); } }\n"
	if out := csharpSource(directive); out != directive {
		t.Errorf("nothing can be joined onto a preprocessor line; got:\n%s", out)
	}
}

func TestPreludeOnlyForCompiledLanguagesItKnows(t *testing.T) {
	for _, lang := range []string{"python", "javascript", "go", "kotlin", "rust"} {
		code := "print(sqrt(4))\n"
		if src, header := WithPrelude(lang, code); src != code || header != "" {
			t.Errorf("%s: code must be unchanged", lang)
		}
	}
}

func javaSource(code string) string   { src, _ := WithPrelude("java", code); return src }
func csharpSource(code string) string { src, _ := WithPrelude("csharp", code); return src }
