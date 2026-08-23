package tools

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStopBackgroundTasksForOwner_RemovesOutputFiles(t *testing.T) {
	dir := t.TempDir()

	f, err := os.CreateTemp(dir, "bash-*.out")
	if err != nil {
		t.Fatal(err)
	}
	outputPath := f.Name()
	f.Close()

	tasksMu.Lock()
	tasks["test-task-1"] = &TaskInfo{
		ID:         "test-task-1",
		Kind:       "bash",
		Owner:      "owner-a",
		Status:     "completed",
		OutputPath: outputPath,
		StartedAt:  time.Now(),
	}
	tasksMu.Unlock()

	StopBackgroundTasksForOwner("owner-a")

	if _, err := os.Stat(outputPath); !os.IsNotExist(err) {
		t.Errorf("output file should be removed, got err=%v", err)
	}

	tasksMu.RLock()
	_, exists := tasks["test-task-1"]
	tasksMu.RUnlock()
	if exists {
		t.Error("task should be purged from registry")
	}
}

func TestStopBackgroundTasksForOwner_IgnoresOtherOwners(t *testing.T) {
	dir := t.TempDir()

	f, err := os.CreateTemp(dir, "bash-*.out")
	if err != nil {
		t.Fatal(err)
	}
	outputPath := f.Name()
	f.Close()

	tasksMu.Lock()
	tasks["test-task-2"] = &TaskInfo{
		ID:         "test-task-2",
		Kind:       "bash",
		Owner:      "owner-b",
		Status:     "completed",
		OutputPath: outputPath,
		StartedAt:  time.Now(),
	}
	tasksMu.Unlock()
	defer func() {
		tasksMu.Lock()
		delete(tasks, "test-task-2")
		tasksMu.Unlock()
	}()

	StopBackgroundTasksForOwner("owner-other")

	if _, err := os.Stat(outputPath); os.IsNotExist(err) {
		t.Error("output file for different owner should not be removed")
	}

	tasksMu.RLock()
	_, exists := tasks["test-task-2"]
	tasksMu.RUnlock()
	if !exists {
		t.Error("task for different owner should remain in registry")
	}
}

func TestStopBackgroundTasksForOwner_StopsRunningTask(t *testing.T) {
	stopped := false
	tasksMu.Lock()
	tasks["test-task-3"] = &TaskInfo{
		ID:        "test-task-3",
		Kind:      "bash",
		Owner:     "owner-c",
		Status:    "running",
		StartedAt: time.Now(),
		stop:      func() { stopped = true },
	}
	tasksMu.Unlock()

	StopBackgroundTasksForOwner("owner-c")

	if !stopped {
		t.Error("stop function should have been called")
	}
}

func TestCleanStaleTaskOutputs_RemovesAllOutputFiles(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	taskDir := filepath.Join(tmpHome, ".ion", "tasks")
	os.MkdirAll(taskDir, 0o700)

	f1 := filepath.Join(taskDir, "old.out")
	os.WriteFile(f1, []byte("old"), 0o600)
	oldMtime := time.Now().Add(-10 * time.Minute)
	os.Chtimes(f1, oldMtime, oldMtime)

	f2 := filepath.Join(taskDir, "recent.out")
	os.WriteFile(f2, []byte("recent"), 0o600)

	notOutput := filepath.Join(taskDir, "keepme.txt")
	os.WriteFile(notOutput, []byte("x"), 0o600)

	CleanStaleTaskOutputs()

	if _, err := os.Stat(f1); !os.IsNotExist(err) {
		t.Error("old .out file should be removed")
	}
	if _, err := os.Stat(f2); !os.IsNotExist(err) {
		t.Error("recent .out file should also be removed (all stale at startup)")
	}
	if _, err := os.Stat(notOutput); os.IsNotExist(err) {
		t.Error("non-.out file should be kept")
	}
}

func TestCleanStaleTaskOutputs_DoesNotTouchMcpArtifacts(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	mcpDir := filepath.Join(tmpHome, ".ion", "mcp")
	if err := os.MkdirAll(mcpDir, 0o700); err != nil {
		t.Fatal(err)
	}
	taskDir := filepath.Join(tmpHome, ".ion", "tasks")
	if err := os.MkdirAll(taskDir, 0o700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(mcpDir, "config-active.json")
	if err := os.WriteFile(config, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	CleanStaleTaskOutputs()
	if _, err := os.Stat(config); err != nil {
		t.Fatalf("task cleanup must not remove MCP config owned by a live server: %v", err)
	}
}
