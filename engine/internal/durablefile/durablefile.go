package durablefile

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/dsswift/ion/engine/internal/filelock"
	"github.com/dsswift/ion/engine/internal/utils"
)

const tag = "durablefile"

// Write atomically replaces the file at path with content.
// Sequence: create unique temp sibling, write, fsync, close, rename, fsync parent dir.
// On any error the temp file is removed and no partial content is visible at path.
func Write(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("durablefile: mkdir %s: %w", dir, err)
	}

	tmp, err := os.CreateTemp(dir, fmt.Sprintf(".durablefile-%d-*", os.Getpid()))
	if err != nil {
		return fmt.Errorf("durablefile: create temp: %w", err)
	}
	tmpPath := tmp.Name()

	cleanup := func() {
		if rerr := os.Remove(tmpPath); rerr != nil && !os.IsNotExist(rerr) {
			utils.LogWithFields(utils.LevelInfo, tag, "cleanup temp failed", map[string]any{
				"path":  tmpPath,
				"error": rerr.Error(),
			})
		}
	}

	if err := tmp.Chmod(mode); err != nil {
		tmp.Close() //nolint:errcheck // best-effort before cleanup
		cleanup()
		return fmt.Errorf("durablefile: chmod temp: %w", err)
	}

	if _, err := tmp.Write(data); err != nil {
		tmp.Close() //nolint:errcheck // best-effort before cleanup
		cleanup()
		return fmt.Errorf("durablefile: write temp: %w", err)
	}

	if err := tmp.Sync(); err != nil {
		tmp.Close() //nolint:errcheck // best-effort before cleanup
		cleanup()
		return fmt.Errorf("durablefile: sync temp: %w", err)
	}

	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("durablefile: close temp: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		cleanup()
		return fmt.Errorf("durablefile: rename %s -> %s: %w", tmpPath, path, err)
	}

	syncDir(dir)
	return nil
}

// syncDir opens a directory and calls Sync to flush the rename to durable storage.
func syncDir(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		utils.LogWithFields(utils.LevelDebug, tag, "sync dir open failed", map[string]any{
			"dir":   dir,
			"error": err.Error(),
		})
		return
	}
	if err := d.Sync(); err != nil {
		utils.LogWithFields(utils.LevelDebug, tag, "sync dir failed", map[string]any{
			"dir":   dir,
			"error": err.Error(),
		})
	}
	d.Close() //nolint:errcheck // best-effort sync; failure logged above
}

// CleanResidual removes leftover .durablefile-* temp files in dir that are
// older than maxAge. Intended for startup or periodic hygiene.
func CleanResidual(dir string, maxAge time.Duration) (int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, fmt.Errorf("durablefile: read dir %s: %w", dir, err)
	}

	cutoff := time.Now().Add(-maxAge)
	removed := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if !isResidualTemp(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			p := filepath.Join(dir, e.Name())
			if err := os.Remove(p); err == nil {
				removed++
			} else {
				utils.LogWithFields(utils.LevelInfo, tag, "clean residual remove failed", map[string]any{
					"path":  p,
					"error": err.Error(),
				})
			}
		}
	}
	return removed, nil
}

// ReapDeadTemps removes durablefile temp files in dir whose encoded creator PID
// is no longer running. Files from the current process or any live process are
// left alone. Returns the count of files removed.
func ReapDeadTemps(dir string) (int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, fmt.Errorf("durablefile: read dir %s: %w", dir, err)
	}

	removed := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		pid, ok := parseTempPID(e.Name())
		if !ok {
			continue
		}
		if pidAlive(pid) {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if err := os.Remove(p); err == nil {
			removed++
			utils.LogWithFields(utils.LevelDebug, tag, "reaped dead-pid temp", map[string]any{
				"path": p,
				"pid":  pid,
			})
		} else if !os.IsNotExist(err) {
			utils.LogWithFields(utils.LevelInfo, tag, "reap temp remove failed", map[string]any{
				"path":  p,
				"error": err.Error(),
			})
		}
	}
	return removed, nil
}

const tempPrefix = ".durablefile-"

// isResidualTemp checks whether a filename matches the durablefile temp pattern.
func isResidualTemp(name string) bool {
	return len(name) > len(tempPrefix) && name[:len(tempPrefix)] == tempPrefix
}

// parseTempPID extracts the creator PID from a temp filename of the form
// .durablefile-<PID>-<random>. Returns (0, false) if the name does not match.
func parseTempPID(name string) (int, bool) {
	if !isResidualTemp(name) {
		return 0, false
	}
	rest := name[len(tempPrefix):]
	dashIdx := strings.IndexByte(rest, '-')
	if dashIdx <= 0 {
		return 0, false
	}
	pid, err := strconv.Atoi(rest[:dashIdx])
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

// pidAlive returns true if a process with the given PID exists.
func pidAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// txMu is a process-wide map of canonical path -> *sync.Mutex.
// Serializes in-process writers targeting the same file.
var txMu sync.Map

func txLock(absPath string) *sync.Mutex {
	val, _ := txMu.LoadOrStore(absPath, &sync.Mutex{})
	return val.(*sync.Mutex) //nolint:errcheck // LoadOrStore always stores *sync.Mutex
}

// Transaction serializes writes to path with both an in-process mutex and a
// cross-process advisory file lock. The cross-process lock uses bounded retry:
// up to maxWait with exponential backoff. If the cross-process lock cannot be
// acquired within the deadline, fn is not called and an error is returned.
//
// fn receives the canonical path and should call Write (or do its own I/O).
func Transaction(path string, maxWait time.Duration, fn func(absPath string) error) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("durablefile: abs path: %w", err)
	}

	mu := txLock(abs)
	mu.Lock()
	defer mu.Unlock()

	lock, err := acquireWithRetry(abs, maxWait)
	if err != nil {
		return fmt.Errorf("durablefile: cross-process lock %s: %w", abs, err)
	}
	defer func() {
		if rerr := lock.Release(); rerr != nil {
			utils.LogWithFields(utils.LevelInfo, tag, "tx lock release failed", map[string]any{
				"path":  abs,
				"error": rerr.Error(),
			})
		}
	}()

	return fn(abs)
}

// acquireWithRetry attempts filelock.Acquire with exponential backoff up to deadline.
func acquireWithRetry(path string, maxWait time.Duration) (*filelock.Lock, error) {
	deadline := time.Now().Add(maxWait)
	backoff := 5 * time.Millisecond

	for {
		lock, err := filelock.Acquire(path)
		if err == nil {
			return lock, nil
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("timed out after %v: %w", maxWait, err)
		}
		if backoff > 200*time.Millisecond {
			backoff = 200 * time.Millisecond
		}
		time.Sleep(backoff)
		backoff *= 2
	}
}
