package tools

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPruneFinishedBackgroundTasksRetainsNewestPerOwner(t *testing.T) {
	clearBashTasks(t)
	oldLimit := FinishedBackgroundTaskRetentionLimit()
	SetFinishedBackgroundTaskRetentionLimit(2)
	t.Cleanup(func() { SetFinishedBackgroundTaskRetentionLimit(oldLimit); clearBashTasks(t) })
	dir := t.TempDir()
	now := time.Now()
	for i, id := range []string{"old", "middle", "new"} {
		path := filepath.Join(dir, id+".out")
		if err := os.WriteFile(path, []byte(id), 0o600); err != nil {
			t.Fatal(err)
		}
		completed := now.Add(time.Duration(i) * time.Second)
		tasksMu.Lock()
		tasks[id] = &TaskInfo{ID: id, Kind: "bash", Owner: "owner", Status: "completed", StartedAt: now, CompletedAt: &completed, OutputPath: path}
		tasksMu.Unlock()
	}
	pruneFinishedBackgroundTasks("owner")
	tasksMu.RLock()
	_, oldExists := tasks["old"]
	_, middleExists := tasks["middle"]
	_, newExists := tasks["new"]
	tasksMu.RUnlock()
	if oldExists || !middleExists || !newExists {
		t.Fatalf("retained tasks old=%v middle=%v new=%v", oldExists, middleExists, newExists)
	}
	if _, err := os.Stat(filepath.Join(dir, "old.out")); !os.IsNotExist(err) {
		t.Fatalf("old output still exists: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "new.out")); err != nil {
		t.Fatalf("new output missing: %v", err)
	}
}

func TestPruneFinishedBackgroundTasksKeepsRunningTask(t *testing.T) {
	clearBashTasks(t)
	oldLimit := FinishedBackgroundTaskRetentionLimit()
	SetFinishedBackgroundTaskRetentionLimit(1)
	t.Cleanup(func() { SetFinishedBackgroundTaskRetentionLimit(oldLimit); clearBashTasks(t) })
	now := time.Now()
	tasksMu.Lock()
	tasks["running"] = &TaskInfo{ID: "running", Kind: "bash", Owner: "owner", Status: "running", StartedAt: now}
	tasksMu.Unlock()
	pruneFinishedBackgroundTasks("owner")
	tasksMu.RLock()
	_, exists := tasks["running"]
	tasksMu.RUnlock()
	if !exists {
		t.Fatal("running task was pruned")
	}
}
