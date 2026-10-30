package languages

// Language describes how to compile/run code for a language and which wrapper template to use.
type Language struct {
	ID              string   // short id (key in the map)
	Name            string   // human friendly name
	FileExt         string   // file extension including leading dot (e.g. ".java")
	Image           string   // docker image name used to run/compile
	CompileCmd      []string // optional compile command (executed inside container)
	RunCmd          []string // command used to run the program/test harness
	WrapperTemplate string   // template file name (relative to wrapper/templates or configured path)
}

// Languages defines supported languages. The WrapperTemplate is assumed to be located
// in the wrapper package template directory (e.g. pkg/wrapper/templates/<name>).
var Languages = map[string]*Language{
	"javascript": {
		ID:              "javascript",
		Name:            "JavaScript",
		FileExt:         ".js",
		Image:           "judge-js-env",
		RunCmd:          []string{"node", "/app/wrapper.js"},
		WrapperTemplate: "js_wrapper.tpl",
	},
	"python": {
		ID:              "python",
		Name:            "Python",
		FileExt:         ".py",
		Image:           "judge-py-env",
		RunCmd:          []string{"python", "/app/wrapper.py"},
		WrapperTemplate: "python_wrapper.tpl",
	},
	"java": {
		ID:   "java",
		Name: "Java",
		// User submissions are written to Solution.java and wrapper to Main.java
		FileExt: ".java",
		Image:   "judge-java-env",
		// Compile both the user file (Solution.java) and the harness (Main.java)
		CompileCmd:      []string{"javac", "-J-XX:TieredStopAtLevel=1", "-J-XX:+UseSerialGC", "-J-Xshare:auto", "-J-XX:SharedArchiveFile=/opt/cds/javac.jsa", "-cp", "/usr/share/java/gson.jar:.", "/app/Solution.java", "/app/Main.java"}, // flags: see adapters/java.go
		RunCmd:          []string{"java", "-XX:MaxRAMPercentage=75", "-XX:+UseSerialGC", "-Xshare:auto", "-XX:SharedArchiveFile=/opt/cds/run.jsa", "-cp", "/usr/share/java/gson.jar:.", "Main"},
		WrapperTemplate: "java_single_wrapper.tpl",
	},
	"c": {
		ID:              "c",
		Name:            "C",
		FileExt:         ".c",
		Image:           "judge-c-env",
		CompileCmd:      []string{"gcc", "-O2", "-o", "/app/main", "/app/main.c", "-ljson-c", "-lm"},
		RunCmd:          []string{"/app/main"},
		WrapperTemplate: "c_wrapper.tpl",
	},
	"csharp": {
		ID:              "csharp",
		Name:            "C#",
		FileExt:         ".cs",
		Image:           "judge-csharp-env",
		CompileCmd:      []string{"sh", "-c", "cp /home/judge/app/app.csproj . && dotnet build -c Release -o out /p:StartupObject=Harness"},
		RunCmd:          []string{"dotnet", "out/app.dll"},
		WrapperTemplate: "csharp_wrapper.tpl",
	},
	"cpp": {
		ID:              "cpp",
		Name:            "C++",
		FileExt:         ".cpp",
		Image:           "judge-cpp-env",
		CompileCmd:      []string{"g++", "-O1", "-o", "/app/main", "/app/main.cpp"}, // function mode; see adapters/cpp.go
		RunCmd:          []string{"/app/main"},
		WrapperTemplate: "cpp_single_wrapper.tpl",
	},
	"go": {
		ID:      "go",
		Name:    "Go",
		FileExt: ".go",
		Image:   "judge-go-env",
		// With network disabled, an unconfigured `go build` can still try to reach the
		// module proxy/checksum db (or check for a toolchain switch) and hang for the
		// full sandbox timeout instead of failing fast — force everything local/offline
		// explicitly instead of relying on image env (see main.go's rawRunFilesAndCommands,
		// where this was first found and fixed for the raw-run path).
		CompileCmd:      []string{"sh", "-c", "export GOFLAGS=-mod=mod GOPROXY=off GOSUMDB=off GO111MODULE=on GOTOOLCHAIN=local; go mod init solution 2>/dev/null || true; go build -o main ."},
		RunCmd:          []string{"./main"},
		WrapperTemplate: "go_wrapper.tpl",
	},
	"typescript": {
		ID:              "typescript",
		Name:            "TypeScript",
		FileExt:         ".ts",
		Image:           "judge-js-env",
		RunCmd:          []string{"tsx", "/app/wrapper.ts"},
		WrapperTemplate: "ts_wrapper.tpl",
	},
	"rust": {
		ID:              "rust",
		Name:            "Rust",
		FileExt:         ".rs",
		Image:           "judge-rust-env",
		CompileCmd:      []string{"rustc", "--edition", "2021", "-O", "-o", "/app/main", "/app/main.rs"},
		RunCmd:          []string{"/app/main"},
		WrapperTemplate: "rust_wrapper.tpl",
	},
	"ruby": {
		ID:              "ruby",
		Name:            "Ruby",
		FileExt:         ".rb",
		Image:           "judge-ruby-env",
		RunCmd:          []string{"ruby", "/app/wrapper.rb"},
		WrapperTemplate: "ruby_single_wrapper.tpl",
	},
	"php": {
		ID:              "php",
		Name:            "PHP",
		FileExt:         ".php",
		Image:           "judge-php-env",
		RunCmd:          []string{"php", "/app/wrapper.php"},
		WrapperTemplate: "php_wrapper.tpl",
	},
	"kotlin": {
		ID:   "kotlin",
		Name: "Kotlin",
		// User submissions are written to Solution.kt and wrapper to Harness.kt
		FileExt:         ".kt",
		Image:           "judge-kotlin-env",
		CompileCmd:      []string{"kotlinc", "-cp", "/usr/share/java/gson.jar", "-d", "/app/out", "/app/Solution.kt", "/app/Harness.kt"},
		RunCmd:          []string{"java", "-XX:MaxRAMPercentage=75", "-cp", "/app/out:/opt/kotlinc/lib/kotlin-stdlib.jar:/usr/share/java/gson.jar", "HarnessKt"},
		WrapperTemplate: "kotlin_wrapper.tpl",
	},
}

// GetLanguage returns a pointer to the Language configuration for the given id.
// It returns nil if the language is not found.
func GetLanguage(id string) *Language {
	if l, ok := Languages[id]; ok {
		return l
	}
	return nil
}

// GetSupportedLanguages returns a slice of all supported languages.
func GetSupportedLanguages() []*Language {
	supported := make([]*Language, 0, len(Languages))
	for _, lang := range Languages {
		supported = append(supported, lang)
	}
	return supported
}
