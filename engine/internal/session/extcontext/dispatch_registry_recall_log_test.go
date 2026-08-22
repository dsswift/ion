package extcontext

import (
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

// recallLogMu serializes access to the process-global logger test sink.
var recallLogMu sync.Mutex

func captureRecallLogFields(t *testing.T) func() []map[string]any {
	t.Helper()
	recallLogMu.Lock()
	// Same reason as captureDispatchLogs: the process-global per-message rate
	// limiter runs ahead of the test sink, so a package run that has already
	// filled a window for these recall lines would hide them from the sink.
	utils.ResetLogRateLimitForTest()

	var mu sync.Mutex
	var fields []map[string]any
	utils.SetTestSink(func(_ utils.LogLevel, tag, msg string, entry map[string]any, _, _ string) {
		if tag != "session.extcontext.dispatch_registry" || !strings.HasPrefix(msg, "recall") {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		copy := make(map[string]any, len(entry))
		for key, value := range entry {
			copy[key] = value
		}
		fields = append(fields, copy)
	})
	t.Cleanup(func() {
		utils.SetTestSink(nil)
		recallLogMu.Unlock()
	})

	return func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		out := make([]map[string]any, len(fields))
		copy(out, fields)
		return out
	}
}

func requireRecallDispatchIDs(t *testing.T, entries []map[string]any, want ...string) {
	t.Helper()
	if len(entries) != len(want) {
		t.Fatalf("recall log entries = %d, want %d: %#v", len(entries), len(want), entries)
	}
	for i, dispatchID := range want {
		if entries[i]["dispatch_id"] != dispatchID {
			t.Errorf("entry %d dispatch_id = %v, want %q", i, entries[i]["dispatch_id"], dispatchID)
		}
		for key := range entries[i] {
			if key == "run_id" || key == "found_i_d" || key == "desc_i_ds_i" {
				t.Errorf("entry %d uses non-canonical dispatch field %q: %#v", i, key, entries[i])
			}
		}
	}
}

// TestDispatchRegistryRecallLogsCanonicalDispatchID pins dispatch_id on both
// target and descendant recall logs. Logs are operational contract data, so a
// misspelled field silently breaks correlation for every consumer.
func TestDispatchRegistryRecallLogsCanonicalDispatchID(t *testing.T) {
	snapshot := captureRecallLogFields(t)
	r := NewDispatchRegistry()
	r.RegisterWithID("parent-id", "parent", func() {}, nil, "session", "", 1)
	r.RegisterWithID("child-id", "child", func() {}, nil, "session", "parent-id", 2)

	if !r.RecallByID("parent-id", "test") {
		t.Fatal("Recall returned false")
	}

	requireRecallDispatchIDs(t, snapshot(), "child-id", "parent-id")
}

// TestDispatchRegistryRecallByIDLogsCanonicalDispatchID pins the ID-targeted
// recall path separately so it cannot drift from Recall's structured logs.
func TestDispatchRegistryRecallByIDLogsCanonicalDispatchID(t *testing.T) {
	snapshot := captureRecallLogFields(t)
	r := NewDispatchRegistry()
	r.RegisterWithID("parent-id", "parent", func() {}, nil, "session", "", 1)
	r.RegisterWithID("child-id", "child", func() {}, nil, "session", "parent-id", 2)

	if !r.RecallByID("parent-id", "test") {
		t.Fatal("RecallByID returned false")
	}

	requireRecallDispatchIDs(t, snapshot(), "child-id", "parent-id")
}
