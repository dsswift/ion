package filelock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Lock represents an acquired advisory file lock.
type Lock struct {
	Path     string
	lockPath string
	pid      int
}

// Acquire obtains an advisory file lock by writing the current PID to a .lock file.
// Returns an error if the lock is held by a live process.
func Acquire(path string) (*Lock, error) {
	lockPath := filepath.Clean(path) + ".lock"

	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return nil, fmt.Errorf("filelock: mkdir: %w", err)
	}

	// Check for existing lock
	if data, err := os.ReadFile(lockPath); err == nil {
		pidStr := strings.TrimSpace(string(data))
		if lockPid, err := strconv.Atoi(pidStr); err == nil {
			if isProcessAlive(lockPid) {
				return nil, fmt.Errorf("filelock: locked by PID %d", lockPid)
			}
		}
		// Stale lock, remove it
		os.Remove(lockPath)
	}

	// Write our PID with O_CREATE|O_EXCL for atomicity
	pid := os.Getpid()
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("filelock: race condition, lock acquired by another process")
		}
		return nil, fmt.Errorf("filelock: create: %w", err)
	}
	fmt.Fprintf(f, "%d", pid)
	f.Close()

	return &Lock{
		Path:     filepath.Clean(path),
		lockPath: lockPath,
		pid:      pid,
	}, nil
}

// Release removes the lock file if we still own it.
func (l *Lock) Release() error {
	if l == nil {
		return nil
	}
	data, err := os.ReadFile(l.lockPath)
	if err != nil {
		return nil // Already gone
	}
	pidStr := strings.TrimSpace(string(data))
	lockPid, err := strconv.Atoi(pidStr)
	if err != nil {
		return nil
	}
	if lockPid != l.pid {
		return nil // Not ours
	}
	return os.Remove(l.lockPath)
}

// WithLock acquires a lock, runs fn, then releases. Returns the lock error or fn error.
func WithLock(path string, fn func() error) error {
	lock, err := Acquire(path)
	if err != nil {
		return err
	}
	defer lock.Release()
	return fn()
}

// isProcessAlive is implemented per-platform in filelock_unix.go and filelock_windows.go.
