package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// JUDGE_IO_MARKER

// What a test prints (JUDGE_FIX_PLAN T5): os.Stdout is a pipe while the test runs, read into
// a buffer kept up to just past the judge's output limit (64 KB), so a print loop cannot fill
// memory; the judge fails a test that goes over with Output Limit Exceeded.
const judgeStdoutCap = 64*1024 + 1

type judgeCapture struct {
	real *os.File
	w    *os.File
	done chan string
	out  *string
}

var judgeCurrent *judgeCapture

func judgeBeginCapture() {
	r, w, err := os.Pipe()
	if err != nil {
		judgeCurrent = nil
		return
	}
	c := &judgeCapture{real: os.Stdout, w: w, done: make(chan string, 1)}
	go func() {
		buf := make([]byte, 0, 4096)
		chunk := make([]byte, 32*1024)
		for {
			n, err := r.Read(chunk)
			if n > 0 && len(buf) < judgeStdoutCap {
				room := judgeStdoutCap - len(buf)
				if n < room {
					room = n
				}
				buf = append(buf, chunk[:room]...)
			}
			if err != nil {
				break
			}
		}
		_, _ = io.Copy(io.Discard, r)
		r.Close()
		c.done <- string(buf)
	}()
	os.Stdout = w
	judgeCurrent = c
}

// judgeStdout ends the capture and returns what the test printed. Called by the generated
// code just before it prints the result, and again (as a no-op) when the test finishes.
func judgeStdout() *string {
	c := judgeCurrent
	if c == nil {
		return nil
	}
	if c.out == nil {
		os.Stdout = c.real
		c.w.Close()
		s := <-c.done
		c.out = &s
	}
	return c.out
}

func judgeEmit(v interface{}) {
	b, _ := json.Marshal(v)
	fmt.Fprintln(os.Stderr, string(b))
}

// runTest runs one test and makes sure it reports exactly one result line: the generated call
// prints it, a panic is reported as a runtime error, and a call that returned early without
// printing (an input it could not read) is reported too.
func runTest(test int, payload struct {
	Inputs []json.RawMessage `json:"inputs"`
}) {
	var result struct {
		Test   int         `json:"test"`
		Output interface{} `json:"output"`
		Error  string      `json:"error,omitempty"`
		Stdout *string     `json:"stdout,omitempty"`
	}
	result.Test = test
	judgeBeginCapture()
	defer func() {
		r := recover()
		printed := judgeCurrent != nil && judgeCurrent.out != nil
		stdout := judgeStdout()
		switch {
		case r != nil:
			judgeEmit(map[string]interface{}{"test": test, "error": "Runtime Error", "traceback": fmt.Sprint(r), "stdout": stdout})
		case !printed && judgeCurrent != nil:
			judgeEmit(map[string]interface{}{"test": test, "error": "Runtime Error", "traceback": "could not read the test input", "stdout": stdout})
		}
		judgeCurrent = nil
	}()

	// GENERATED_CALL_MARKER
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, `{"fatal": "missing tests payload"}`)
		os.Exit(1)
	}
	decoded, err := base64.StdEncoding.DecodeString(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, `{"fatal": "unreadable tests payload"}`)
		os.Exit(1)
	}
	var tests []struct {
		Inputs []json.RawMessage `json:"inputs"`
	}
	if err := json.Unmarshal(decoded, &tests); err != nil {
		fmt.Fprintln(os.Stderr, `{"fatal": "unreadable tests payload"}`)
		os.Exit(1)
	}
	for i, t := range tests {
		runTest(i+1, t)
	}
}
