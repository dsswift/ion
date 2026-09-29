package filelock

import (
	"bufio"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// helperLockPathEnv, when set, turns the test binary into a lock-holding child
// process: it acquires the named lock, prints "locked", and holds the lock
// until its stdin closes (or it is killed).
const helperLockPathEnv = "ION_FILELOCK_HELPER_PATH"

func TestMain(m *testing.M) {
	if path := os.Getenv(helperLockPathEnv); path != "" {
		os.Exit(runLockHolder(path))
	}
	os.Exit(m.Run())
}

func runLockHolder(path string) int {
	lock, err := Acquire(path)
	if err != nil {
		os.Stdout.WriteString("error " + err.Error() + "\n") //nolint:errcheck // helper protocol line
		return 1
	}
	os.Stdout.WriteString("locked\n") //nolint:errcheck // helper protocol line
	io.Copy(io.Discard, os.Stdin)     //nolint:errcheck // blocks until the parent closes stdin
	if err := lock.Release(); err != nil {
		return 2
	}
	return 0
}

// startLockHolder runs a child process that holds the lock on path and returns
// once the child reports it holds it.
func startLockHolder(t *testing.T, path string) (*exec.Cmd, io.WriteCloser) {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), helperLockPathEnv+"="+path)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin pipe: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper: %v", err)
	}
	t.Cleanup(func() {
		stdin.Close()      //nolint:errcheck // cleanup
		cmd.Process.Kill() //nolint:errcheck // cleanup; usually already exited
		cmd.Wait()         //nolint:errcheck // cleanup
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "locked" {
		t.Fatalf("helper did not acquire the lock: line=%q err=%v", line, err)
	}
	return cmd, stdin
}

func TestAcquireAndRelease(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test")

	lock, err := Acquire(path)
	if err != nil {
		t.Fatalf("failed to acquire lock: %v", err)
	}

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

	if err := lock.Release(); err != nil {
		t.Fatalf("failed to release lock: %v", err)
	}
	if _, err := os.Stat(lock.lockPath); !os.IsNotExist(err) {
		t.Fatal("lock file should be removed after release")
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("second release should be a no-op: %v", err)
	}
}

// A second Acquire in the same process opens a new descriptor, and the kernel
// lock is per open file description, so it must be refused.
func TestAcquire_AlreadyLockedInProcess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test")

	lock1, err := Acquire(path)
	if err != nil {
		t.Fatalf("failed to acquire first lock: %v", err)
	}
	defer lock1.Release() //nolint:errcheck // test cleanup

	_, err = Acquire(path)
	if err == nil {
		t.Fatal("expected error acquiring already-held lock")
	}
	want := "locked by PID " + strconv.Itoa(os.Getpid())
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("refusal = %q, want it to contain %q", err, want)
	}
}

// A leftover lock file naming a live PID (our own, or PID 1 — the container
// case where every engine start is PID 1) must not block acquisition when no
// descriptor holds the kernel lock.
func TestAcquire_LeftoverLockFileWithLivePID(t *testing.T) {
	for _, name := range []string{"own pid", "pid 1"} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "test")
			content := strconv.Itoa(os.Getpid())
			if name == "pid 1" {
				content = "1"
			}
			if err := os.WriteFile(path+".lock", []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}

			lock, err := Acquire(path)
			if err != nil {
				t.Fatalf("leftover lock file must not block acquire: %v", err)
			}
			defer lock.Release() //nolint:errcheck // test cleanup

			data, err := os.ReadFile(path + ".lock")
			if err != nil {
				t.Fatal(err)
			}
			if string(data) != strconv.Itoa(os.Getpid()) {
				t.Fatalf("lock file content = %q, want our pid", data)
			}
		})
	}
}

func TestAcquire_LeftoverLockFileWithDeadPID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test")
	if err := os.WriteFile(path+".lock", []byte("99999999"), 0o644); err != nil {
		t.Fatal(err)
	}
	lock, err := Acquire(path)
	if err != nil {
		t.Fatalf("should acquire over a stale lock file: %v", err)
	}
	defer lock.Release() //nolint:errcheck // test cleanup
}

func TestAcquire_RefusedWhileChildHolds(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test")
	cmd, stdin := startLockHolder(t, path)

	_, err := Acquire(path)
	if err == nil {
		t.Fatal("expected refusal while the child holds the lock")
	}
	want := "locked by PID " + strconv.Itoa(cmd.Process.Pid)
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("refusal = %q, want it to contain %q", err, want)
	}

	// The child releases on stdin close; the lock is then free to take.
	stdin.Close() //nolint:errcheck // signals the helper to release
	if err := cmd.Wait(); err != nil {
		t.Fatalf("helper exit: %v", err)
	}
	lock, err := Acquire(path)
	if err != nil {
		t.Fatalf("acquire after child release: %v", err)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
}

// A holder that dies without releasing leaves its file behind; the kernel
// dropped the lock with the process, so the next acquirer proceeds.
func TestAcquire_AfterHolderKilled(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test")
	cmd, _ := startLockHolder(t, path)
	if err := cmd.Process.Kill(); err != nil {
		t.Fatalf("kill helper: %v", err)
	}
	cmd.Wait() //nolint:errcheck // killed on purpose

	if _, err := os.Stat(path + ".lock"); err != nil {
		t.Fatalf("killed holder should leave its lock file: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		lock, err := Acquire(path)
		if err == nil {
			lock.Release() //nolint:errcheck // test cleanup
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("acquire after holder death: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestReleaseThenReacquire(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test")
	for i := 0; i < 3; i++ {
		lock, err := Acquire(path)
		if err != nil {
			t.Fatalf("acquire %d: %v", i, err)
		}
		if err := lock.Release(); err != nil {
			t.Fatalf("release %d: %v", i, err)
		}
	}
}

func TestRelease_NilLock(t *testing.T) {
	var lock *Lock
	if err := lock.Release(); err != nil {
		t.Fatalf("release on nil lock should not error: %v", err)
	}
}

// Release on a lock this process does not hold must leave the file alone.
func TestRelease_NotHeldLeavesFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test")
	lockPath := path + ".lock"
	if err := os.WriteFile(lockPath, []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	lock := &Lock{Path: path, lockPath: lockPath, pid: 99999999}
	if err := lock.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	if _, err := os.Stat(lockPath); err != nil {
		t.Fatal("lock file should not be removed by a lock that does not hold it")
	}
}

func TestWithLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test")
	lockPath := path + ".lock"

	called := false
	err := WithLock(path, func() error {
		called = true
		if _, err := os.Stat(lockPath); err != nil {
			t.Fatal("lock file should exist during WithLock")
		}
		if _, err := Acquire(path); err == nil {
			t.Fatal("lock must be held during WithLock")
		}
		return nil
	})
	if err != nil {
		t.Fatalf("WithLock failed: %v", err)
	}
	if !called {
		t.Fatal("fn was not called")
	}
	if _, err := os.Stat(lockPath); !os.IsNotExist(err) {
		t.Fatal("lock file should be removed after WithLock")
	}
}

func TestWithLock_FnError(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test")

	err := WithLock(path, func() error {
		return os.ErrPermission
	})
	if err != os.ErrPermission {
		t.Fatalf("expected ErrPermission, got %v", err)
	}
	if _, err := os.Stat(path + ".lock"); !os.IsNotExist(err) {
		t.Fatal("lock file should be removed even after fn error")
	}
}
