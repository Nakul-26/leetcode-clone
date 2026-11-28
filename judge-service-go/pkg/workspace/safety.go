package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func CopyWorkspaceFiles(source, destination string, names []string) error {
	for _, name := range names {
		data, info, err := ReadRegularFile(source, name)
		if err != nil {
			return err
		}
		if err := WriteFile(destination, name, data, info.Mode().Perm()); err != nil {
			return err
		}
	}
	return nil
}

func SafeJoin(base, name string) (string, error) {
	if filepath.IsAbs(name) {
		return "", fmt.Errorf("absolute paths are not allowed: %q", name)
	}

	baseAbs, err := filepath.Abs(base)
	if err != nil {
		return "", fmt.Errorf("resolve base path: %w", err)
	}

	targetAbs := filepath.Clean(filepath.Join(baseAbs, name))
	if !isWithinBase(baseAbs, targetAbs) {
		return "", fmt.Errorf("path escape detected for %q", name)
	}

	return targetAbs, nil
}

func WriteFile(base, name string, data []byte, perm os.FileMode) error {
	targetPath, err := SafeJoin(base, name)
	if err != nil {
		return err
	}

	if err := rejectSymlink(targetPath); err != nil {
		return err
	}

	return os.WriteFile(targetPath, data, perm)
}

func ReadRegularFile(base, name string) ([]byte, os.FileInfo, error) {
	targetPath, err := SafeJoin(base, name)
	if err != nil {
		return nil, nil, err
	}

	info, err := os.Lstat(targetPath)
	if err != nil {
		return nil, nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, nil, fmt.Errorf("symlinked file is not allowed: %s", targetPath)
	}
	if !info.Mode().IsRegular() {
		return nil, nil, fmt.Errorf("non-regular file is not allowed: %s", targetPath)
	}

	data, err := os.ReadFile(targetPath)
	if err != nil {
		return nil, nil, err
	}

	return data, info, nil
}

func ValidateNoExternalSymlinks(base string) error {
	baseAbs, err := filepath.Abs(base)
	if err != nil {
		return fmt.Errorf("resolve base path: %w", err)
	}

	return filepath.Walk(baseAbs, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.Mode()&os.ModeSymlink == 0 {
			return nil
		}

		target, err := os.Readlink(path)
		if err != nil {
			return fmt.Errorf("read symlink %s: %w", path, err)
		}

		resolved := target
		if !filepath.IsAbs(resolved) {
			resolved = filepath.Join(filepath.Dir(path), target)
		}
		resolved = filepath.Clean(resolved)
		if !filepath.IsAbs(resolved) {
			resolved = filepath.Join(baseAbs, resolved)
		}

		if !isWithinBase(baseAbs, resolved) {
			return fmt.Errorf("external symlink detected: %s -> %s", path, target)
		}
		return nil
	})
}

func DirSize(base string) (int64, error) {
	var total int64

	err := filepath.Walk(base, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	if err != nil {
		return 0, err
	}

	return total, nil
}

func rejectSymlink(path string) error {
	info, err := os.Lstat(path)
	if err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to write through symlink: %s", path)
		}
		return nil
	}
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

func isWithinBase(baseAbs, targetAbs string) bool {
	rel, err := filepath.Rel(baseAbs, targetAbs)
	if err != nil {
		return false
	}
	return rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..")
}
