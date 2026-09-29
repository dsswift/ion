// Package filelock provides a cross-process exclusive lock on a sibling
// "<path>.lock" file.
//
// Ownership is a kernel advisory lock held on an open file descriptor for the
// lock's whole lifetime (flock on Unix, LockFileEx on Windows). The kernel
// drops the lock when the holder's descriptor closes, including when the
// holder dies, so a leftover lock file never blocks a later acquirer. The PID
// written into the file is informational only: it names the holder in logs,
// in the refusal error, and for a human inspecting the file. It is never
// trusted to decide ownership, because a PID from a previous boot or a
// previous container can belong to an unrelated live process (in a container
// the engine is PID 1 on every start).
package filelock

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// errLockHeld is returned by the platform tryLock when another open file
// description (in this process or another) already holds the lock.
var errLockHeld = errors.New("lock held")

// maxSwapRetries bounds how often Acquire retries when the lock file it locked
// was unlinked and replaced by a releasing holder between its open and lock.
const maxSwapRetries = 8

// Lock represents an acquired exclusive file lock.
type Lock struct {
	Path     string
	lockPath string
	pid      int

	mu   sync.Mutex
	file *os.File // nil once released
}

// Acquire obtains the exclusive lock for path by locking "<path>.lock".
// Returns an error without blocking when another holder (in this process or
// any other) has it; the error names the holder's PID when it is recorded.
func Acquire(path string) (*Lock, error) {
	clean := filepath.Clean(path)
	lockPath := clean + ".lock"

	if err := os.MkdirAll(filepath.Dir(lockPath), 0o755); err != nil {
		return nil, fmt.Errorf("filelock: mkdir: %w", err)
	}

	for attempt := 0; ; attempt++ {
		_, statErr := os.Stat(lockPath)
		leftover := statErr == nil

		f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
		if err != nil {
			return nil, fmt.Errorf("filelock: open: %w", err)
		}

		if err := tryLock(f); err != nil {
			holder := readHolder(f)
			closeQuietly(f, lockPath, "acquire refused close failed")
			if errors.Is(err, errLockHeld) {
				utils.LogWithFields(utils.LevelInfo, "filelock", "acquire refused: lock held", map[string]any{"path": lockPath, "holder_pid": holder})
				if holder == "" {
					return nil, fmt.Errorf("filelock: locked by another process")
				}
				return nil, fmt.Errorf("filelock: locked by PID %s", holder)
			}
			return nil, fmt.Errorf("filelock: lock: %w", err)
		}

		// A releasing holder unlinks the file while still holding it. If that
		// happened between our open and our lock, we hold a lock on an orphaned
		// inode while the path names a new file someone else can lock. Retry
		// against whatever the path names now.
		if !samePath(f, lockPath) {
			unlockQuietly(f, lockPath)
			closeQuietly(f, lockPath, "acquire orphan close failed")
			if attempt >= maxSwapRetries {
				return nil, fmt.Errorf("filelock: lock file replaced repeatedly during acquire")
			}
			utils.LogWithFields(utils.LevelDebug, "filelock", "acquire retry: lock file replaced", map[string]any{"path": lockPath, "attempt": attempt})
			continue
		}

		if leftover {
			// The kernel lock is free, so whoever wrote this file no longer
			// holds it. Its recorded PID is stale by construction.
			utils.LogWithFields(utils.LevelInfo, "filelock", "acquire reusing leftover lock file", map[string]any{"path": lockPath, "prior_pid": readHolder(f)})
		}

		pid := os.Getpid()
		writePID(f, lockPath, pid)
		utils.LogWithFields(utils.LevelDebug, "filelock", "acquired", map[string]any{"path": lockPath, "pid": pid})
		return &Lock{Path: clean, lockPath: lockPath, pid: pid, file: f}, nil
	}
}

// Release drops the lock and removes the lock file. The file is removed only
// by the holder, so a lock that was never held or is already released leaves
// the path alone. Safe to call more than once and on a nil Lock.
func (l *Lock) Release() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file == nil {
		return nil
	}
	f := l.file
	l.file = nil
	err := releaseFile(f, l.lockPath)
	utils.LogWithFields(utils.LevelDebug, "filelock", "released", map[string]any{"path": l.lockPath, "error": utils.ErrStr(err)})
	return err
}

// WithLock acquires a lock, runs fn, then releases. Returns the lock error or fn error.
func WithLock(path string, fn func() error) error {
	lock, err := Acquire(path)
	if err != nil {
		return err
	}
	defer func() {
		if err := lock.Release(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "filelock", "with lock release failed", map[string]any{"path": path, "error": err.Error()})
		}
	}()
	return fn()
}

// readHolder returns the PID text recorded in the lock file, or "" when the
// file is empty or does not hold a number (a holder between lock and write).
func readHolder(f *os.File) string {
	buf := make([]byte, 32)
	n, err := f.ReadAt(buf, 0)
	if err != nil && !errors.Is(err, io.EOF) {
		utils.LogWithFields(utils.LevelDebug, "filelock", "read holder pid failed", map[string]any{"path": f.Name(), "error": err.Error()})
		return ""
	}
	text := strings.TrimSpace(string(buf[:n]))
	if _, err := strconv.Atoi(text); err != nil {
		return ""
	}
	return text
}

// writePID replaces the file's content with pid. Failure is logged and not
// fatal: the kernel lock, not the content, is what excludes other holders.
func writePID(f *os.File, lockPath string, pid int) {
	if err := f.Truncate(0); err != nil {
		utils.LogWithFields(utils.LevelWarn, "filelock", "acquire truncate failed", map[string]any{"path": lockPath, "error": err.Error()})
		return
	}
	if _, err := f.WriteAt([]byte(strconv.Itoa(pid)), 0); err != nil {
		utils.LogWithFields(utils.LevelWarn, "filelock", "acquire write pid failed", map[string]any{"path": lockPath, "error": err.Error()})
	}
}

// samePath reports whether the open file is still the file lockPath names.
func samePath(f *os.File, lockPath string) bool {
	held, err := f.Stat()
	if err != nil {
		return false
	}
	current, err := os.Stat(lockPath)
	if err != nil {
		return false
	}
	return os.SameFile(held, current)
}

func closeQuietly(f *os.File, lockPath, msg string) {
	if err := f.Close(); err != nil {
		utils.LogWithFields(utils.LevelInfo, "filelock", msg, map[string]any{"path": lockPath, "error": err.Error()})
	}
}

func unlockQuietly(f *os.File, lockPath string) {
	if err := unlock(f); err != nil {
		utils.LogWithFields(utils.LevelInfo, "filelock", "unlock failed", map[string]any{"path": lockPath, "error": err.Error()})
	}
}
