package filelock

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func TestAcquireAndRelease(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.lock")

	lock, err := Acquire(path)
	if err != nil {
		t.Fatalf("failed to acquire lock: %v", err)
	}

	// Lock file should exist with our PID
	data, err := os.ReadFile(lock.lockPath)
	if err != nil {
		t.Fatalf("lock file not found: %v", err)
	}
	pid, err := strconv.Atoi(string(data))
	if err != nil {
		t.Fatalf("lock file doesn't contain valid PID: %v", err)
	}
	if pid != os.Getpid() {
		t.Fatalf("lock PID=%d, expected %d", pid, os.Getpid())
	}

	// Release
	if err := lock.Release(); err != nil {
		t.Fatalf("failed to release lock: %v", err)
	}

	// Lock file should be gone
	if _, err := os.Stat(lock.lockPath); !os.IsNotExist(err) {
		t.Fatal("lock file should be removed after release")
	}
}

func TestAcquire_AlreadyLocked(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.lock")

	lock1, err := Acquire(path)
	if err != nil {
		t.Fatalf("failed to acquire first lock: %v", err)
	}
	defer lock1.Release()

	// Second acquire should fail (same PID is alive)
	_, err = Acquire(path)
	if err == nil {
		t.Fatal("expected error acquiring already-held lock")
	}
}

func TestAcquire_StaleLock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.lock")
	lockPath := path + ".lock"

	// Write a stale lock with a PID that doesn't exist
	// PID 99999999 is very unlikely to be alive
	os.WriteFile(lockPath, []byte("99999999"), 0o644)

	lock, err := Acquire(path)
	if err != nil {
		t.Fatalf("should acquire stale lock: %v", err)
	}
	defer lock.Release()
}

func TestRelease_NilLock(t *testing.T) {
	var lock *Lock
	if err := lock.Release(); err != nil {
		t.Fatalf("release on nil lock should not error: %v", err)
	}
}

func TestRelease_WrongPID(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.lock")
	lockPath := path + ".lock"

	// Create a lock file owned by a different PID
	os.WriteFile(lockPath, []byte("1"), 0o644)

	lock := &Lock{
		Path:     path,
		lockPath: lockPath,
		pid:      99999999, // Not us
	}

	// Should not remove since PIDs don't match
	lock.Release()

	if _, err := os.Stat(lockPath); os.IsNotExist(err) {
		t.Fatal("lock file should not be removed when PID doesn't match")
	}
}

func TestWithLock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.lock")

	called := false
	err := WithLock(path, func() error {
		called = true

		// Lock should exist while in fn
		lockPath := path + ".lock"
		if _, err := os.Stat(lockPath); os.IsNotExist(err) {
			t.Fatal("lock file should exist during WithLock")
		}

		return nil
	})

	if err != nil {
		t.Fatalf("WithLock failed: %v", err)
	}
	if !called {
		t.Fatal("fn was not called")
	}

	// Lock should be released after
	lockPath := path + ".lock"
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatal("lock file should be removed after WithLock")
	}
}

func TestWithLock_FnError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.lock")

	err := WithLock(path, func() error {
		return os.ErrPermission
	})

	if err != os.ErrPermission {
		t.Fatalf("expected ErrPermission, got %v", err)
	}

	// Lock should still be released
	lockPath := path + ".lock"
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatal("lock file should be removed even after fn error")
	}
}

func TestIsProcessAlive(t *testing.T) {
	// Our own PID should be alive
	if !isProcessAlive(os.Getpid()) {
		t.Fatal("our own process should be alive")
	}

	// A very high PID should not be alive
	if isProcessAlive(99999999) {
		t.Fatal("PID 99999999 should not be alive")
	}
}
