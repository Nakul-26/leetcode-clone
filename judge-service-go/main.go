package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"

	"github.com/redis/go-redis/v9"

	"judge-service-go/pkg/central/adapters"
	"judge-service-go/pkg/executor"
	"judge-service-go/pkg/languages"
	"judge-service-go/pkg/metrics"
	"judge-service-go/pkg/models"
	"judge-service-go/pkg/pool"
	"judge-service-go/pkg/workspace"
	"judge-service-go/pkg/wrapper"

	docker "github.com/fsouza/go-dockerclient"
)

const (
	defaultRabbitMQURL      = "amqp://user:password@rabbitmq:5672"
	defaultSubmissionQueue  = "submission_queue"
	defaultMongoURI         = "mongodb://mongo:27017/assessment_db"
	defaultMongoDBName      = "assessment_db"
	defaultRedisURI         = "redis://redis:6379"
	defaultSandboxTimeout   = 10 * time.Second
	centralComparePythonEnv = "JUDGE_CENTRAL_COMPARE_PY"
	centralCompareJSEnv     = "JUDGE_CENTRAL_COMPARE_JS"
	centralCompareJavaEnv   = "JUDGE_CENTRAL_COMPARE_JAVA"
	centralCompareCppEnv    = "JUDGE_CENTRAL_COMPARE_CPP"
	centralCompareCEnv      = "JUDGE_CENTRAL_COMPARE_C"
	maxTestOutputBytes      = 64 * 1024
	maxLogOutputBytes       = 4 * 1024
	maxTestsBytes           = 1 << 20 // 1MB
	defaultPoolSizePerLang  = 2

	// Per-language container pool autoscaling (see pkg/pool.StartAutoscaler). All of these
	// have env var overrides parsed in main(); see docker-compose.prod.yml's header comment
	// for the operator-facing summary.
	defaultPoolGlobalCap          = 60
	defaultWorkerConcurrency      = 24
	defaultInteractiveWorkers     = 4
	defaultAutoscaleInterval      = 15 * time.Second
	defaultScaleUpThresholdMs     = 150.0
	defaultScaleDownThresholdMs   = 20.0
	defaultScaleUpCooldown        = 20 * time.Second
	defaultScaleDownCooldown      = 180 * time.Second
)

// langPoolAbbrev maps each supported language ID to the abbreviation used in its
// JUDGE_POOL_MIN_<ABBR>/JUDGE_POOL_MAX_<ABBR> env vars — matches the abbreviation convention
// already established by JUDGE_CENTRAL_COMPARE_*/JUDGE_BATCH_THRESHOLD_* (PY, JS, JAVA, CPP, C)
// and extends it to the remaining 7 languages that had no precedent yet.
var langPoolAbbrev = map[string]string{
	"python":     "PY",
	"javascript": "JS",
	"typescript": "TS",
	"java":       "JAVA",
	"c":          "C",
	"cpp":        "CPP",
	"csharp":     "CS",
	"go":         "GO",
	"rust":       "RS",
	"ruby":       "RB",
	"php":        "PHP",
	"kotlin":     "KT",
}

// langPoolMaxDefault is each language's default pool Max when JUDGE_POOL_MAX_<ABBR> is unset.
// Only takes effect once JUDGE_POOL_AUTOSCALE_ENABLED is on — Min alone governs behavior
// otherwise, so this doesn't change today's default (min=max=DEFAULT_POOL_SIZE) behavior.
// Grouped by toolchain weight, based on this session's live load test at pool=2/3/4:
//   - java/cpp: measured directly, benefited most from extra containers (heavy multi-stage
//     compile + JVM/native runtime). csharp/kotlin grouped with them (same JVM/heavy-toolchain
//     profile — dotnet build / kotlinc are comparably slow).
//   - python: measured directly; its relative gain (pool2->4) was larger than expected for an
//     interpreted language, so it gets the same headroom as the compiled bucket rather than a
//     conservative one, pending Phase 2's real wait-time data.
//   - javascript/typescript/ruby/php: interpreted, unmeasured beyond javascript (whose gain was
//     smaller than python's) — conservative default.
//   - c/go/rust: unmeasured. Go/Rust compilers are typically much faster/single-pass than
//     javac's or g++'s multi-stage builds, so grouped with the conservative bucket rather than
//     assumed to belong with java/cpp.
var langPoolMaxDefault = map[string]int{
	"java":       8,
	"cpp":        8,
	"csharp":     8,
	"kotlin":     8,
	"python":     8,
	"javascript": 6,
	"typescript": 6,
	"ruby":       6,
	"php":        6,
	"c":          6,
	"go":         6,
	"rust":       6,
}

// poolLangConfig is one language's resolved [Min, Max] pool bounds.
type poolLangConfig struct {
	Min int
	Max int
}

// resolvePoolConfig computes one language's pool Min/Max from env vars, falling back to
// defaultPoolSize (the existing single JUDGE_POOL_SIZE value) for Min, and to
// langPoolMaxDefault for Max, so that with zero new env vars set, Min == Max ==
// defaultPoolSize everywhere — byte-for-byte identical behavior to before this change.
func resolvePoolConfig(langID string, defaultPoolSize int) poolLangConfig {
	abbr := langPoolAbbrev[langID]

	min := defaultPoolSize
	if abbr != "" {
		if raw := strings.TrimSpace(os.Getenv("JUDGE_POOL_MIN_" + abbr)); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				min = parsed
			}
		}
	}

	max := defaultPoolSize
	if bucketDefault, ok := langPoolMaxDefault[langID]; ok {
		max = bucketDefault
	}
	if abbr != "" {
		if raw := strings.TrimSpace(os.Getenv("JUDGE_POOL_MAX_" + abbr)); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				max = parsed
			}
		}
	}

	// Guarantee the invariant WarmUp/the autoscaler rely on: Max is never below Min, even if
	// an operator's env vars would otherwise produce that (e.g. a high JUDGE_POOL_SIZE with an
	// unadjusted bucket-default Max).
	if max < min {
		max = min
	}

	return poolLangConfig{Min: min, Max: max}
}

// getIntEnv reads an env var as a positive int, falling back to def if unset/invalid.
func getIntEnv(name string, def int) int {
	if raw := strings.TrimSpace(os.Getenv(name)); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			return parsed
		}
	}
	return def
}

// getFloatEnv reads an env var as a positive float64, falling back to def if unset/invalid.
func getFloatEnv(name string, def float64) float64 {
	if raw := strings.TrimSpace(os.Getenv(name)); raw != "" {
		if parsed, err := strconv.ParseFloat(raw, 64); err == nil && parsed > 0 {
			return parsed
		}
	}
	return def
}

// getDurationSecondsEnv reads an env var as a positive whole-second duration, falling back to
// def if unset/invalid.
func getDurationSecondsEnv(name string, def time.Duration) time.Duration {
	if raw := strings.TrimSpace(os.Getenv(name)); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			return time.Duration(parsed) * time.Second
		}
	}
	return def
}

// MaxExecutionsPerContainer controls how many times a pooled container may be
// used before being evicted. Can be changed at startup from env.
// It is a safety net now, not cleanup: containers are reset after every submission
// (finishWithContainer). Recycling also replaces anything a reset cannot undo.
// bulkContainerReserve is how many idle containers per language bulk work leaves untouched
// for interactive callers. Set from JUDGE_INTERACTIVE_RESERVE at startup.
var bulkContainerReserve = 1

var MaxExecutionsPerContainer int32 = 500

// consumersHealthy is true while the judge is consuming from RabbitMQ. /health reports it.
var consumersHealthy atomic.Bool

// shuttingDown is set once a shutdown signal arrives. Cancelling a consumer still hands its
// workers every message already prefetched for it (up to the QoS prefetch count), so without
// this a shutdown would keep judging that whole backlog and outlast the stop grace period.
var shuttingDown atomic.Bool

// returnIfShuttingDown puts a message that has not been started back on its queue during
// shutdown, for another judge (or this one, restarted) to take. It reports whether it did.
func returnIfShuttingDown(d amqp.Delivery) bool {
	if !shuttingDown.Load() {
		return false
	}
	d.Nack(false, true)
	return true
}

// Consumer tags, named so that shutdown can cancel each consumer: Cancel matches by tag, and
// cancelling "" (what an auto-generated tag left us with) matches nothing.
const (
	bulkConsumerTag        = "judge-bulk"
	interactiveConsumerTag = "judge-interactive"
)

func failOnError(err error, msg string) {
	if err != nil {
		slog.Error(msg, "error", err)
		os.Exit(1)
	}
}

func isTruthyEnv(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

type singleTestExecOutput struct {
	Output    interface{} `json:"output"`
	Error     string      `json:"error,omitempty"`
	Traceback string      `json:"traceback,omitempty"`
}

func truncateString(s string, maxBytes int) (string, bool) {
	if maxBytes <= 0 || len(s) <= maxBytes {
		return s, false
	}
	return s[:maxBytes], true
}

func parseSingleTestOutput(stdout string, stderr string) (singleTestExecOutput, string, error) {
	var out singleTestExecOutput

	// Judge result is now in stderr
	trimmedStderr := strings.TrimSpace(stderr)
	if trimmedStderr == "" {
		// If stderr is empty, maybe there's a runtime error that went to stdout?
		// But ideally judge metadata is always in stderr.
		return out, strings.TrimSpace(stdout), fmt.Errorf("missing judge metadata in stderr")
	}

	// Try to find the last JSON object in stderr (in case there are multiple lines or non-JSON noise)
	lines := strings.Split(trimmedStderr, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "{") && strings.HasSuffix(line, "}") {
			if err := json.Unmarshal([]byte(line), &out); err == nil {
				// Found the JSON result.
				// Any other noise in stderr could be user error output, we might want to include it?
				// For now, let's keep it simple: stdout is user logs, stderr is judge result.
				return out, strings.TrimSpace(stdout), nil
			}
		}
	}

	return out, strings.TrimSpace(stdout), fmt.Errorf("failed to parse judge metadata from stderr: %s", stderr)
}

func perTestTimeout(problem models.Problem) time.Duration {
	if problem.TimeLimitMs > 0 {
		return time.Duration(problem.TimeLimitMs) * time.Millisecond
	}
	return defaultSandboxTimeout
}

// validateAndDecodeSubmission unmarshals and validates the submission message.
func validateAndDecodeSubmission(d amqp.Delivery) (models.SubmissionMessage, error) {
	var msg models.SubmissionMessage
	if err := json.Unmarshal(d.Body, &msg); err != nil {
		return msg, fmt.Errorf("error unmarshalling submission message: %w", err)
	}

	// Log ASAP, but validation will catch missing ID.
	reqId := msg.RequestID
	if reqId == "" {
		reqId = "none"
	}
	slog.Info("Received a message", "submissionId", msg.SubmissionID, "reqId", reqId)

	if err := msg.Validate(); err != nil {
		return msg, fmt.Errorf("invalid submission message: %w", err)
	}

	sanitizedName, ok := msg.SanitizeFunctionName()
	if !ok {
		slog.Debug("sanitized function name", "submissionId", msg.SubmissionID, "old", msg.FunctionName, "new", sanitizedName)
		msg.FunctionName = sanitizedName
	}

	return msg, nil
}

// errProblemNotFound marks a fetchProblemData failure that retrying cannot fix: the id is
// malformed or no such problem exists (for example it was deleted after the submission).
var errProblemNotFound = errors.New("problem not found")

// fetchProblemData retrieves the problem details from MongoDB. A failure wrapping
// errProblemNotFound is permanent; any other error is a database problem worth retrying.
func fetchProblemData(ctx context.Context, problemsCollection *mongo.Collection, problemID string) (models.Problem, error) {
	var problem models.Problem
	objID, err := primitive.ObjectIDFromHex(problemID)
	if err != nil {
		return problem, fmt.Errorf("%w: invalid ProblemID %q: %v", errProblemNotFound, problemID, err)
	}

	err = problemsCollection.FindOne(ctx, bson.M{"_id": objID}).Decode(&problem)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return problem, fmt.Errorf("%w: %s", errProblemNotFound, problemID)
	}
	if err != nil {
		return problem, fmt.Errorf("error fetching problem %s: %w", problemID, err)
	}
	return problem, nil
}

// Ceilings for caller-supplied limits on ad-hoc submissions, matching /raw-run.
const (
	maxAdHocTimeLimitMs   = 60000
	maxAdHocMemoryLimitMb = 2048
)

// adHocProblem builds the in-memory Problem for a submission that carries its own
// test cases instead of referencing a stored one (SubmissionMessage.Kind ==
// SubmissionKindAdHoc). Always stdin-mode — Validate enforces that — so there is no
// function signature, wrapper or comparison config to reconstruct.
//
// Title and Description exist only to satisfy Problem.ValidateBasic; nothing renders
// them, because an ad-hoc submission has no problem page to render them on.
func adHocProblem(submissionMsg models.SubmissionMessage) models.Problem {
	// The limits come from an external caller, so they are clamped here rather than trusted.
	// /raw-run has always done the same; without it a caller could ask for an hour and hold a
	// container for the whole of the submission budget.
	timeLimitMs := submissionMsg.TimeLimitMs
	if timeLimitMs > maxAdHocTimeLimitMs {
		timeLimitMs = maxAdHocTimeLimitMs
	}
	memoryLimitMb := submissionMsg.MemoryLimitMb
	if memoryLimitMb > maxAdHocMemoryLimitMb {
		memoryLimitMb = maxAdHocMemoryLimitMb
	}
	return models.Problem{
		Title:         "Ad-hoc execution",
		Description:   "Submitted through the public execution API; no stored problem.",
		Type:          models.StdinProblem,
		TestCases:     submissionMsg.Tests,
		TimeLimitMs:   timeLimitMs,
		MemoryLimitMb: memoryLimitMb,
	}
}

// prepareSubmissionFiles generates the necessary wrapper and source files for execution.
func prepareSubmissionFiles(submissionMsg models.SubmissionMessage, problem models.Problem, lang *languages.Language, tempDir string) ([]string, []string, []string, error) {
	// The problem's TestCases have been parsed and normalized by ValidateBasic().
	// We re-marshal them here to pass the clean JSON to the wrapper.
	testsJSON, err := json.Marshal(problem.TestCases)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to marshal normalized test cases to JSON: %w", err)
	}
	if len(testsJSON) > maxTestsBytes {
		return nil, nil, nil, fmt.Errorf("tests JSON too large after normalization: %d bytes", len(testsJSON))
	}
	problem.TestsJSON = testsJSON

	// The submission message provides the function name used in the user's code.
	wrapperCode, err := wrapper.GenerateWrapper(problem, lang, submissionMsg.FunctionName, "")
	if err != nil {
		return nil, nil, nil, fmt.Errorf("failed to generate wrapper: %w", err)
	}

	compareMode := submissionMsg.CompareMode
	if compareMode == "" {
		compareMode = "STRUCTURAL" // Default compare mode
	}
	wrapperCode = strings.ReplaceAll(wrapperCode, "{{COMPARE_MODE}}", compareMode)

	var filesToCopy []string
	compileCmd := lang.CompileCmd
	runCmd := lang.RunCmd

	// This large block can also be refactored further into language-specific file generators
	if lang.ID == "javascript" {
		submissionFileName := "submission.js"
		wrapperFileName := "wrapper.js"
		submissionCode := submissionMsg.Code + "\nmodule.exports = { " + submissionMsg.FunctionName + " };"
		if err := workspace.WriteFile(tempDir, submissionFileName, []byte(submissionCode), 0644); err != nil {
			return nil, nil, nil, fmt.Errorf("failed to write submission file: %w", err)
		}
		if err := workspace.WriteFile(tempDir, wrapperFileName, []byte(wrapperCode), 0644); err != nil {
			return nil, nil, nil, fmt.Errorf("failed to write wrapper file: %w", err)
		}
		filesToCopy = []string{submissionFileName, wrapperFileName}
	} else {
		finalCode := strings.Replace(wrapperCode, "// USER_CODE_MARKER", submissionMsg.Code, 1)
		finalCode = strings.Replace(finalCode, "# USER_CODE_MARKER", submissionMsg.Code, 1)

		switch lang.ID {
		case "java":
			solutionFileName := "Solution.java"
			if err := workspace.WriteFile(tempDir, solutionFileName, []byte(submissionMsg.Code), 0644); err != nil {
				return nil, nil, nil, fmt.Errorf("failed to write solution file: %w", err)
			}
			submissionFileName := "GeneratedTester.java"
			if err := workspace.WriteFile(tempDir, submissionFileName, []byte(wrapperCode), 0644); err != nil {
				return nil, nil, nil, fmt.Errorf("failed to write combined submission file: %w", err)
			}
			filesToCopy = []string{solutionFileName, submissionFileName}
		case "python":
			submissionFileName := "wrapper.py"
			solutionFileName := "solution.py"
			if err := workspace.WriteFile(tempDir, solutionFileName, []byte(submissionMsg.Code), 0644); err != nil {
				return nil, nil, nil, fmt.Errorf("failed to write solution file: %w", err)
			}
			if err := workspace.WriteFile(tempDir, submissionFileName, []byte(finalCode), 0644); err != nil {
				return nil, nil, nil, fmt.Errorf("failed to write combined submission file: %w", err)
			}
			filesToCopy = []string{submissionFileName, solutionFileName}
		case "go":
			solutionFileName := "solution.go"
			if err := workspace.WriteFile(tempDir, solutionFileName, []byte(submissionMsg.Code), 0644); err != nil {
				return nil, nil, nil, fmt.Errorf("failed to write solution file: %w", err)
			}
			wrapperFileName := "main.go"
			// Clear USER_CODE_MARKER in the wrapper since the user code is in a separate file
			finalWrapperCode := strings.Replace(wrapperCode, "// USER_CODE_MARKER", "", 1)
			if err := workspace.WriteFile(tempDir, wrapperFileName, []byte(finalWrapperCode), 0644); err != nil {
				return nil, nil, nil, fmt.Errorf("failed to write wrapper file: %w", err)
			}
			filesToCopy = []string{solutionFileName, wrapperFileName}
		default: // C, CSharp, etc.
			submissionFileName := "main" + lang.FileExt
			if err := workspace.WriteFile(tempDir, submissionFileName, []byte(finalCode), 0644); err != nil {
				return nil, nil, nil, fmt.Errorf("failed to write combined submission file: %w", err)
			}
			filesToCopy = []string{submissionFileName}
		}
	}

	return filesToCopy, compileCmd, runCmd, nil
}

// rawRunFilesAndCommands returns the file(s) to write, compile command, and run command
// for RAW (unwrapped) execution of a single source file against stdin — no function
// wrapper, no test harness, no structural comparison.
//
// This is exactly what adapters.StdinAdapterRegistry describes, so it delegates there
// rather than keeping a second copy. The two used to be separate switch statements and
// had silently drifted: /raw-run supported twelve languages while the stdin registry
// supported five, and the two disagreed on optimisation flags and on Go's offline build
// hardening (see the registry's comment). One definition means the synchronous raw path
// and the queue-backed stdin path cannot diverge again.
func rawRunFilesAndCommands(lang *languages.Language, code string, tempDir string) ([]string, []string, []string, error) {
	adapter, ok := adapters.GetStdinAdapter(lang.ID)
	if !ok {
		return nil, nil, nil, fmt.Errorf("raw execution is not supported for language %q yet", lang.ID)
	}

	filesToCopy, err := adapter.PrepareFiles(tempDir, code)
	if err != nil {
		return nil, nil, nil, err
	}
	return filesToCopy, adapters.StdinCompileCommand(adapter), adapter.RunCommand(), nil
}

type rawRunRequest struct {
	Language      string `json:"language"`
	Code          string `json:"code"`
	Stdin         string `json:"stdin"`
	TimeoutMs     int64  `json:"timeoutMs"`
	MemoryLimitMb int64  `json:"memoryLimitMb"`
}

type rawRunResponse struct {
	Stdout        string `json:"stdout"`
	Stderr        string `json:"stderr"`
	CompileOutput string `json:"compileOutput,omitempty"`
	ExitCode      int    `json:"exitCode"`
	TimedOut      bool   `json:"timedOut"`
	OomKilled     bool   `json:"oomKilled"`
	CompileError  bool   `json:"compileError"`
	TimeMs        int64  `json:"timeMs"`
	Error         string `json:"error,omitempty"`
}

// recordUsageAsync writes one usageevents document for the synchronous /run and /raw-run
// paths, which otherwise leave no trace: the queue path already writes its own event. It is
// for statistics (per-language volume and run time), not billing: these events carry no
// apiClientId, so quotas and invoices never count them. Fire-and-forget, so a slow or
// unavailable database can never delay or fail the caller's run.
func recordUsageAsync(coll *mongo.Collection, event bson.M) {
	if coll == nil {
		return
	}
	if _, ok := event["createdAt"]; !ok {
		event["createdAt"] = time.Now()
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := coll.InsertOne(ctx, event); err != nil {
			slog.Warn("Failed to record usage event", "source", event["source"], "error", err)
		}
	}()
}

// rawRunUsageStatus maps a /raw-run outcome onto the same status names the queue path
// records, so statistics can be grouped across both. A raw run has no expected output, so a
// program that finished cleanly counts as Accepted.
func rawRunUsageStatus(resp rawRunResponse) string {
	switch {
	case resp.Error != "":
		return models.StatusError
	case resp.CompileError:
		return models.SubmissionStatusCompilationError
	case resp.TimedOut:
		return models.SubmissionStatusTimeLimitExceeded
	case resp.OomKilled:
		return models.SubmissionStatusMemoryLimitExceeded
	case resp.ExitCode != 0:
		return models.SubmissionStatusRuntimeError
	default:
		return models.SubmissionStatusAccepted
	}
}

// handleRawRun serves POST /raw-run: compile (if needed) and execute a single raw source
// file against a single stdin payload, with no problem/test-case/wrapper concept at all.
// This is the primitive the public GO Judge public API shim in assessment-api calls into —
// judge-service-go itself is never exposed publicly (see docker-compose.prod.yml), so this
// endpoint intentionally has no auth of its own; the network boundary is the control.
func handleRawRun(containerPool *pool.ContainerPool, ex *executor.Executor, usageEvents *mongo.Collection) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var req rawRunRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		lang := languages.GetLanguage(req.Language)
		if lang == nil {
			http.Error(w, "Unsupported language", http.StatusBadRequest)
			return
		}

		// Clamp caller-supplied limits defensively — this endpoint trusts assessment-api,
		// but a bug or misconfiguration there shouldn't be able to pin a container forever
		// or starve the sandbox's own memory ceiling.
		timeoutMs := req.TimeoutMs
		if timeoutMs <= 0 {
			timeoutMs = int64(defaultSandboxTimeout / time.Millisecond)
		}
		if timeoutMs > 60000 {
			timeoutMs = 60000
		}
		timeout := time.Duration(timeoutMs) * time.Millisecond

		memoryLimitMb := req.MemoryLimitMb
		if memoryLimitMb <= 0 {
			memoryLimitMb = 256
		}
		if memoryLimitMb > 2048 {
			memoryLimitMb = 2048
		}

		acquireCtx, acquireCancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer acquireCancel()

		pooledContainer := containerPool.Acquire(acquireCtx, lang.ID)
		if pooledContainer == nil {
			http.Error(w, "No available containers (request timed out waiting for resource)", http.StatusServiceUnavailable)
			return
		}
		discardContainer := false
		discardReason := ""
		// Recycle after MaxExecutionsPerContainer runs, same as the queue path.
		if cnt := atomic.AddInt32(&pooledContainer.ExecutionCount, 1); cnt >= atomic.LoadInt32(&MaxExecutionsPerContainer) {
			discardContainer = true
			discardReason = fmt.Sprintf("max executions reached: %d", cnt)
		}
		defer func() {
			finishWithContainer(containerPool, ex, pooledContainer, discardContainer, discardReason)
		}()

		reqID := fmt.Sprintf("raw-%d", time.Now().UnixNano())
		subWorkspace, err := workspace.NewSubmissionWorkspace(pooledContainer.WorkDir, reqID)
		if err != nil {
			http.Error(w, "Failed to create submission workspace", http.StatusInternalServerError)
			return
		}
		defer func() {
			if cleanupErr := workspace.CleanupSubmissionWorkspace(subWorkspace.HostPath); cleanupErr != nil {
				discardContainer = true
				discardReason = "raw-run workspace cleanup failed"
				slog.Error("Failed to cleanup raw-run workspace", "path", subWorkspace.HostPath, "error", cleanupErr)
			}
		}()

		filesToCopy, compileCmd, runCmd, err := rawRunFilesAndCommands(lang, req.Code, subWorkspace.HostPath)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		// Must comfortably exceed RunRawWithStdin's own budget (120s fixed compile +
		// up to 2x the run timeout) or this context cancels the request before the
		// compile step's dedicated allowance even runs out.
		execCtx, cancel := context.WithTimeout(r.Context(), 150*time.Second+2*timeout)
		defer cancel()

		start := time.Now()
		stdout, stderr, compileOutput, exitCode, execErr := ex.RunRawWithStdin(
			execCtx, pooledContainer.ID, filesToCopy, subWorkspace.HostPath, subWorkspace.ContainerPath,
			compileCmd, runCmd, timeout, memoryLimitMb, []byte(req.Stdin),
		)
		elapsedMs := time.Since(start).Milliseconds()

		resp := rawRunResponse{
			Stdout:        stdout,
			Stderr:        stderr,
			CompileOutput: compileOutput,
			ExitCode:      exitCode,
			TimeMs:        elapsedMs,
		}

		if execErr != nil {
			var execErrObj *executor.ExecutionError
			if errors.As(execErr, &execErrObj) {
				switch execErrObj.Type {
				case executor.ErrCompilationFailed:
					resp.CompileError = true
					if resp.CompileOutput == "" {
						resp.CompileOutput = execErrObj.Message
					}
				case executor.ErrTimeLimitExceeded:
					resp.TimedOut = true
				case executor.ErrMemoryLimitExceeded:
					resp.OomKilled = true
					// Echo back the requested limit so the caller's own
					// "memory >= limit => reclassify as MLE" heuristic fires
					// even though we don't meter actual peak usage here.
				case executor.ErrRuntimeError:
					// A non-zero exit from the submitted program is an ordinary judging
					// outcome, not a judge failure, so Error is deliberately left empty:
					// ExitCode and Stderr above already carry everything the caller needs.
					// This matters because the GO Judge shim checks raw.error before
					// exitCode, so setting it here reported every student crash as
					// INTERNAL_ERROR (13, "the judge broke") instead of RUNTIME_ERROR
					// (11, NZEC) — which left a consuming platform unable to tell a
					// crashing submission apart from our own infrastructure failing.
				default:
					resp.Error = execErr.Error()
				}
			} else {
				resp.Error = execErr.Error()
			}

			if discard, reason := shouldDiscardContainer(execErr, nil, false); discard {
				discardContainer = true
				discardReason = reason
			}
		}

		recordUsageAsync(usageEvents, bson.M{
			"language":  lang.ID,
			"status":    rawRunUsageStatus(resp),
			"elapsedMs": elapsedMs,
			"testCount": 1,
			"source":    "raw-run",
		})

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}

// testCountFromResult is how many test cases a submission actually executed, falling back
// to the number it carried when no result was produced (e.g. a compile failure) so a
// failed run is still metered as the work that was requested.
func testCountFromResult(result *models.SubmissionResult, requested int) int {
	if result != nil && result.Total > 0 {
		return result.Total
	}
	if requested > 0 {
		return requested
	}
	return 1
}

// elapsedMsFromResult extracts the total execution time already computed onto the result
// (by the central runner, or by the wrapper's own JSON output) for reuse as the usage
// metering signal, without timing the submission a second time.
func elapsedMsFromResult(result *models.SubmissionResult) int64 {
	if result == nil {
		return 0
	}
	return result.ElapsedMs
}

// processAndStoreResults processes the executor output and updates the database and cache.
func fallbackResultForExecutionFailure(executionPath string, execErr error, stdout string) *models.SubmissionResult {
	result := models.NewSubmissionResult()
	result.ExecutionPath = executionPath
	result.Status = models.SubmissionStatusRuntimeError

	if stdout != "" {
		result.InternalError = models.InternalErrorJudge
		return result
	}

	if execErr != nil {
		var execErrObj *executor.ExecutionError
		if errors.As(execErr, &execErrObj) {
			switch execErrObj.Type {
			case executor.ErrCompilationFailed:
				result.Status = models.SubmissionStatusCompilationError
				return result
			case executor.ErrTimeLimitExceeded:
				result.Status = models.SubmissionStatusTimeLimitExceeded
				return result
			case executor.ErrMemoryLimitExceeded:
				result.Status = models.SubmissionStatusMemoryLimitExceeded
				return result
			}
		}
	}

	result.InternalError = models.InternalErrorWrapper
	return result
}

func shouldDiscardContainer(execErr error, result *models.SubmissionResult, cleanupFailed bool) (bool, string) {
	if cleanupFailed {
		return true, "submission workspace cleanup failed"
	}

	if execErr != nil {
		if isPoisonousExecutionError(execErr) {
			return true, execErr.Error()
		}
		return false, ""
	}

	if result == nil {
		return false, ""
	}
	if result.InternalError == models.InternalErrorWrapper {
		return true, "wrapper/internal runtime failure"
	}
	if result.Status == models.SubmissionStatusCompilationError && looksLikeContainerFailure(result.Stderr) {
		return true, "compile failed due to container-level failure"
	}

	return false, ""
}

// isPoisonousExecutionError reports whether an execution error means the container itself is
// broken. A verdict (TLE, MLE, runtime error, a compile that timed out) is the student's
// program, and the reset in finishWithContainer kills whatever it left behind, discarding the
// container if that fails. Discarding on every verdict cost a container start per TLE and, in
// an exam, thrashed the pool exactly when it was busiest (JUDGE_FIX_PLAN T2).
func isPoisonousExecutionError(err error) bool {
	var execErr *executor.ExecutionError
	if errors.As(err, &execErr) {
		switch execErr.Type {
		case executor.ErrContainerUnhealthy:
			return true
		case executor.ErrTimeLimitExceeded, executor.ErrMemoryLimitExceeded, executor.ErrRuntimeError:
			return false
		case executor.ErrCompilationFailed:
			return looksLikeContainerFailure(execErr.Message)
		}
	}
	return looksLikeContainerFailure(err.Error())
}

func looksLikeContainerFailure(message string) bool {
	msg := strings.ToLower(message)
	return strings.Contains(msg, "container unhealthy") ||
		strings.Contains(msg, "stopped container") ||
		strings.Contains(msg, "no such container") ||
		strings.Contains(msg, "is not running")
}

// cleanupOrphanContainers removes containers left from previous runs that
// were created by this service (labelled with managed-by=judge-service).
func cleanupOrphanContainers(ctx context.Context, cli *docker.Client) error {
	filters := map[string][]string{
		"label": {"managed-by=judge-service"},
	}
	opts := docker.ListContainersOptions{
		All:     true,
		Filters: filters,
	}
	containers, err := cli.ListContainers(opts)
	if err != nil {
		return fmt.Errorf("failed to list docker containers: %w", err)
	}

	removed := 0
	for _, c := range containers {
		slog.Info("Removing orphan container", "id", c.ID, "names", c.Names)
		if err := cli.RemoveContainer(docker.RemoveContainerOptions{ID: c.ID, Force: true}); err != nil {
			slog.Error("Failed to remove orphan container", "id", c.ID, "error", err)
			continue
		}
		removed++
	}
	if removed > 0 {
		slog.Info("Startup cleanup removed orphan containers", "count", removed)
	}
	return nil
}

// StartPeriodicOrphanGC starts a background goroutine that periodically
// removes stopped/dead containers labelled as managed-by=judge-service.
func StartPeriodicOrphanGC(ctx context.Context, cli *docker.Client, interval time.Duration) {
	if interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				filters := map[string][]string{
					"label":  {"managed-by=judge-service"},
					"status": {"exited", "dead"},
				}
				opts := docker.ListContainersOptions{All: true, Filters: filters}
				containers, err := cli.ListContainers(opts)
				if err != nil {
					slog.Error("periodic GC: failed to list containers", "error", err)
					continue
				}
				removed := 0
				for _, c := range containers {
					slog.Info("periodic GC removing container", "id", c.ID, "names", c.Names, "status", c.Status)
					if err := cli.RemoveContainer(docker.RemoveContainerOptions{ID: c.ID, Force: true}); err != nil {
						slog.Error("periodic GC: failed to remove container", "id", c.ID, "error", err)
						continue
					}
					removed++
				}
				if removed > 0 {
					slog.Info("periodic GC removed containers", "count", removed)
				}
				// Update metrics
				metrics.SetGCLastRun(time.Now())
				if removed > 0 {
					metrics.AddGCRemoved(removed)
					// Count statuses roughly by scanning container statuses
					exited := 0
					dead := 0
					for _, c := range containers {
						if strings.Contains(strings.ToLower(c.Status), "exited") {
							exited++
						}
						if strings.Contains(strings.ToLower(c.Status), "dead") {
							dead++
						}
					}
					if exited > 0 {
						metrics.AddGCRemovedExited(exited)
					}
					if dead > 0 {
						metrics.AddGCRemovedDead(dead)
					}
				}
			}
		}
	}()
}

// finishWithContainer returns a container to the pool after a submission, or discards it.
// A container that will be reused is reset first (submission files, /tmp, leftover processes,
// memory limit), so nothing from one submission is visible to the next. If the reset fails
// the container cannot be trusted clean and is discarded instead.
func finishWithContainer(containerPool *pool.ContainerPool, ex *executor.Executor, container *pool.PooledContainer, discard bool, reason string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if !discard && ex != nil {
		if err := ex.ResetContainer(ctx, container.ID); err != nil {
			slog.Warn("Container reset failed; discarding it", "containerId", container.ID, "error", err)
			discard = true
			reason = "reset failed: " + err.Error()
		}
	}
	if discard {
		containerPool.Discard(ctx, container, reason)
		return
	}
	containerPool.Release(container)
}

// storeResultsTimeout bounds all of processAndStoreResults' database and cache writes, so a
// stalled Mongo or Redis cannot hold a worker (and the message it has not yet acked) forever.
const storeResultsTimeout = 15 * time.Second

func processAndStoreResults(ctx context.Context, executionPath string, stdout, stderr string, execErr error, submissionMsg models.SubmissionMessage, submissionsCollection *mongo.Collection, problemsCollection *mongo.Collection, usageEventsCollection *mongo.Collection, redisClient *redis.Client) {
	ctx, cancel := context.WithTimeout(ctx, storeResultsTimeout)
	defer cancel()

	var result models.SubmissionResult
	submissionStatus := models.StatusError
	submissionOutput := stderr
	var submissionTestResult *models.SubmissionResult

	if stdout != "" {
		slog.Info("Processing stdout", "submissionId", submissionMsg.SubmissionID, "stdoutLen", len(stdout), "stdoutHead", stdout[:min(len(stdout), 100)])
		if err := json.Unmarshal([]byte(stdout), &result); err == nil {
			submissionTestResult = &result
			submissionTestResult.ExecutionPath = executionPath
			result.NormalizeCounts()
			slog.Info("Parsed submission result", "submissionId", submissionMsg.SubmissionID, "status", result.Status, "passed", result.Passed, "total", result.Total)
			switch result.Status {
			case models.SubmissionStatusAccepted:
				submissionStatus = models.StatusSuccess
			case models.SubmissionStatusWrongAnswer:
				submissionStatus = models.StatusFail
			case models.SubmissionStatusCompilationError, models.SubmissionStatusRuntimeError, models.SubmissionStatusTimeLimitExceeded, models.SubmissionStatusMemoryLimitExceeded:
				submissionStatus = models.StatusError
			default:
				submissionStatus = models.StatusError
			}
			submissionOutput = stdout
		} else {
			slog.Error("Error unmarshalling stdout to result", "submissionId", submissionMsg.SubmissionID, "error", err, "stdout", stdout)
			submissionTestResult = fallbackResultForExecutionFailure(executionPath, execErr, stdout)
			if submissionTestResult.Status == models.SubmissionStatusCompilationError {
				submissionOutput = stderr
			} else {
				submissionOutput = fmt.Sprintf("Invalid judge output: %v\nStdout: %s", err, stdout)
				if execErr != nil {
					submissionOutput += fmt.Sprintf("\nExecution Error: %v\nStderr: %s", execErr, stderr)
				}
			}
		}
	} else if execErr != nil {
		submissionTestResult = fallbackResultForExecutionFailure(executionPath, execErr, stdout)
		if submissionTestResult.Status == models.SubmissionStatusCompilationError {
			submissionOutput = stderr
		} else {
			submissionOutput = fmt.Sprintf("Execution Error: %v\nStderr: %s", execErr, stderr)
		}
	}

	submissionObjID, err := primitive.ObjectIDFromHex(submissionMsg.SubmissionID)
	if err != nil {
		slog.Error("Invalid SubmissionID for result update", "submissionId", submissionMsg.SubmissionID, "error", err)
		return
	}

	update := bson.M{
		"$set": bson.M{
			"status":     submissionStatus,
			"output":     submissionOutput,
			"testResult": submissionTestResult,
			"updatedAt":  time.Now(),
		},
	}
	// One round trip that both writes the result and returns the row as it was before, which
	// supplies CreatedAt/UserID for the Redis copy and tells us whether this delivery is a
	// repeat. A row that already has a testResult was judged by an earlier delivery of the
	// same message (the judge died before its ack, or a shutdown cut it off); a rejudge
	// clears testResult first, so it still counts as new work.
	var originalSubmission models.Submission
	findOpts := options.FindOneAndUpdate().
		SetReturnDocument(options.Before).
		SetProjection(bson.M{"userId": 1, "createdAt": 1, "status": 1, "testResult.status": 1})
	err = submissionsCollection.FindOneAndUpdate(ctx, bson.M{"_id": submissionObjID}, update, findOpts).Decode(&originalSubmission)
	if err != nil {
		slog.Error("Error updating submission in MongoDB", "submissionId", submissionMsg.SubmissionID, "error", err)
		// Not returning error, as we will still try to update Redis
	}
	alreadyJudged := err == nil && originalSubmission.TestResult != nil
	if alreadyJudged {
		slog.Warn("Submission was already judged by an earlier delivery; not counting it again",
			"submissionId", submissionMsg.SubmissionID, "previousStatus", originalSubmission.Status)
	}

	// Update problem analytics
	problemObjID, err := primitive.ObjectIDFromHex(submissionMsg.ProblemID)
	if err == nil && !alreadyJudged {
		inc := bson.M{"submissionCount": 1}
		if submissionStatus == models.StatusSuccess {
			inc["acceptedCount"] = 1
		}
		_, err = problemsCollection.UpdateByID(ctx, problemObjID, bson.M{"$inc": inc})
		if err != nil {
			slog.Error("Error updating problem analytics", "problemId", submissionMsg.ProblemID, "error", err)
		}
	}

	// Usage metering (H4): one event per executed submission, carrying the same
	// elapsedMs already computed above for the result payload. Best-effort — a
	// metering write must never fail or delay the submission's own result.
	usageEvent := bson.M{
		"submissionId": submissionObjID,
		"userId":       originalSubmission.UserID,
		"language":     submissionMsg.Language,
		"status":       submissionStatus,
		"elapsedMs":    elapsedMsFromResult(submissionTestResult),
		// A coalesced batch is one submission with many test cases, so usage is also
		// recorded in tests. Without it a client sending six cases in one request would meter
		// as one, undercounting exactly the traffic the batch endpoint is meant to attract.
		"testCount":    testCountFromResult(submissionTestResult, len(submissionMsg.Tests)),
		"createdAt":    time.Now(),
		// Which execution path ran it, so per-language statistics can be split by surface.
		"source": "queue",
	}
	if submissionMsg.CollegeID != "" {
		if collegeObjID, err := primitive.ObjectIDFromHex(submissionMsg.CollegeID); err == nil {
			usageEvent["collegeId"] = collegeObjID
		}
	}
	// Attribution for per-customer metering and invoicing. Same best-effort posture as
	// the rest of this block: a malformed id is dropped rather than failing the result.
	if submissionMsg.ApiClientID != "" {
		if apiClientObjID, err := primitive.ObjectIDFromHex(submissionMsg.ApiClientID); err == nil {
			usageEvent["apiClientId"] = apiClientObjID
		}
	}
	// A repeat delivery was already metered; recording it again would bill the work twice.
	if !alreadyJudged {
		if _, err := usageEventsCollection.InsertOne(ctx, usageEvent); err != nil {
			slog.Error("Failed to record usage event", "submissionId", submissionMsg.SubmissionID, "error", err)
		}
	}

	updatedSubmission := models.Submission{
		ID:         submissionObjID,
		ProblemID:  problemObjID,
		Language:   submissionMsg.Language,
		Code:       submissionMsg.Code,
		Status:     submissionStatus,
		Output:     submissionOutput,
		TestResult: submissionTestResult,
		CreatedAt:  originalSubmission.CreatedAt,
		UserID:     originalSubmission.UserID,
		UpdatedAt:  time.Now(),
	}

	jsonSubmission, err := json.Marshal(updatedSubmission)
	if err == nil {
		err := redisClient.Set(ctx, fmt.Sprintf("submission:%s", submissionMsg.SubmissionID), jsonSubmission, 3600*time.Second).Err()
		if err != nil {
			slog.Error("Error updating submission in Redis", "submissionId", submissionMsg.SubmissionID, "error", err)
		}
	}
}

// markSubmissionExecutionFailed records a terminal failure for a submission that never
// reached execution (e.g. it exhausted its retry budget waiting for a pool container),
// so it surfaces to the user instead of silently vanishing from the queue.
func markSubmissionExecutionFailed(ctx context.Context, submissionsCollection *mongo.Collection, submissionMsg models.SubmissionMessage, reason string) {
	ctx, cancel := context.WithTimeout(ctx, storeResultsTimeout)
	defer cancel()
	submissionObjID, err := primitive.ObjectIDFromHex(submissionMsg.SubmissionID)
	if err != nil {
		slog.Error("Invalid SubmissionID while marking submission failed", "submissionId", submissionMsg.SubmissionID, "error", err)
		return
	}
	update := bson.M{
		"$set": bson.M{
			"status":    models.StatusError,
			"output":    reason,
			"updatedAt": time.Now(),
		},
	}
	if _, err := submissionsCollection.UpdateByID(ctx, submissionObjID, update); err != nil {
		slog.Error("Failed to mark submission as failed", "submissionId", submissionMsg.SubmissionID, "error", err)
	}
}

// dropSubmission is the permanent-failure exit for a message: it marks the submission
// failed, so the student sees an error instead of a submission that stays Pending forever,
// then rejects the message to the dead-letter queue. reason is shown to the student, so it
// must not carry internal detail; the caller logs the real error.
func dropSubmission(d amqp.Delivery, submissionsCollection *mongo.Collection, submissionMsg models.SubmissionMessage, reason string) {
	if submissionMsg.SubmissionID != "" {
		markSubmissionExecutionFailed(context.Background(), submissionsCollection, submissionMsg, reason)
	}
	d.Nack(false, false)
}

// retryLater sends a message that hit a temporary problem (no free container, database
// unavailable) through the TTL'd retry queue rather than straight back onto the work queue,
// which would redeliver it at once in a tight loop. After MaxSubmissionRetries attempts the
// submission is marked failed with failReason.
func retryLater(ctx context.Context, d amqp.Delivery, ch *amqp.Channel, retryQueueName string, submissionsCollection *mongo.Collection, submissionMsg models.SubmissionMessage, why string, failReason string) {
	if submissionMsg.RetryCount >= models.MaxSubmissionRetries {
		slog.Error("Submission exceeded max retries; marking as failed",
			"submissionId", submissionMsg.SubmissionID, "why", why, "retryCount", submissionMsg.RetryCount)
		markSubmissionExecutionFailed(ctx, submissionsCollection, submissionMsg, failReason)
		d.Ack(false)
		return
	}

	submissionMsg.RetryCount++
	retryBody, err := json.Marshal(submissionMsg)
	if err != nil {
		slog.Error("Failed to marshal submission for retry, using original body", "submissionId", submissionMsg.SubmissionID, "error", err)
		retryBody = d.Body
	}

	slog.Warn("Routing submission to retry queue",
		"submissionId", submissionMsg.SubmissionID, "why", why, "retryCount", submissionMsg.RetryCount)

	// To avoid a hot-requeue loop, publish to a retry queue with a TTL.
	err = ch.PublishWithContext(ctx, "", retryQueueName, false, false, amqp.Publishing{
		ContentType:  d.ContentType,
		Body:         retryBody,
		DeliveryMode: amqp.Persistent,
	})
	if err != nil {
		slog.Error("Failed to publish to retry queue", "submissionId", submissionMsg.SubmissionID, "error", err)
		d.Nack(false, true) // Fallback to basic requeue
		return
	}

	d.Ack(false)
}

// processSubmission is the main coordinator for handling a submission message.
func processSubmission(interactive bool, d amqp.Delivery, ch *amqp.Channel, retryQueueName string, problemsCollection *mongo.Collection, submissionsCollection *mongo.Collection, usageEventsCollection *mongo.Collection, redisClient *redis.Client, executor *executor.Executor, containerPool *pool.ContainerPool) {
	ctx := context.Background()

	submissionMsg, err := validateAndDecodeSubmission(d)
	if err != nil {
		slog.Error("Validation failed", "submissionId", submissionMsg.SubmissionID, "error", err)
		dropSubmission(d, submissionsCollection, submissionMsg, "The judge could not read this submission.")
		return
	}

	// An ad-hoc submission carries its own tests and has no stored problem to
	// fetch, so the Problem is built in memory. Everything downstream — strategy
	// dispatch, the container pool, retries, persistence and metering — then
	// treats it exactly like any other stdin submission, which is the entire
	// point: the public GO Judge surface stops being a separate execution path.
	var problem models.Problem
	if submissionMsg.IsAdHoc() {
		problem = adHocProblem(submissionMsg)
	} else {
		problem, err = fetchProblemData(ctx, problemsCollection, submissionMsg.ProblemID)
		if err != nil {
			slog.Error("Failed to fetch problem data", "submissionId", submissionMsg.SubmissionID, "error", err)
			if errors.Is(err, errProblemNotFound) {
				dropSubmission(d, submissionsCollection, submissionMsg, "The problem for this submission no longer exists.")
				return
			}
			// The database may be briefly unavailable: worth retrying, but through the
			// delayed retry queue, never an instant requeue.
			retryLater(ctx, d, ch, retryQueueName, submissionsCollection, submissionMsg, "problem fetch failed",
				"The judge could not load the problem for this submission. Please try again.")
			return
		}
	}

	// Validate the problem data and parse/normalize test cases from the problem doc.
	if err := problem.ValidateBasic(); err != nil {
		slog.Error("Invalid problem data", "submissionId", submissionMsg.SubmissionID, "error", err)
		dropSubmission(d, submissionsCollection, submissionMsg, "This problem's test data is invalid. Please tell your instructor.")
		return
	}

	lang := languages.GetLanguage(submissionMsg.Language)
	if lang == nil {
		slog.Error("Unsupported language", "submissionId", submissionMsg.SubmissionID, "language", submissionMsg.Language)
		dropSubmission(d, submissionsCollection, submissionMsg, fmt.Sprintf("The language %q is not supported.", submissionMsg.Language))
		return
	}

	// Resolve the execution strategy for this problem's type up front. The
	// legacy wrapper-based fallback further below only supports function-mode
	// problems, so a non-function problem with no registered strategy must
	// fail cleanly here rather than silently falling through to it.
	strategy, hasStrategy := ResolveStrategy(problem.EffectiveType())
	if !hasStrategy && problem.EffectiveType() != models.FunctionProblem {
		slog.Error("No execution strategy registered for problem type", "submissionId", submissionMsg.SubmissionID, "problemType", problem.EffectiveType())
		dropSubmission(d, submissionsCollection, submissionMsg, "This type of problem cannot be run by the judge.")
		return
	}

	// Acquire a container from the pool with a timeout
	acquireCtx, acquireCancel := context.WithTimeout(ctx, 30*time.Second)
	defer acquireCancel()

	// Bulk work leaves a reserve of idle containers for interactive callers; without it
	// a backlog of bulk submissions holds every container and the priority queue is
	// priority in name only (see pool.AcquireBulk).
	var pooledContainer *pool.PooledContainer
	if interactive {
		pooledContainer = containerPool.Acquire(acquireCtx, lang.ID)
	} else {
		pooledContainer = containerPool.AcquireBulk(acquireCtx, lang.ID, bulkContainerReserve)
	}
	if pooledContainer == nil {
		retryLater(ctx, d, ch, retryQueueName, submissionsCollection, submissionMsg, "no free "+lang.ID+" container",
			fmt.Sprintf("No available %s execution containers after %d retries", lang.ID, submissionMsg.RetryCount))
		return
	}
	discardContainer := false
	discardReason := ""
	// Increment execution count and mark for discard if it exceeded the threshold
	cnt := atomic.AddInt32(&pooledContainer.ExecutionCount, 1)
	if cnt >= atomic.LoadInt32(&MaxExecutionsPerContainer) {
		slog.Info("Container reached max executions; will be discarded after use", "containerId", pooledContainer.ID, "count", cnt)
		discardContainer = true
		discardReason = fmt.Sprintf("max executions reached: %d", cnt)
	}
	defer func() {
		finishWithContainer(containerPool, executor, pooledContainer, discardContainer, discardReason)
	}()

	if adapter, ok := adapters.GetAdapter(lang.ID); ok && isCentralCompareEnabled(lang.ID) && hasStrategy {
		execCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
		defer cancel()

		result, cleanupFailed, err := strategy.Run(execCtx, executor, pooledContainer, submissionMsg, problem, adapter)
		if err != nil {
			slog.Error("Central execution setup failed", "submissionId", submissionMsg.SubmissionID, "adapter", adapter.Name(), "error", err)
			if discard, reason := shouldDiscardContainer(err, result, cleanupFailed); discard {
				discardContainer = true
				discardReason = reason
			}
			dropSubmission(d, submissionsCollection, submissionMsg, "The judge failed while running this submission. Please try again.")
			return
		}
		if discard, reason := shouldDiscardContainer(nil, result, cleanupFailed); discard {
			discardContainer = true
			discardReason = reason
		}

		resultBytes, err := result.ToJSON()
		if err != nil {
			slog.Error("Failed to marshal central result", "submissionId", submissionMsg.SubmissionID, "error", err)
			dropSubmission(d, submissionsCollection, submissionMsg, "The judge failed while saving this submission's result. Please try again.")
			return
		}
		processAndStoreResults(ctx, models.ExecutionPathCentral, string(resultBytes), "", nil, submissionMsg, submissionsCollection, problemsCollection, usageEventsCollection, redisClient)

		d.Ack(false)
		return
	}

	submissionWorkspace, err := workspace.NewSubmissionWorkspace(pooledContainer.WorkDir, submissionMsg.SubmissionID)
	if err != nil {
		slog.Error("Failed to create submission workspace", "submissionId", submissionMsg.SubmissionID, "error", err)
		retryLater(ctx, d, ch, retryQueueName, submissionsCollection, submissionMsg, "workspace creation failed",
			"The judge could not prepare this submission. Please try again.")
		return
	}
	defer func() {
		if cleanupErr := workspace.CleanupSubmissionWorkspace(submissionWorkspace.HostPath); cleanupErr != nil {
			discardContainer = true
			discardReason = "submission workspace cleanup failed"
			slog.Error("Failed to cleanup submission workspace", "submissionId", submissionMsg.SubmissionID, "path", submissionWorkspace.HostPath, "error", cleanupErr)
		}
	}()

	filesToCopy, compileCmd, runCmd, err := prepareSubmissionFiles(submissionMsg, problem, lang, submissionWorkspace.HostPath)
	if err != nil {
		slog.Error("Failed to prepare submission files", "submissionId", submissionMsg.SubmissionID, "error", err)
		dropSubmission(d, submissionsCollection, submissionMsg, "The judge could not prepare this submission's files.")
		return
	}

	execCtx, cancel := context.WithTimeout(ctx, 2*defaultSandboxTimeout)
	defer cancel()

	// RunSubmission needs to be refactored to use the pooled container
	stdout, stderr, execErr := executor.RunInContainer(
		execCtx,
		pooledContainer.ID,
		filesToCopy,
		submissionWorkspace.HostPath,
		submissionWorkspace.ContainerPath,
		compileCmd,
		runCmd,
		defaultSandboxTimeout,
		problem.MemoryLimitMb,
	)
	slog.Info("Execution finished", "submissionId", submissionMsg.SubmissionID, "error", execErr)
	if discard, reason := shouldDiscardContainer(execErr, nil, false); discard {
		discardContainer = true
		discardReason = reason
	}

	processAndStoreResults(ctx, models.ExecutionPathLegacy, stdout, stderr, execErr, submissionMsg, submissionsCollection, problemsCollection, usageEventsCollection, redisClient)

	d.Ack(false)
}

func isCentralCompareEnabled(language string) bool {
	switch language {
	case "python":
		if raw, ok := os.LookupEnv(centralComparePythonEnv); ok {
			return isTruthyEnv(raw)
		}
		return true
	case "javascript":
		if raw, ok := os.LookupEnv(centralCompareJSEnv); ok {
			return isTruthyEnv(raw)
		}
		return true
	case "java":
		if raw, ok := os.LookupEnv(centralCompareJavaEnv); ok {
			return isTruthyEnv(raw)
		}
		return true
	case "cpp":
		if raw, ok := os.LookupEnv(centralCompareCppEnv); ok {
			return isTruthyEnv(raw)
		}
		return true
	case "c":
		if raw, ok := os.LookupEnv(centralCompareCEnv); ok {
			return isTruthyEnv(raw)
		}
		return true
	case "go", "csharp", "typescript", "rust", "ruby", "php", "kotlin":
		return true
	default:
		return false
	}
}

func startHealthServer(ctx context.Context, containerPool *pool.ContainerPool, port string, problemsCollection *mongo.Collection, usageEventsCollection *mongo.Collection, executor *executor.Executor) {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Healthy means "taking work off the queues", not merely "process is up": a judge
		// that lost its RabbitMQ connection still answers HTTP but judges nothing.
		if !consumersHealthy.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]string{"status": "unhealthy", "reason": "not consuming from RabbitMQ"})
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
	})

	mux.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Merge pool stats with GC/reconciler metrics
		stats := containerPool.GetStats()
		metricsSnapshot := metrics.Snapshot()
		resp := map[string]interface{}{
			"pool":    stats,
			"metrics": metricsSnapshot,
		}
		json.NewEncoder(w).Encode(resp)
	})

	mux.HandleFunc("/run", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var msg models.SubmissionMessage
		if err := json.NewDecoder(r.Body).Decode(&msg); err != nil {
			http.Error(w, "Invalid request body", http.StatusBadRequest)
			return
		}

		if err := msg.Validate(); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		var problem models.Problem
		var err error

		// If it's a "temp" ID, we don't even try to fetch from DB
		if msg.ProblemID != "" && msg.ProblemID != "temp" {
			problem, err = fetchProblemData(r.Context(), problemsCollection, msg.ProblemID)
		} else {
			err = fmt.Errorf("ephemeral problem request")
		}

		if err != nil {
			// If problem not found in DB or it's ephemeral, we can still proceed if the message has test cases
			if len(msg.Tests) > 0 {
				slog.Info("Using ephemeral problem definition", "submissionId", msg.SubmissionID)
				problem = models.Problem{
					ID:            primitive.NewObjectID(), // Dummy ID
					Title:         "Ephemeral Problem",
					Description:   "Temporary problem for validation",
					Type:          msg.EffectiveType(),
					TestCases:     msg.Tests,
					FunctionName:  msg.FunctionName,
					Parameters:    msg.Parameters,
					ReturnType:    msg.ReturnType,
					CompareConfig: msg.CompareConfig,
				}
				// Default return type if missing to pass ValidateBasic (function-mode only —
				// stdin problems don't use ReturnType).
				if problem.EffectiveType() != models.StdinProblem && problem.ReturnType == "" {
					problem.ReturnType = "void"
				}
			} else {
				slog.Warn("Problem not found and no test cases provided", "problemId", msg.ProblemID)
				http.Error(w, "Problem not found and no test cases provided", http.StatusNotFound)
				return
			}
		} else {
			// If the message contains custom tests, override the problem's tests
			if len(msg.Tests) > 0 {
				problem.TestCases = msg.Tests
			} else {
				// For "Run", usually we only run sample test cases
				var samples []models.TestCase
				for _, tc := range problem.TestCases {
					if tc.IsSample {
						samples = append(samples, tc)
					}
				}
				if len(samples) > 0 {
					problem.TestCases = samples
				}
			}
		}

		if err := problem.ValidateBasic(); err != nil {
			http.Error(w, "Invalid problem data: "+err.Error(), http.StatusBadRequest)
			return
		}

		if len(problem.TestCases) == 0 {
			http.Error(w, "No test cases to run", http.StatusBadRequest)
			return
		}

		lang := languages.GetLanguage(msg.Language)
		if lang == nil {
			http.Error(w, "Unsupported language", http.StatusBadRequest)
			return
		}

		strategy, hasStrategy := ResolveStrategy(problem.EffectiveType())
		if !hasStrategy && problem.EffectiveType() != models.FunctionProblem {
			http.Error(w, "No execution strategy registered for problem type: "+string(problem.EffectiveType()), http.StatusBadRequest)
			return
		}

		acquireCtx, acquireCancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer acquireCancel()

		pooledContainer := containerPool.Acquire(acquireCtx, lang.ID)
		if pooledContainer == nil {
			http.Error(w, "No available containers (request timed out waiting for resource)", http.StatusServiceUnavailable)
			return
		}
		discardContainer := false
		discardReason := ""
		// Recycle after MaxExecutionsPerContainer runs, same as the queue path.
		if cnt := atomic.AddInt32(&pooledContainer.ExecutionCount, 1); cnt >= atomic.LoadInt32(&MaxExecutionsPerContainer) {
			discardContainer = true
			discardReason = fmt.Sprintf("max executions reached: %d", cnt)
		}
		defer func() {
			finishWithContainer(containerPool, executor, pooledContainer, discardContainer, discardReason)
		}()

		var result *models.SubmissionResult
		var runErr error

		if adapter, ok := adapters.GetAdapter(lang.ID); ok && isCentralCompareEnabled(lang.ID) && hasStrategy {
			// The request's context, so a caller that disconnects stops its run.
			execCtx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
			defer cancel()
			var cleanupFailed bool
			result, cleanupFailed, runErr = strategy.Run(execCtx, executor, pooledContainer, msg, problem, adapter)
			if discard, reason := shouldDiscardContainer(runErr, result, cleanupFailed); discard {
				discardContainer = true
				discardReason = reason
			}
		} else {
			// Legacy execution path not fully supported for synchronous /run yet, but we can try
			// For now, let's assume central compare is the way forward
			http.Error(w, "Synchronous run only supported for languages with central compare", http.StatusBadRequest)
			return
		}

		if runErr != nil {
			http.Error(w, "Execution failed: "+runErr.Error(), http.StatusInternalServerError)
			return
		}

		if result != nil {
			recordUsageAsync(usageEventsCollection, bson.M{
				"language":  lang.ID,
				"status":    result.Status,
				"elapsedMs": elapsedMsFromResult(result),
				"testCount": testCountFromResult(result, len(msg.Tests)),
				"source":    "run",
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(result)
	})

	mux.HandleFunc("/raw-run", handleRawRun(containerPool, executor, usageEventsCollection))

	server := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
	}

	go func() {
		slog.Info("Health/Stats/Run server starting", "port", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("Health server failed", "error", err)
		}
	}()

	go func() {
		<-ctx.Done()
		slog.Info("Shutting down health server...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(shutdownCtx)
	}()
}

func main() {
	// Initialize Structured Logging
	logLevel := slog.LevelInfo
	if envLevel := os.Getenv("LOG_LEVEL"); envLevel != "" {
		switch strings.ToLower(envLevel) {
		case "debug":
			logLevel = slog.LevelDebug
		case "info":
			logLevel = slog.LevelInfo
		case "warn":
			logLevel = slog.LevelWarn
		case "error":
			logLevel = slog.LevelError
		}
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))
	slog.SetDefault(logger)

	slog.Info("Go Judge Service starting...")

	// Load environment variables or use defaults
	rabbitmqURL := os.Getenv("RABBITMQ_URL")
	if rabbitmqPass := os.Getenv("RABBITMQ_PASS"); rabbitmqPass != "" {
		// Build the URI ourselves and let net/url percent-encode the credentials —
		// passwords with reserved characters (%, $, ^, @, ...) break naive
		// "amqp://user:pass@host" string interpolation (net/url: invalid userinfo).
		rabbitmqHost := os.Getenv("RABBITMQ_HOST")
		if rabbitmqHost == "" {
			rabbitmqHost = "rabbitmq"
		}
		rabbitmqPort := os.Getenv("RABBITMQ_PORT")
		if rabbitmqPort == "" {
			rabbitmqPort = "5672"
		}
		rabbitmqUser := os.Getenv("RABBITMQ_USER")
		if rabbitmqUser == "" {
			rabbitmqUser = "user"
		}
		u := &url.URL{
			Scheme: "amqp",
			User:   url.UserPassword(rabbitmqUser, rabbitmqPass),
			Host:   net.JoinHostPort(rabbitmqHost, rabbitmqPort),
		}
		rabbitmqURL = u.String()
	} else if rabbitmqURL == "" {
		rabbitmqURL = defaultRabbitMQURL
	}
	submissionQueueName := os.Getenv("SUBMISSION_QUEUE")
	if submissionQueueName == "" {
		submissionQueueName = defaultSubmissionQueue
	}
	mongoURI := os.Getenv("MONGO_URI")
	if mongoURI == "" {
		mongoURI = defaultMongoURI
	}
	// Must agree with assessment-api's env.MONGO_DB_NAME (config/env.js), which defaults
	// the same way — the two services share these collections, so a mismatch silently
	// splits them onto separate databases and leaves submissions stuck pending.
	mongoDBName := os.Getenv("MONGO_DB_NAME")
	if mongoDBName == "" {
		mongoDBName = defaultMongoDBName
	}
	redisURI := os.Getenv("REDIS_URI")
	if redisURI == "" {
		redisURI = defaultRedisURI
	}

	poolSize := defaultPoolSizePerLang
	if val := os.Getenv("DEFAULT_POOL_SIZE"); val != "" {
		if parsed, err := strconv.Atoi(val); err == nil && parsed > 0 {
			poolSize = parsed
			slog.Info("Using configured pool size", "size", poolSize)
		}
	}

	// Resolve each language's [Min, Max] pool bounds. With no JUDGE_POOL_MIN_*/MAX_* env
	// vars set, Min == Max == poolSize for every language — identical to pre-autoscaling
	// behavior. Max only matters once JUDGE_POOL_AUTOSCALE_ENABLED is on.
	poolConfigs := make(map[string]poolLangConfig, len(languages.GetSupportedLanguages()))
	sumMin := 0
	for _, lang := range languages.GetSupportedLanguages() {
		cfg := resolvePoolConfig(lang.ID, poolSize)
		poolConfigs[lang.ID] = cfg
		sumMin += cfg.Min
	}

	globalCap := getIntEnv("JUDGE_POOL_GLOBAL_CAP", defaultPoolGlobalCap)
	if sumMin > globalCap {
		slog.Error("sum of per-language pool minimums exceeds JUDGE_POOL_GLOBAL_CAP; refusing to start",
			"sumMin", sumMin, "globalCap", globalCap)
		os.Exit(1)
	}

	autoscaleEnabled := isTruthyEnv(os.Getenv("JUDGE_POOL_AUTOSCALE_ENABLED"))
	autoscaleCfg := pool.AutoscaleConfig{
		Interval:        getDurationSecondsEnv("JUDGE_POOL_AUTOSCALE_INTERVAL", defaultAutoscaleInterval),
		UpThresholdMs:   getFloatEnv("JUDGE_POOL_SCALE_UP_THRESHOLD_MS", defaultScaleUpThresholdMs),
		DownThresholdMs: getFloatEnv("JUDGE_POOL_SCALE_DOWN_THRESHOLD_MS", defaultScaleDownThresholdMs),
		UpCooldown:      getDurationSecondsEnv("JUDGE_POOL_SCALE_UP_COOLDOWN", defaultScaleUpCooldown),
		DownCooldown:    getDurationSecondsEnv("JUDGE_POOL_SCALE_DOWN_COOLDOWN", defaultScaleDownCooldown),
	}

	workerConcurrency := getIntEnv("JUDGE_WORKER_CONCURRENCY", defaultWorkerConcurrency)
	bulkContainerReserve = getIntEnv("JUDGE_INTERACTIVE_RESERVE", bulkContainerReserve)

	// Max executions per pooled container before eviction
	maxExecs := 100
	if val := os.Getenv("MAX_EXECUTIONS_PER_CONTAINER"); val != "" {
		if parsed, err := strconv.Atoi(val); err == nil && parsed > 0 {
			maxExecs = parsed
			slog.Info("Using configured max executions per container", "maxExecs", maxExecs)
		}
	}
	atomic.StoreInt32(&MaxExecutionsPerContainer, int32(maxExecs))

	// Initialize Docker Executor
	executor, err := executor.NewExecutor()
	failOnError(err, "Failed to create Docker executor")

	// Initialize Container Pool
	containerPool := pool.NewPool(executor.Client(), globalCap)
	slog.Info("Warming up container pool...", "globalCap", globalCap, "autoscaleEnabled", autoscaleEnabled)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Startup: remove any orphan containers left from previous runs
	if err := cleanupOrphanContainers(ctx, executor.Client()); err != nil {
		slog.Error("startup orphan container cleanup failed", "error", err)
	}

	workspace.StartSweeper(
		ctx,
		workspace.RootDir,
		5*time.Minute,
		time.Hour,
	)

	var wg sync.WaitGroup
	for _, lang := range languages.GetSupportedLanguages() {
		wg.Add(1)
		go func(l *languages.Language) {
			defer wg.Done()
			cfg := poolConfigs[l.ID]
			slog.Info("Warming up pool", "language", l.ID, "min", cfg.Min, "max", cfg.Max)
			err := containerPool.WarmUp(ctx, l.ID, l.Image, cfg.Min, cfg.Max)
			if err != nil {
				slog.Error("Failed to warm up pool", "language", l.ID, "error", err)
			}
		}(lang)
	}
	wg.Wait()
	slog.Info("Container pool warmed up.")

	containerPool.StartMonitor(ctx, time.Minute)

	// Start periodic GC to remove exited/dead judge-managed containers every 5 minutes
	StartPeriodicOrphanGC(ctx, executor.Client(), 5*time.Minute)

	// Start pool reconciler to keep pool sizes stable (self-healing safety net — this runs
	// regardless of autoscaling, converging each language's live count to its current target).
	containerPool.StartReconciler(ctx, time.Minute)

	// Autoscaling ships disabled by default (JUDGE_POOL_AUTOSCALE_ENABLED unset/false) — the
	// static per-language Min/Max above already improves on one global pool size even with
	// this off, and turning it on is a deliberate operator decision once the wait-time signal
	// (see /stats -> metrics.acquire_wait) has been observed to look sane.
	if autoscaleEnabled {
		slog.Info("Pool autoscaling enabled", "interval", autoscaleCfg.Interval,
			"upThresholdMs", autoscaleCfg.UpThresholdMs, "downThresholdMs", autoscaleCfg.DownThresholdMs,
			"upCooldown", autoscaleCfg.UpCooldown, "downCooldown", autoscaleCfg.DownCooldown)
		containerPool.StartAutoscaler(ctx, autoscaleCfg)
	} else {
		slog.Info("Pool autoscaling disabled (JUDGE_POOL_AUTOSCALE_ENABLED not set)")
	}

	// Connect to MongoDB
	mongoClient, err := mongo.Connect(ctx, options.Client().ApplyURI(mongoURI))
	failOnError(err, "Failed to connect to MongoDB")
	defer func() {
		if err = mongoClient.Disconnect(context.Background()); err != nil {
			slog.Error("Error disconnecting from MongoDB", "error", err)
		}
	}()

	problemsCollection := mongoClient.Database(mongoDBName).Collection("problems")
	submissionsCollection := mongoClient.Database(mongoDBName).Collection("submissions")
	// Collection name matches the default Mongoose pluralization of the "UsageEvent"
	// model in assessment-api/models/UsageEvent.mjs, so both sides agree on it without
	// either one owning the write path exclusively.
	usageEventsCollection := mongoClient.Database(mongoDBName).Collection("usageevents")

	// Start Health/Stats/Run Server
	healthPort := os.Getenv("HEALTH_PORT")
	if healthPort == "" {
		healthPort = "8081"
	}
	startHealthServer(ctx, containerPool, healthPort, problemsCollection, usageEventsCollection, executor)

	// Initialize Redis Client
	redisPass := os.Getenv("REDIS_PASS")
	redisHost := os.Getenv("REDIS_HOST")
	if redisHost == "" {
		redisHost = "redis:6379"
	}
	var redisOpt *redis.Options
	if redisPass != "" {
		redisOpt = &redis.Options{
			Addr:     redisHost,
			Password: redisPass,
		}
	} else if strings.HasPrefix(redisURI, "redis://") {
		var parseErr error
		redisOpt, parseErr = redis.ParseURL(redisURI)
		if parseErr != nil {
			slog.Warn("Failed to parse REDIS_URI with ParseURL, falling back", "error", parseErr)
			redisOpt = &redis.Options{Addr: strings.TrimPrefix(redisURI, "redis://")}
		}
	} else {
		redisOpt = &redis.Options{Addr: redisURI}
	}

	redisClient := redis.NewClient(redisOpt)
	_, err = redisClient.Ping(ctx).Result()
	failOnError(err, "Failed to connect to Redis")

	// Connect to RabbitMQ
	conn, err := amqp.Dial(rabbitmqURL)
	failOnError(err, "Failed to connect to RabbitMQ")
	defer conn.Close()

	ch, err := conn.Channel()
	failOnError(err, "Failed to open a channel")
	defer ch.Close()

	// Prefetch count matches worker concurrency below rather than runtime.NumCPU(): these
	// workers spend most of their time blocked on Docker API calls (compile/run), not local
	// Go CPU work, so sizing this to the host's core count under-provisions an I/O-bound pool.
	err = ch.Qos(workerConcurrency, 0, false)
	failOnError(err, "Failed to set QoS")

	// Declare DLX and DLQ
	dlxName := "submission_dlx"
	dlqName := "submission_dead_letters"
	err = ch.ExchangeDeclare(dlxName, "direct", true, false, false, false, nil)
	failOnError(err, "Failed to declare DLX")
	_, err = ch.QueueDeclare(dlqName, true, false, false, false, nil)
	failOnError(err, "Failed to declare DLQ")
	err = ch.QueueBind(dlqName, "", dlxName, false, nil)
	failOnError(err, "Failed to bind DLQ")

	_, err = ch.QueueDeclare(
		submissionQueueName, // name
		true,                // durable
		false,               // delete when unused
		false,               // exclusive
		false,               // no-wait
		amqp.Table{
			"x-dead-letter-exchange": dlxName,
		}, // arguments
	)
	failOnError(err, "Failed to declare submission queue")

	// Declare a retry queue with TTL and DLX
	retryQueueName := submissionQueueName + "_retry"
	_, err = ch.QueueDeclare(
		retryQueueName,
		true,
		false,
		false,
		false,
		amqp.Table{
			"x-dead-letter-exchange":    "",
			"x-dead-letter-routing-key": submissionQueueName,
			"x-message-ttl":             5000, // 5 seconds wait before retry
		},
	)
	failOnError(err, "Failed to declare retry queue")

	// A second queue for latency-sensitive work: a caller waiting synchronously on a
	// result (the GO Judge public API surface with wait=true) should not queue behind a
	// bulk backlog it has nothing to do with.
	//
	// A separate queue rather than x-max-priority on the existing one, because adding
	// that argument to an already-declared queue fails with PRECONDITION_FAILED and
	// takes publishing down until someone deletes the queue by hand. This is purely
	// additive, so a judge running this code against an older broker, or an older judge
	// against this one, both keep working.
	interactiveQueueName := submissionQueueName + "_fast"
	_, err = ch.QueueDeclare(
		interactiveQueueName,
		true,
		false,
		false,
		false,
		amqp.Table{
			"x-dead-letter-exchange": dlxName,
		},
	)
	failOnError(err, "Failed to declare interactive submission queue")

	// Its own retry queue, dead-lettering back to the interactive queue: sending these
	// retries to the bulk retry queue would quietly demote a waiting caller to bulk
	// priority the first time no container was free.
	interactiveRetryQueueName := interactiveQueueName + "_retry"
	_, err = ch.QueueDeclare(
		interactiveRetryQueueName,
		true,
		false,
		false,
		false,
		amqp.Table{
			"x-dead-letter-exchange":    "",
			"x-dead-letter-routing-key": interactiveQueueName,
			"x-message-ttl":             5000,
		},
	)
	failOnError(err, "Failed to declare interactive retry queue")

	// Registered before consuming so a connection loss at any point after this is seen.
	connClosed := conn.NotifyClose(make(chan *amqp.Error, 1))
	chClosed := ch.NotifyClose(make(chan *amqp.Error, 1))

	msgs, err := ch.Consume(
		submissionQueueName, // queue
		bulkConsumerTag,     // consumer
		false,               // auto-ack
		false,               // exclusive
		false,               // no-local
		false,               // no-wait
		nil,                 // args
	)
	failOnError(err, "Failed to register a consumer")

	interactiveMsgs, err := ch.Consume(
		interactiveQueueName,
		interactiveConsumerTag,
		false,
		false,
		false,
		false,
		nil,
	)
	failOnError(err, "Failed to register the interactive consumer")

	slog.Info("Waiting for messages", "queue", submissionQueueName, "interactiveQueue", interactiveQueueName)

	// Graceful Shutdown implementation
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	workerWg := sync.WaitGroup{}
	numWorkers := workerConcurrency
	slog.Info("Starting submission workers", "count", numWorkers)

	for i := 0; i < numWorkers; i++ {
		workerWg.Add(1)
		go func(workerID int) {
			defer workerWg.Done()
			slog.Debug("Worker started", "workerId", workerID)
			for d := range msgs {
				if returnIfShuttingDown(d) {
					continue
				}
				processSubmission(false, d, ch, retryQueueName, problemsCollection, submissionsCollection, usageEventsCollection, redisClient, executor, containerPool)
			}
			slog.Debug("Worker stopped", "workerId", workerID)
		}(i)
	}

	// Interactive work gets its own workers rather than sharing the bulk ones: when every
	// shared worker is busy or blocked waiting for a container on bulk work, a priority
	// queue is never even read. These are in addition to numWorkers, not carved out of
	// it, so bulk throughput is unchanged; they spend nearly all their time blocked on
	// the sandbox, not on CPU.
	interactiveWorkers := getIntEnv("JUDGE_INTERACTIVE_WORKERS", defaultInteractiveWorkers)
	slog.Info("Starting interactive workers", "count", interactiveWorkers, "bulkContainerReserve", bulkContainerReserve)
	for i := 0; i < interactiveWorkers; i++ {
		workerWg.Add(1)
		go func(workerID int) {
			defer workerWg.Done()
			for d := range interactiveMsgs {
				if returnIfShuttingDown(d) {
					continue
				}
				processSubmission(true, d, ch, interactiveRetryQueueName, problemsCollection, submissionsCollection, usageEventsCollection, redisClient, executor, containerPool)
			}
		}(i)
	}

	consumersHealthy.Store(true)

	// Every worker loop ends if its delivery channel closes, which happens on a connection
	// or channel loss, or if the broker cancels a consumer (for example its queue was
	// deleted). Either way this process is no longer judging anything.
	workersDone := make(chan struct{})
	go func() {
		workerWg.Wait()
		close(workersDone)
	}()

	// There is no in-process reconnect. On losing RabbitMQ the judge exits non-zero and the
	// container restart policy brings up a fresh one; unacked messages are redelivered to it
	// (processAndStoreResults does not double-count a delivery that had already finished).
	// Exiting is simpler and safer than rebuilding the channel, consumers and worker loops
	// in place, and staying up without consumers is the one outcome that must not happen.
	exitLostBroker := func(reason string, amqpErr *amqp.Error) {
		consumersHealthy.Store(false)
		slog.Error("Lost RabbitMQ; exiting so the container restarts", "reason", reason, "error", amqpErr)
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		containerPool.Shutdown(cleanupCtx)
		cleanupCancel()
		os.Exit(1)
	}

	select {
	case sig := <-sigChan:
		slog.Info("Received signal, shutting down...", "signal", sig.String())
	case amqpErr := <-connClosed:
		exitLostBroker("connection closed", amqpErr)
	case amqpErr := <-chClosed:
		exitLostBroker("channel closed", amqpErr)
	case <-workersDone:
		exitLostBroker("all consumers stopped", nil)
	}
	consumersHealthy.Store(false)
	shuttingDown.Store(true)

	// 1. Stop consuming. Cancelling a consumer closes its delivery channel once the
	// deliveries already buffered for it have been handed out, which ends the worker loops.
	for _, tag := range []string{bulkConsumerTag, interactiveConsumerTag} {
		if err := ch.Cancel(tag, false); err != nil {
			slog.Error("Error cancelling consumer", "consumer", tag, "error", err)
		}
	}

	// 2. Wait for active workers to finish
	slog.Info("Waiting for active workers to finish...")
	<-workersDone

	// 3. Cleanup pool
	slog.Info("Cleaning up container pool...")
	containerPool.Shutdown(context.Background())

	slog.Info("Shutdown complete.")
}
