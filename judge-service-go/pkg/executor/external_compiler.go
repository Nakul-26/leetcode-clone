package executor

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"judge-service-go/pkg/metrics"
	"judge-service-go/pkg/workspace"
)

// ExternalCompiler compiles some programs outside the sandbox (pkg/compilesvc: a resident
// javac). Compile returns handled=false for anything it does not take, and the sandbox
// compiles it as before. When handled, exitCode and output are the compiler's (output as the
// compiler would print it on stderr), and on success outFiles are the files it wrote into
// hostWorkDir, which go into the sandbox next to the sources.
type ExternalCompiler interface {
	Compile(ctx context.Context, compileCmd []string, hostWorkDir string, files []string) (handled bool, outFiles []string, exitCode int, output string)
}

// CompileBeforeAcquire prepares externally compiled artifacts without needing a sandbox.
// Implementations must return handled=false when the existing sandbox path is required.
type PreAcquireExternalCompiler interface {
	CompileBeforeAcquire(ctx context.Context, compileCmd []string, hostWorkDir string, files []string) (handled bool, outFiles []string, exitCode int, output string)
}

// SetExternalCompiler installs one (nil removes it).
func (e *Executor) SetExternalCompiler(c ExternalCompiler) { e.ext = c }

// CompileBeforeAcquire enables a safe external compiler to prepare files before sandbox
// acquisition. The caller retains its workspace through execution and cleanup.
func (e *Executor) CompileBeforeAcquire(ctx context.Context, compileCmd []string, hostWorkDir string, files []string) (handled bool, outFiles []string, output string, err error) {
	precompiler, ok := e.ext.(PreAcquireExternalCompiler)
	if !ok || len(compileCmd) == 0 {
		return false, nil, "", nil
	}
	handled, outFiles, exitCode, output := precompiler.CompileBeforeAcquire(ctx, compileCmd, hostWorkDir, files)
	if !handled {
		return false, nil, "", nil
	}
	if exitCode != 0 {
		return true, nil, output, NewExecutionError(ErrCompilationFailed, exitError(exitCode, output).Error(), -1)
	}
	return true, outFiles, output, nil
}

// compileExternally runs compileCmd in the external compiler if it takes it. A failure is the
// same error CompileInContainer returns for the sandbox's own compile, so the result reads the
// same.
func (e *Executor) compileExternally(ctx context.Context, containerID string, compileCmd []string, hostWorkDir string, files []string) (handled bool, outFiles []string, output string, err error) {
	if e.ext == nil || len(compileCmd) == 0 {
		return false, nil, "", nil
	}
	// Keep external results in the same bounded LRU as sandbox results. The
	// backend identity separates -proc:none service output from sandbox javac.
	key := ""
	compilerImage := ""
	if e.cc != nil && compileCmd[0] == "javac" {
		if identity, ok := e.ext.(interface{ CacheIdentity() (string, error) }); ok {
			if image, err := identity.CacheIdentity(); err == nil && image != "" {
				if sourceKey, ok := e.compileKey(containerID, hostWorkDir, files, compileCmd); ok {
					compilerImage = image
					key = "external-v1:" + image + ":" + sourceKey
					if data, diagnostics, hit := e.cc.getWithOutput(key); hit {
						if names, err := restoreExternalFiles(hostWorkDir, data); err == nil {
							e.cc.hits.Add(1)
							return true, names, diagnostics, nil
						}
					}
					e.cc.misses.Add(1)
				}
			}
		}
	}
	start := time.Now()
	handled, outFiles, exitCode, output := e.ext.Compile(ctx, compileCmd, hostWorkDir, files)
	if !handled {
		return false, nil, "", nil
	}
	recordSince("external_compile", start)
	metrics.RecordStage(ctx, "external_compile", time.Since(start))
	if exitCode != 0 {
		return true, nil, output, NewExecutionError(ErrCompilationFailed, exitError(exitCode, output).Error(), -1)
	}
	if key != "" && len(outFiles) > 0 {
		// A crash/restart during compilation can resolve a rebuilt image tag.
		// Never store its artifacts under the previous compiler's identity.
		identity := e.ext.(interface{ CacheIdentity() (string, error) })
		currentImage, identityErr := identity.CacheIdentity()
		if identityErr != nil || currentImage != compilerImage {
			return true, outFiles, output, nil
		}

		if data, err := buildWorkspaceTar(hostWorkDir, outFiles); err == nil && len(data) <= compileCacheEntryMax {
			if validateCacheTar(data) == nil {
				e.cc.putWithOutput(key, data, output)
			}
		}
	}
	return true, outFiles, output, nil
}

// Only compiler-created class files are restored; validate the whole archive
// before writing anything, and use the workspace's symlink-safe path helpers.
func restoreExternalFiles(dir string, data []byte) ([]string, error) {
	if err := validateCacheTar(data); err != nil {
		return nil, err
	}
	if err := workspace.ValidateNoExternalSymlinks(dir); err != nil {
		return nil, err
	}
	tr := tar.NewReader(bytes.NewReader(data))
	var names []string
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return names, nil
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag == tar.TypeDir {
			continue
		}
		if !strings.HasSuffix(h.Name, ".class") {
			return nil, fmt.Errorf("not a class file: %s", h.Name)
		}
		target, err := workspace.SafeJoin(dir, h.Name)
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return nil, err
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			return nil, err
		}
		if err := workspace.WriteFile(dir, h.Name, b, 0o644); err != nil {
			return nil, err
		}
		names = append(names, h.Name)
	}
}
