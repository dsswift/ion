package durablefile

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestWrite_Basic(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "out.json")
	data := []byte(`{"key":"value"}`)

	if err := Write(path, data, 0o644); err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back failed: %v", err)
	}
	if string(got) != string(data) {
		t.Fatalf("content mismatch: got %q", got)
	}
}

func TestWrite_Mode(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "secret.key")

	if err := Write(path, []byte("secret"), 0o600); err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat failed: %v", err)
	}
	perm := info.Mode().Perm()
	if perm != 0o600 {
		t.Fatalf("expected mode 0600, got %04o", perm)
	}
}

func TestWrite_CreatesParentDirs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a", "b", "c", "file.txt")

	if err := Write(path, []byte("nested"), 0o644); err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back failed: %v", err)
	}
	if string(got) != "nested" {
		t.Fatalf("content mismatch: got %q", got)
	}
}

func TestWrite_OverwriteExisting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file.txt")

	if err := Write(path, []byte("first"), 0o644); err != nil {
		t.Fatalf("first Write failed: %v", err)
	}
	if err := Write(path, []byte("second"), 0o644); err != nil {
		t.Fatalf("second Write failed: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back failed: %v", err)
	}
	if string(got) != "second" {
		t.Fatalf("expected 'second', got %q", got)
	}
}

func TestWrite_NoResidualOnSuccess(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "clean.txt")

	if err := Write(path, []byte("ok"), 0o644); err != nil {
		t.Fatalf("Write failed: %v", err)
	}

	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if isResidualTemp(e.Name()) {
			t.Fatalf("residual temp file found: %s", e.Name())
		}
	}
}

func TestWrite_ParallelWriters(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "parallel.txt")

	const n = 50
	var wg sync.WaitGroup
	errs := make([]error, n)

	for i := range n {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			data := []byte(string(rune('A'+idx%26)) + " payload")
			errs[idx] = Write(path, data, 0o644)
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("writer %d failed: %v", i, err)
		}
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("final read failed: %v", err)
	}
	if len(got) == 0 {
		t.Fatal("final file is empty")
	}

	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if isResidualTemp(e.Name()) {
			t.Errorf("residual temp after parallel writes: %s", e.Name())
		}
	}
}

func TestCleanResidual(t *testing.T) {
	dir := t.TempDir()

	old := filepath.Join(dir, ".durablefile-old123")
	os.WriteFile(old, []byte("stale"), 0o644) //nolint:errcheck

	fresh := filepath.Join(dir, ".durablefile-fresh456")
	os.WriteFile(fresh, []byte("recent"), 0o644) //nolint:errcheck

	normal := filepath.Join(dir, "data.json")
	os.WriteFile(normal, []byte("keep"), 0o644) //nolint:errcheck

	oldTime := time.Now().Add(-2 * time.Hour)
	os.Chtimes(old, oldTime, oldTime) //nolint:errcheck

	removed, err := CleanResidual(dir, 1*time.Hour)
	if err != nil {
		t.Fatalf("CleanResidual failed: %v", err)
	}
	if removed != 1 {
		t.Fatalf("expected 1 removed, got %d", removed)
	}

	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatal("old temp should be removed")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatal("fresh temp should survive")
	}
	if _, err := os.Stat(normal); err != nil {
		t.Fatal("normal file should survive")
	}
}

func TestCleanResidual_EmptyDir(t *testing.T) {
	dir := t.TempDir()
	removed, err := CleanResidual(dir, 1*time.Hour)
	if err != nil {
		t.Fatalf("CleanResidual failed: %v", err)
	}
	if removed != 0 {
		t.Fatalf("expected 0 removed, got %d", removed)
	}
}

func TestTransaction_BasicSerialization(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tx.txt")

	var order []int
	var mu sync.Mutex

	const n = 10
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			err := Transaction(path, 5*time.Second, func(abs string) error {
				mu.Lock()
				order = append(order, idx)
				mu.Unlock()
				return Write(abs, []byte("from tx"), 0o644)
			})
			if err != nil {
				t.Errorf("Transaction %d failed: %v", idx, err)
			}
		}(i)
	}
	wg.Wait()

	if len(order) != n {
		t.Fatalf("expected %d executions, got %d", n, len(order))
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back failed: %v", err)
	}
	if string(got) != "from tx" {
		t.Fatalf("unexpected content: %q", got)
	}
}

func TestTransaction_InProcessMutexSerializes(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "serial.txt")

	var concurrent atomic.Int32
	var maxConcurrent atomic.Int32

	const n = 20
	var wg sync.WaitGroup
	for i := range n {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			err := Transaction(path, 5*time.Second, func(abs string) error {
				cur := concurrent.Add(1)
				for {
					prev := maxConcurrent.Load()
					if cur <= prev || maxConcurrent.CompareAndSwap(prev, cur) {
						break
					}
				}
				time.Sleep(time.Millisecond)
				concurrent.Add(-1)
				return nil
			})
			if err != nil {
				t.Errorf("Transaction %d failed: %v", idx, err)
			}
		}(i)
	}
	wg.Wait()

	if maxConcurrent.Load() > 1 {
		t.Fatalf("in-process mutex broken: max concurrent = %d", maxConcurrent.Load())
	}
}

func TestTransaction_ErrorPropagation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "err.txt")

	err := Transaction(path, time.Second, func(abs string) error {
		return os.ErrPermission
	})
	if err != os.ErrPermission {
		t.Fatalf("expected ErrPermission, got %v", err)
	}
}

func TestIsResidualTemp(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{".durablefile-abc123", true},
		{".durablefile-", false},
		{"durablefile-abc", false},
		{"data.json", false},
		{".durablefile-x", true},
		{".durablefile-12345-abc", true},
	}
	for _, tc := range cases {
		if got := isResidualTemp(tc.name); got != tc.want {
			t.Errorf("isResidualTemp(%q) = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestParseTempPID(t *testing.T) {
	cases := []struct {
		name    string
		wantPID int
		wantOK  bool
	}{
		{".durablefile-12345-abc", 12345, true},
		{".durablefile-1-x", 1, true},
		{".durablefile-99999-longrand", 99999, true},
		{".durablefile-abc-rand", 0, false},
		{".durablefile-", 0, false},
		{".durablefile-0-x", 0, false},
		{".durablefile--x", 0, false},
		{"data.json", 0, false},
		{".durablefile-123", 0, false},
	}
	for _, tc := range cases {
		pid, ok := parseTempPID(tc.name)
		if ok != tc.wantOK || pid != tc.wantPID {
			t.Errorf("parseTempPID(%q) = (%d, %v), want (%d, %v)",
				tc.name, pid, ok, tc.wantPID, tc.wantOK)
		}
	}
}

func TestWrite_TempEncodesPID(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "sub", "out.json")

	oldName := ""
	origWrite := Write
	_ = origWrite

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(target),
		fmt.Sprintf(".durablefile-%d-*", os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	oldName = filepath.Base(tmp.Name())
	tmp.Close()           //nolint:errcheck
	os.Remove(tmp.Name()) //nolint:errcheck

	pid, ok := parseTempPID(oldName)
	if !ok {
		t.Fatalf("temp name %q does not encode a PID", oldName)
	}
	if pid != os.Getpid() {
		t.Fatalf("encoded PID %d != current %d", pid, os.Getpid())
	}
}

func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command("true")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start 'true': %v", err)
	}
	pid := cmd.Process.Pid
	if err := cmd.Wait(); err != nil {
		t.Fatalf("wait 'true': %v", err)
	}
	return pid
}

func TestReapDeadTemps_RemovesDeadPID(t *testing.T) {
	dir := t.TempDir()
	dead := deadPID(t)

	deadFile := filepath.Join(dir, fmt.Sprintf(".durablefile-%d-abc123", dead))
	os.WriteFile(deadFile, []byte("stale"), 0o644) //nolint:errcheck

	removed, err := ReapDeadTemps(dir)
	if err != nil {
		t.Fatalf("ReapDeadTemps: %v", err)
	}
	if removed != 1 {
		t.Fatalf("expected 1 removed, got %d", removed)
	}
	if _, err := os.Stat(deadFile); !os.IsNotExist(err) {
		t.Fatal("dead-PID temp should be removed")
	}
}

func TestReapDeadTemps_KeepsCurrentPID(t *testing.T) {
	dir := t.TempDir()

	liveFile := filepath.Join(dir, fmt.Sprintf(".durablefile-%d-xyz789", os.Getpid()))
	os.WriteFile(liveFile, []byte("active"), 0o644) //nolint:errcheck

	removed, err := ReapDeadTemps(dir)
	if err != nil {
		t.Fatalf("ReapDeadTemps: %v", err)
	}
	if removed != 0 {
		t.Fatalf("expected 0 removed, got %d", removed)
	}
	if _, err := os.Stat(liveFile); err != nil {
		t.Fatal("current-PID temp should survive")
	}
}

func TestReapDeadTemps_MixedPIDs(t *testing.T) {
	dir := t.TempDir()
	dead := deadPID(t)

	deadFile := filepath.Join(dir, fmt.Sprintf(".durablefile-%d-aaa", dead))
	os.WriteFile(deadFile, []byte("gone"), 0o644) //nolint:errcheck

	liveFile := filepath.Join(dir, fmt.Sprintf(".durablefile-%d-bbb", os.Getpid()))
	os.WriteFile(liveFile, []byte("here"), 0o644) //nolint:errcheck

	normalFile := filepath.Join(dir, "data.json")
	os.WriteFile(normalFile, []byte("keep"), 0o644) //nolint:errcheck

	removed, err := ReapDeadTemps(dir)
	if err != nil {
		t.Fatalf("ReapDeadTemps: %v", err)
	}
	if removed != 1 {
		t.Fatalf("expected 1 removed, got %d", removed)
	}
	if _, err := os.Stat(deadFile); !os.IsNotExist(err) {
		t.Fatal("dead-PID temp should be removed")
	}
	if _, err := os.Stat(liveFile); err != nil {
		t.Fatal("live-PID temp should survive")
	}
	if _, err := os.Stat(normalFile); err != nil {
		t.Fatal("normal file should survive")
	}
}

func TestReapDeadTemps_SkipsUnparseable(t *testing.T) {
	dir := t.TempDir()

	legacyFile := filepath.Join(dir, ".durablefile-nopid")
	os.WriteFile(legacyFile, []byte("legacy"), 0o644) //nolint:errcheck

	removed, err := ReapDeadTemps(dir)
	if err != nil {
		t.Fatalf("ReapDeadTemps: %v", err)
	}
	if removed != 0 {
		t.Fatalf("expected 0 removed for unparseable, got %d", removed)
	}
	if _, err := os.Stat(legacyFile); err != nil {
		t.Fatal("unparseable temp should survive")
	}
}

func TestReapDeadTemps_EmptyDir(t *testing.T) {
	dir := t.TempDir()
	removed, err := ReapDeadTemps(dir)
	if err != nil {
		t.Fatalf("ReapDeadTemps: %v", err)
	}
	if removed != 0 {
		t.Fatalf("expected 0, got %d", removed)
	}
}
