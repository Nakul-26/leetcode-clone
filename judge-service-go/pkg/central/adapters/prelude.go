package adapters

import (
	"regexp"
	"sort"
	"strings"
)

// Prelude adds the standard-library includes and imports a stdin program uses but forgot
// (docs/EDITOR_UX_PLAN.md A1). Students shouldn't have to remember that strlen needs
// <string.h> or that Scanner needs java.util: a forgotten header is the most common compile
// error on the exam portal, and since GCC 14 an implicit declaration in C is an error rather
// than a warning.
//
// Only what the code uses and doesn't define itself is added. Blanket preludes break real
// submissions: <bits/stdc++.h> plus `using namespace std` makes a global named count or rank
// ambiguous, and <string.h> conflicts with a student's own strlen (a common exam question).
//
// Line numbers never move, so compiler errors still point at the student's lines:
//   - C/C++: the includes go in a separate prelude.h that the compiler force-includes
//     (-include), so main.c is compiled exactly as written. (A `#line 1` directive would also
//     keep the numbers, but GCC then prints the wrong source text under each error.) The flag
//     is only passed when prelude.h is non-empty: a forced include, even an empty one, stops
//     <bits/stdc++.h> from using its precompiled header.
//   - Java/C#: the imports are joined onto the student's first line.
//
// Java additionally accepts any public class with a main method: `public class Solution`
// is the habit most students bring, and Main.java can only hold a public class named Main.

type headerRule struct {
	header string
	names  []string
}

// A name ending in "(" must be called, one ending in "<" must be a template; a name starting
// with "." must be a method call. That keeps common variable names (count, find, set, function)
// from pulling in a header the code doesn't use.
var cHeaderRules = []headerRule{
	{"stdio.h", []string{"printf(", "scanf(", "puts(", "gets(", "fgets(", "getchar(", "putchar(", "sprintf(", "sscanf(", "fprintf(", "fflush(", "stdin", "stdout", "EOF"}},
	{"stdlib.h", []string{"malloc(", "calloc(", "realloc(", "free(", "abs(", "labs(", "llabs(", "qsort(", "atoi(", "atol(", "atoll(", "atof(", "exit(", "rand(", "srand(", "strtol(", "strtoll("}},
	{"string.h", []string{"strlen(", "strcpy(", "strncpy(", "strcmp(", "strncmp(", "strcat(", "strncat(", "strchr(", "strrchr(", "strstr(", "strtok(", "memset(", "memcpy(", "memmove(", "memcmp(", "strdup("}},
	{"ctype.h", []string{"tolower(", "toupper(", "isdigit(", "isalpha(", "isalnum(", "isspace(", "isupper(", "islower(", "ispunct("}},
	{"math.h", []string{"sqrt(", "pow(", "fabs(", "floor(", "ceil(", "round(", "log(", "log2(", "log10(", "exp(", "sin(", "cos(", "tan(", "fmax(", "fmin(", "fmod(", "hypot("}},
	{"limits.h", []string{"INT_MAX", "INT_MIN", "LONG_MAX", "LONG_MIN", "LLONG_MAX", "LLONG_MIN", "UINT_MAX", "CHAR_MAX"}},
	{"stdint.h", []string{"int64_t", "uint64_t", "int32_t", "uint32_t", "INT64_MAX"}},
	{"stdbool.h", []string{"bool", "true", "false"}},
}

var cppHeaderRules = []headerRule{
	{"iostream", []string{"cout", "cin", "cerr", "endl"}},
	{"vector", []string{"vector<"}},
	{"string", []string{"string", "getline(", "to_string(", "stoi(", "stol(", "stoll(", "stod("}},
	{"map", []string{"map<", "multimap<"}},
	{"set", []string{"set<", "multiset<"}},
	{"unordered_map", []string{"unordered_map<"}},
	{"unordered_set", []string{"unordered_set<"}},
	{"stack", []string{"stack<"}},
	{"queue", []string{"queue<", "priority_queue<"}},
	{"deque", []string{"deque<"}},
	{"algorithm", []string{"sort(", "stable_sort(", "reverse(", "max_element(", "min_element(", "unique(", "lower_bound(", "upper_bound(", "binary_search(", "next_permutation(", "prev_permutation(", "fill(", "find(", "count(", "count_if(", "find_if(", "remove_if(", "all_of(", "any_of(", "none_of(", "transform(", "rotate(", "min(", "max(", "swap("}},
	{"functional", []string{"greater<", "less<", "function<"}},
	{"numeric", []string{"accumulate(", "iota(", "gcd(", "lcm(", "partial_sum("}},
	{"cmath", []string{"sqrt(", "pow(", "fabs(", "floor(", "ceil(", "round(", "log(", "log2(", "log10(", "exp(", "hypot("}},
	{"climits", []string{"INT_MAX", "INT_MIN", "LONG_MAX", "LONG_MIN", "LLONG_MAX", "LLONG_MIN", "UINT_MAX"}},
	{"cstring", []string{"memset(", "memcpy(", "strlen(", "strcpy(", "strcmp(", "strcat("}},
	{"sstream", []string{"stringstream", "istringstream", "ostringstream"}},
	{"iomanip", []string{"setprecision(", "setw(", "setfill("}},
	{"utility", []string{"pair<", "make_pair("}},
	{"tuple", []string{"tuple<", "make_tuple("}},
	{"bitset", []string{"bitset<"}},
	{"cstdint", []string{"int64_t", "uint64_t", "int32_t", "uint32_t"}},
}

var javaImportRules = []headerRule{
	{"java.util.*", []string{"Scanner", "ArrayList", "List", "LinkedList", "HashMap", "TreeMap", "LinkedHashMap", "Map", "HashSet", "TreeSet", "LinkedHashSet", "Set", "Arrays", "Collections", "Stack", "Queue", "Deque", "ArrayDeque", "PriorityQueue", "Iterator", "StringTokenizer", "Comparator", "Random", "Optional"}},
	{"java.io.*", []string{"BufferedReader", "InputStreamReader", "IOException", "PrintWriter", "BufferedWriter", "OutputStreamWriter", "StreamTokenizer"}},
	{"java.math.*", []string{"BigInteger", "BigDecimal"}},
}

var csharpUsingRules = []headerRule{
	{"System", []string{"Console", "Math", "Convert", "Int32", "Int64", "StringSplitOptions"}},
	{"System.Collections.Generic", []string{"List<", "Dictionary<", "HashSet<", "Queue<", "Stack<", "SortedDictionary<", "SortedSet<", "KeyValuePair<", "LinkedList<"}},
	{"System.Linq", []string{".Select(", ".Where(", ".OrderBy(", ".OrderByDescending(", ".Sum(", ".Max(", ".Min(", ".ToList(", ".ToArray(", ".Distinct(", ".Count(", ".Any(", ".All(", ".First(", ".Average("}},
	{"System.Text", []string{"StringBuilder"}},
}

var (
	blockComment  = regexp.MustCompile(`(?s)/\*.*?\*/`)
	lineComment   = regexp.MustCompile(`//[^\n]*`)
	stringLiteral = regexp.MustCompile(`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`)
)

// codeOnly blanks comments and string/char literals so a name inside them isn't counted as used.
func codeOnly(code string) string {
	code = blockComment.ReplaceAllStringFunc(code, func(s string) string { return strings.Repeat("\n", strings.Count(s, "\n")) })
	code = lineComment.ReplaceAllString(code, "")
	return stringLiteral.ReplaceAllString(code, `""`)
}

// usesName reports whether code uses name (see the rule syntax above) as an identifier, not as
// part of a longer one and, unless it is a ".method(", not as a member (v.count, obj->size).
func usesName(code, name string) bool {
	if strings.HasPrefix(name, ".") {
		return regexp.MustCompile(`\.` + regexp.QuoteMeta(strings.TrimSuffix(name[1:], "(")) + `\s*\(`).MatchString(code)
	}
	suffix := `\b`
	switch {
	case strings.HasSuffix(name, "("):
		suffix, name = `\s*\(`, strings.TrimSuffix(name, "(")
	case strings.HasSuffix(name, "<"):
		suffix, name = `\s*<`, strings.TrimSuffix(name, "<")
	}
	return regexp.MustCompile(`(^|[^\w.>$])` + regexp.QuoteMeta(name) + suffix).MatchString(code)
}

func bareName(name string) string {
	return strings.TrimSuffix(strings.TrimSuffix(strings.TrimPrefix(name, "."), "("), "<")
}

// definesName reports whether the student defines name themselves: a function, a type, a
// variable or a macro of that name. Then the library's version must not be pulled in.
func definesName(code, name string) bool {
	q := regexp.QuoteMeta(name)
	patterns := []string{
		// int strlen(char *s) {   size_t my(...)   static bool isdigit(char c)
		`(?m)^[ \t]*(?:static\s+|inline\s+|const\s+|unsigned\s+|signed\s+|long\s+|short\s+|struct\s+)*[A-Za-z_][\w:<>]*[\s*&]+` + q + `\s*\(`,
		`(?m)#\s*define\s+` + q + `\b`,
		`\b(?:struct|class|typedef|enum|union)\s+(?:[\w\s*]*\s)?` + q + `\b`,
		// a variable or parameter: int count = 0;  int n, count;  long long rank[100];  f(int count)
		`(?m)\b(?:int|long|short|char|float|double|bool|auto|unsigned|size_t|string)\b[^;(){}]*\b` + q + `\s*(?:=|;|\[|,|\))`,
	}
	for _, p := range patterns {
		if regexp.MustCompile(p).MatchString(code) {
			return true
		}
	}
	return false
}

func missingHeaders(code string, rules []headerRule, alreadyIncluded func(header string) bool) []string {
	plain := codeOnly(code)
	var add []string
	for _, rule := range rules {
		if alreadyIncluded(rule.header) {
			continue
		}
		for _, name := range rule.names {
			if usesName(plain, name) && !definesName(plain, bareName(name)) {
				add = append(add, rule.header)
				break
			}
		}
	}
	return add
}

var includeLine = regexp.MustCompile(`(?m)^\s*#\s*include\s*[<"]([^>"]+)[>"]`)

func includedHeaders(code string) map[string]bool {
	got := map[string]bool{}
	for _, m := range includeLine.FindAllStringSubmatch(code, -1) {
		got[strings.TrimSpace(m[1])] = true
	}
	return got
}

func cPrelude(code string) string {
	included := includedHeaders(code)
	return includeLines(missingHeaders(code, cHeaderRules, func(h string) bool { return included[h] }))
}

func cppPrelude(code string) string {
	included := includedHeaders(code)
	if included["bits/stdc++.h"] {
		return ""
	}
	return includeLines(missingHeaders(code, cppHeaderRules, func(h string) bool { return included[h] }))
}

func includeLines(headers []string) string {
	var b strings.Builder
	for _, h := range headers {
		b.WriteString("#include <" + h + ">\n")
	}
	return b.String()
}

var (
	javaPackage    = regexp.MustCompile(`(?m)^\s*package\s+[\w.]+\s*;`)
	javaPublicMain = regexp.MustCompile(`\bpublic\s+((?:final\s+|abstract\s+)?)class\s+([A-Za-z_]\w*)`)
	javaHasMainCls = regexp.MustCompile(`\bclass\s+Main\b`)
	javaMainMethod = regexp.MustCompile(`\bstatic\s+void\s+main\s*\(`)
)

// Only a wildcard import covers the whole package: `import java.util.Scanner;` doesn't make
// ArrayList available, and adding java.util.* next to it is legal.
func javaImported(code, pkg string) bool {
	return regexp.MustCompile(`(?m)^\s*import\s+` + regexp.QuoteMeta(pkg) + `\s*;`).MatchString(code)
}

func javaPrelude(code string) string {
	if javaPackage.MatchString(code) {
		return code
	}
	// Any public class with main: compile it as a package-private class and run it through a
	// small Main, appended after the student's code so their line numbers don't move.
	if !javaHasMainCls.MatchString(code) && javaMainMethod.MatchString(code) {
		if m := javaPublicMain.FindStringSubmatchIndex(code); m != nil {
			name := code[m[4]:m[5]]
			code = code[:m[0]] + code[m[2]:m[3]] + "class " + name + code[m[1]:] +
				"\nclass Main { public static void main(String[] args) throws Exception { " + name + ".main(args); } }\n"
		}
	}
	add := missingHeaders(code, javaImportRules, func(pkg string) bool { return javaImported(code, pkg) })
	if len(add) == 0 {
		return code
	}
	var b strings.Builder
	for _, pkg := range add {
		b.WriteString("import " + pkg + "; ")
	}
	return b.String() + code
}

var csharpLeadingDirective = regexp.MustCompile(`^\s*#`)

func csharpPrelude(code string) string {
	// A preprocessor directive must start its own line, so nothing can be joined onto it.
	if csharpLeadingDirective.MatchString(code) {
		return code
	}
	used := regexp.MustCompile(`(?m)^\s*using\s+([\w.]+)\s*;`).FindAllStringSubmatch(code, -1)
	have := map[string]bool{}
	for _, u := range used {
		have[u[1]] = true
	}
	add := missingHeaders(code, csharpUsingRules, func(ns string) bool { return have[ns] })
	if len(add) == 0 {
		return code
	}
	sort.Strings(add)
	var b strings.Builder
	for _, ns := range add {
		b.WriteString("using " + ns + "; ")
	}
	return b.String() + code
}

// PreludeHeaderFile is the force-included header for C and C++ (see the top of this file).
const PreludeHeaderFile = "prelude.h"

// WithPrelude returns the source to compile for a stdin program, and for C and C++ the
// contents of prelude.h ("" when nothing is missing). The source is the student's code
// unchanged unless a Java or C# import it needs is missing.
func WithPrelude(language, code string) (source string, header string) {
	switch language {
	case "c":
		return code, cPrelude(code)
	case "cpp":
		return code, cppPrelude(code)
	case "java":
		return javaPrelude(code), ""
	case "csharp":
		return csharpPrelude(code), ""
	}
	return code, ""
}

// forceIncludeIfNeeded is the shell fragment that adds `-include prelude.h` only when the
// file is non-empty.
const forceIncludeIfNeeded = `$(test -s ` + PreludeHeaderFile + ` && echo "-include ` + PreludeHeaderFile + `")`
