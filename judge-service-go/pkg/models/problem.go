package models

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"

	"judge-service-go/pkg/types"

	"go.mongodb.org/mongo-driver/bson/primitive"
)

// TestCase defines the structure for a single test case.
type TestCase struct {
	Input    []interface{} `json:"inputs" bson:"inputs"`
	Expected interface{}   `json:"expected" bson:"expected"`
	IsSample bool          `json:"isSample" bson:"isSample,omitempty"`
	IsHidden bool          `json:"isHidden" bson:"isHidden,omitempty"`
}

type Parameter struct {
	Name string `json:"name" bson:"name"`
	Type string `json:"type" bson:"type"`
}

type CompareConfig struct {
	Mode             string  `json:"mode" bson:"mode"`
	FloatTolerance   float64 `json:"floatTolerance" bson:"floatTolerance"`
	OrderInsensitive bool    `json:"orderInsensitive" bson:"orderInsensitive"`
	// RequireDeepCopy indicates that the result must be a deep copy of input structures
	RequireDeepCopy  bool    `json:"requireDeepCopy" bson:"requireDeepCopy,omitempty"`
}

// Problem defines the structure for a programming problem.
type Problem struct {
	ID            primitive.ObjectID `json:"_id" bson:"_id,omitempty"`
	Title         string             `json:"title" bson:"title"`
	Description   string             `json:"description" bson:"description"`
	Difficulty    string             `json:"difficulty" bson:"difficulty"`
	Type          ProblemType        `json:"problemType,omitempty" bson:"problemType,omitempty"`
	FunctionName  string             `json:"functionName" bson:"functionName"`
	Parameters    []Parameter        `json:"parameters,omitempty" bson:"parameters,omitempty"`
	ReturnType    string             `json:"returnType,omitempty" bson:"returnType,omitempty"`
	TimeLimitMs   int64              `json:"timeLimitMs,omitempty" bson:"timeLimitMs,omitempty"`
	MemoryLimitMb int64              `json:"memoryLimitMb,omitempty" bson:"memoryLimitMb,omitempty"`
	CompareConfig CompareConfig      `json:"compareConfig,omitempty" bson:"compareConfig,omitempty"`
	TestCases     []TestCase         `json:"testCases,omitempty" bson:"testCases,omitempty"`
	TestsJSON     json.RawMessage    `json:"testsJSON,omitempty" bson:"testsJSON,omitempty"` // store raw JSON (safer)
	Tags          []string           `json:"tags,omitempty" bson:"tags,omitempty"`
	IsPremium     bool               `json:"isPremium,omitempty" bson:"isPremium,omitempty"`
	CreatedAt     primitive.DateTime `json:"createdAt,omitempty" bson:"createdAt,omitempty"`
}

// ParseTestsJSON attempts to populate p.TestCases from p.TestsJSON if TestCases is empty.
// Returns error on invalid JSON.
func (p *Problem) ParseTestsJSON() error {
	if len(p.TestsJSON) == 0 {
		// nothing to parse
		return nil
	}
	var cases []TestCase
	if err := json.Unmarshal(p.TestsJSON, &cases); err == nil {
		p.TestCases = cases
		return nil
	}
	// fallback: sometimes the tests JSON is an array of arrays [ [inputs], expected ]
	// Try to unmarshal to generic array and convert
	var generic []interface{}
	if err := json.Unmarshal(p.TestsJSON, &generic); err != nil {
		return fmt.Errorf("failed to unmarshal tests JSON: %w", err)
	}
	// Convert to TestCase slice
	cases = make([]TestCase, 0, len(generic))
	for _, item := range generic {
		// item is expected to be [inputs, expectedOutput] or {"input":..., "expectedOutput":...}
		switch v := item.(type) {
		case map[string]interface{}:
			// object form
			inputKey := "inputs"
			if _, ok := v[inputKey]; !ok {
				inputKey = "input"
			}
			inputIntf, _ := v[inputKey].([]interface{})
			expectedKey := "expected"
			if _, ok := v[expectedKey]; !ok {
				expectedKey = "expectedOutput"
			}
			tc := TestCase{
				Input:    normalizeNumbers(inputIntf),
				Expected: normalizeValue(v[expectedKey]),
			}
			// try to extract isHidden if present
			if b, ok := v["isHidden"].(bool); ok {
				tc.IsHidden = b
			}
			if b, ok := v["isSample"].(bool); ok {
				tc.IsSample = b
			}
			cases = append(cases, tc)
		case []interface{}:
			// array form: [inputArray, expectedOutput, (optional) isHidden]
			if len(v) >= 2 {
				// first element expected to be []interface{}
				inputArr := []interface{}{}
				if arr, ok := v[0].([]interface{}); ok {
					inputArr = normalizeNumbers(arr)
				}
				expected := normalizeValue(v[1])
				tc := TestCase{
					Input:    inputArr,
					Expected: expected,
				}
				if len(v) >= 3 {
					if b, ok := v[2].(bool); ok {
						tc.IsHidden = b
					}
				}
				cases = append(cases, tc)
			}
		default:
			// unsupported type; skip
		}
	}
	p.TestCases = cases
	return nil
}

// normalizeNumbers converts JSON-decoded numbers (float64) to int64 when they look like integers.
// This helps when users provide numbers expecting ints.
func normalizeNumbers(arr []interface{}) []interface{} {
	if arr == nil {
		return nil
	}
	out := make([]interface{}, len(arr))
	for i, v := range arr {
		out[i] = normalizeValue(v)
	}
	return out
}

func normalizeValue(v interface{}) interface{} {
	switch vv := v.(type) {
	case float64:
		if isWholeNumber(vv) {
			// convert to int64 if safe
			return int64(vv)
		}
		return vv
	case []interface{}:
		return normalizeNumbers(vv)
	case map[string]interface{}:
		// recursively normalize values inside objects
		m := make(map[string]interface{}, len(vv))
		for k, val := range vv {
			m[k] = normalizeValue(val)
		}
		return m
	default:
		// leave as-is for strings, bools, nil etc.
		return vv
	}
}

func isWholeNumber(f float64) bool {
	return math.Mod(f, 1.0) == 0
}

// ValidateBasic performs quick validation on the Problem structure and returns an error with details.
func (p *Problem) ValidateBasic() error {
	if p.Title == "" {
		return errors.New("title is required")
	}
	if p.Description == "" {
		return errors.New("description is required")
	}
	if p.EffectiveType() != StdinProblem {
		if p.FunctionName == "" {
			return errors.New("functionName is required")
		}
		if p.ReturnType == "" {
			return errors.New("returnType is required")
		}
		if !types.IsValid(p.ReturnType) {
			return fmt.Errorf("invalid returnType: %s", p.ReturnType)
		}
		for _, param := range p.Parameters {
			if param.Name == "" || param.Type == "" {
				return fmt.Errorf("invalid parameter: %+v", param)
			}
			if !types.IsValid(param.Type) {
				return fmt.Errorf("invalid type for parameter %s: %s", param.Name, param.Type)
			}
		}
	}
	// Parse tests if needed
	if len(p.TestCases) == 0 && len(p.TestsJSON) > 0 {
		if err := p.ParseTestsJSON(); err != nil {
			return fmt.Errorf("failed to parse tests JSON: %w", err)
		}
	}

	// Basic check: each test's input length should match expected input params (if known)
	if len(p.Parameters) > 0 {
		for i, tc := range p.TestCases {
			if len(tc.Input) != len(p.Parameters) {
				return fmt.Errorf("test %d: input length %d does not match expected params %d", i, len(tc.Input), len(p.Parameters))
			}
		}
	}

	// Stdin-mode test cases carry raw stdin/stdout text rather than typed
	// parameter values: Input holds exactly one string element (the full
	// stdin blob), Expected is the expected stdout text. Enforced here so a
	// malformed test case fails as bad problem data, not as a runtime type
	// assertion panic in the stdin runner.
	if p.EffectiveType() == StdinProblem {
		for i, tc := range p.TestCases {
			if len(tc.Input) != 1 {
				return fmt.Errorf("test %d: stdin problems require exactly one input element (the stdin text), got %d", i, len(tc.Input))
			}
			if _, ok := tc.Input[0].(string); !ok {
				return fmt.Errorf("test %d: stdin input must be a string", i)
			}
			// A nil Expected is allowed and means "no expected output": the
			// program is run and its stdout reported rather than judged. That is
			// what a Judge0-style caller needs — Judge0's expected_output is
			// optional and the caller usually compares results itself — so an
			// ad-hoc API submission has stdin but nothing to compare against.
			if tc.Expected != nil {
				if _, ok := tc.Expected.(string); !ok {
					return fmt.Errorf("test %d: stdin expected output must be a string or absent", i)
				}
			}
		}
	}
	return nil
}
