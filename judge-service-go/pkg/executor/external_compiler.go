package executor

import (
	"context"
	"time"
)

// ExternalCompiler compiles some programs outside the sandbox (pkg/compilesvc: a resident
// javac). Compile returns handled=false for anything it does not take, and the sandbox
// compiles it as before. When handled, exitCode and output are the compiler's (output as the
// compiler would print it on stderr), and on success outFiles are the files it wrote into
// hostWorkDir, which go into the sandbox next to the sources.
type ExternalCompiler interface {
	Compile(ctx context.Context, compileCmd []string, hostWorkDir string, files []string) (handled bool, outFiles []string, exitCode int, output string)
}

// SetExternalCompiler installs one (nil removes it).
func (e *Executor) SetExternalCompiler(c ExternalCompiler) { e.ext = c }

// compileExternally runs compileCmd in the external compiler if it takes it. A failure is the
// same error CompileInContainer returns for the sandbox's own compile, so the result reads the
// same.
func (e *Executor) compileExternally(ctx context.Context, compileCmd []string, hostWorkDir string, files []string) (handled bool, outFiles []string, output string, err error) {
	if e.ext == nil || len(compileCmd) == 0 {
		return false, nil, "", nil
	}
	start := time.Now()
	handled, outFiles, exitCode, output := e.ext.Compile(ctx, compileCmd, hostWorkDir, files)
	if !handled {
		return false, nil, "", nil
	}
	recordSince("external_compile", start)
	if exitCode != 0 {
		return true, nil, output, NewExecutionError(ErrCompilationFailed, exitError(exitCode, output).Error(), -1)
	}
	return true, outFiles, output, nil
}
