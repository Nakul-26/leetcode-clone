package models

import (
	"errors"
	"regexp"
	"strings"
)

type SubmissionMessage struct {
	SchemaVersion string      `json:"schemaVersion"`
	SubmissionID  string      `json:"submissionId"`
	ProblemID     string      `json:"problemId"`
	Language      string      `json:"language"`
	Code          string      `json:"code"`
	Tests         []TestCase  `json:"tests"`
	ProblemType   ProblemType `json:"problemType,omitempty"`
	FunctionName  string      `json:"functionName"`
	Parameters    []Parameter `json:"parameters,omitempty"`
	ReturnType    string      `json:"returnType,omitempty"`
	CompareMode   string      `json:"compareMode,omitempty"`
	CompareConfig CompareConfig `json:"compareConfig,omitempty"`
	RequestID     string      `json:"requestId,omitempty"`
	RetryCount    int         `json:"retryCount,omitempty"`
	CollegeID     string      `json:"collegeId,omitempty"`
	// Which external API key produced this submission, so usage can be attributed
	// to a paying customer (plan Phase 1). Empty for frontend traffic and for
	// callers still authenticating with a legacy global shared secret.
	ApiClientID   string      `json:"apiClientId,omitempty"`
}

// Limits — tweak as needed
const (
	MaxCodeBytes     = 200 * 1024      // 200KB max source size
	MaxTestsBytes    = 1 * 1024 * 1024 // 1MB max tests JSON when marshalled
	MaxFuncNameLen   = 128
	MinSchemaVersion = "1"
	// MaxSubmissionRetries bounds how many times a submission can bounce through the
	// retry queue (e.g. waiting for a free pool container) before it's surfaced as a
	// failure instead of looping forever. At the retry queue's 5s TTL, this is a ~60s window.
	MaxSubmissionRetries = 12
)

// valid identifier for function/class names: starts with letter or underscore, then letters/digits/underscores
var validIdent = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// Validate checks required fields and simple limits. Returns nil if ok.
func (sm *SubmissionMessage) Validate() error {
	if sm.SchemaVersion == "" {
		return errors.New("schemaVersion is required")
	}
	// Optionally enforce schema version compatibility:
	// if sm.SchemaVersion != "v1" { return fmt.Errorf("unsupported schemaVersion: %s", sm.SchemaVersion) }

	if sm.SubmissionID == "" {
		return errors.New("submissionId is required")
	}
	if sm.ProblemID == "" {
		return errors.New("problemId is required")
	}
	if sm.Language == "" {
		return errors.New("language is required")
	}
	if sm.Code == "" {
		return errors.New("code is required")
	}
	if len(sm.Code) > MaxCodeBytes {
		return errors.New("code size exceeds maximum allowed")
	}
	// Basic tests size check — best-effort: marshal and check bytes
	if sm.Tests != nil {
		// Note: avoid importing encoding/json here in hot path; main can re-check sizes later.
		// But a lightweight check on number of testcases is useful:
		if len(sm.Tests) > 2000 {
			return errors.New("too many test cases")
		}
	}
	if sm.EffectiveType() != StdinProblem {
		if sm.FunctionName == "" {
			return errors.New("functionName is required")
		}
		// If function name looks too long or invalid, reject — provider can sanitize instead.
		if len(sm.FunctionName) > MaxFuncNameLen {
			return errors.New("functionName too long")
		}
	}
	return nil
}

// SanitizeFunctionName returns a sanitized identifier that is safe to embed in code.
// It returns sanitized name and a boolean indicating whether the original was already valid.
func (sm *SubmissionMessage) SanitizeFunctionName() (string, bool) {
	name := sm.FunctionName
	if validIdent.MatchString(name) {
		return name, true
	}
	// Replace invalid characters with underscore
	sanitized := regexp.MustCompile(`[^A-Za-z0-9_]`).ReplaceAllString(name, "_")
	// Ensure starts with letter/underscore
	if !regexp.MustCompile(`^[A-Za-z_]`).MatchString(sanitized) {
		sanitized = "f_" + sanitized
	}
	// Trim length
	if len(sanitized) > MaxFuncNameLen {
		sanitized = sanitized[:MaxFuncNameLen]
	}
	// store back or caller can set
	sanitized = strings.TrimRight(sanitized, "_")
	return sanitized, false
}
