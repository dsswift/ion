package tools

import (
	"os"
	"sort"
	"sync/atomic"

	"github.com/dsswift/ion/engine/internal/utils"
)

var finishedBackgroundTaskRetentionLimit atomic.Int64

func init() { finishedBackgroundTaskRetentionLimit.Store(32) }

// SetFinishedBackgroundTaskRetentionLimit applies the resolved engine policy.
func SetFinishedBackgroundTaskRetentionLimit(limit int) {
	if limit > 0 {
		finishedBackgroundTaskRetentionLimit.Store(int64(limit))
	}
}

func FinishedBackgroundTaskRetentionLimit() int {
	return int(finishedBackgroundTaskRetentionLimit.Load())
}

// pruneFinishedBackgroundTasks retains the most recent terminal Bash tasks for
// one owner. The limit is process-wide engine policy, stamped by session runs.
func pruneFinishedBackgroundTasks(owner string) {
	if owner == "" {
		return
	}
	limit := FinishedBackgroundTaskRetentionLimit()
	tasksMu.Lock()
	finished := make([]*TaskInfo, 0)
	for _, task := range tasks {
		if task.Kind == "bash" && task.Owner == owner && task.Status != "running" {
			finished = append(finished, task)
		}
	}
	sort.Slice(finished, func(i, j int) bool {
		return finished[i].CompletedAt.After(*finished[j].CompletedAt)
	})
	if len(finished) <= limit {
		tasksMu.Unlock()
		return
	}
	evicted := finished[limit:]
	paths := make([]string, 0, len(evicted))
	ids := make([]string, 0, len(evicted))
	for _, task := range evicted {
		delete(tasks, task.ID)
		ids = append(ids, task.ID)
		if task.OutputPath != "" {
			paths = append(paths, task.OutputPath)
		}
	}
	tasksMu.Unlock()
	for _, path := range paths {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			utils.LogWithFields(utils.LevelWarn, "tools.bash", "failed to remove pruned task output", map[string]any{"path": path, "error": err.Error()})
		}
	}
	utils.LogWithFields(utils.LevelInfo, "tools.bash", "finished background tasks pruned", map[string]any{"session_id": owner, "task_ids": ids, "retained": limit})
}
