package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
)

// JUDGE_IO_MARKER

// The generated call asks for the test's captured stdout just before printing its result; only
// the batch wrapper captures it.
func judgeStdout() *string { return nil }

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Missing input payload\n")
		os.Exit(1)
	}

	decoded, err := base64.StdEncoding.DecodeString(os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to decode payload: %v\n", err)
		os.Exit(1)
	}

	var payload struct {
		Inputs []json.RawMessage `json:"inputs"`
	}
	if err := json.Unmarshal(decoded, &payload); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to parse payload: %v\n", err)
		os.Exit(1)
	}

	var result struct {
		Output interface{} `json:"output"`
		Error  string      `json:"error,omitempty"`
		Stdout *string     `json:"stdout,omitempty"`
	}

	defer func() {
		if r := recover(); r != nil {
			result.Error = "Runtime Error"
			fmt.Fprintf(os.Stderr, "{\"error\": \"Runtime Error\", \"message\": \"%v\"}\n", r)
			os.Exit(0)
		}
	}()

	// GENERATED_CALL_MARKER
}
