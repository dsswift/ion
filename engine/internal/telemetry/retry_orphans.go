package telemetry

import (
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// A retry queue drains only while a collector for its target is running. A
// target that is no longer configured leaves its queue file behind with
// nothing that will ever send or remove it, so these sweeps find such files
// at startup and remove them, logging what each one still held. Removing a
// target is the operator's decision to stop sending there; the WARN makes the
// events it drops visible rather than silent.

// liveRetryQueues holds the path of every retry queue a collector built in
// this process. Every collector derives from the engine's global config, so
// once the server has built its collectors this is the full set in use.
var liveRetryQueues sync.Map

// orphanRetryName matches the queue files retryQueuePath names under the data
// directory when no file target is configured. Quarantine files are kept: they
// exist for an operator to inspect.
var orphanRetryName = regexp.MustCompile(`^(http|eventhub)-retry-[0-9a-f]{16}\.jsonl$`)

func registerLiveRetryQueue(path string) {
	liveRetryQueues.Store(path, struct{}{})
}

// SweepOrphanRetryQueues removes retry queue files in dir that no collector
// in this process uses, and returns how many it removed. Call it once, after
// the process-level collectors are built.
func SweepOrphanRetryQueues(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "telemetry", "retry queue sweep could not read data dir", map[string]any{"dir": dir, "error": err.Error()})
		return 0
	}
	removed := 0
	for _, entry := range entries {
		m := orphanRetryName.FindStringSubmatch(entry.Name())
		if m == nil || entry.IsDir() {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		if _, live := liveRetryQueues.Load(path); live {
			continue
		}
		q := &retryQueue{path: path, target: m[1]}
		batches := q.load()
		events := 0
		var oldest int64
		for _, b := range batches {
			events += len(b.Events)
			if oldest == 0 || (b.EnqueuedAt > 0 && b.EnqueuedAt < oldest) {
				oldest = b.EnqueuedAt
			}
		}
		fields := map[string]any{"path": path, "target": m[1], "batches": len(batches), "events": events}
		if oldest > 0 {
			fields["oldest_enqueued_at"] = time.UnixMilli(oldest).UTC().Format(time.RFC3339)
		}
		if err := os.Remove(path); err != nil {
			fields["error"] = err.Error()
			utils.LogWithFields(utils.LevelWarn, "telemetry", "orphaned retry queue could not be removed", fields)
			continue
		}
		removed++
		utils.LogWithFields(utils.LevelWarn, "telemetry", "orphaned retry queue removed: its target is not configured, so its events will not be sent", fields)
	}
	utils.LogWithFields(utils.LevelInfo, "telemetry", "retry queue sweep finished", map[string]any{"dir": dir, "removed": removed})
	return removed
}
