package session

import (
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// These tests pin the instrumentation that closed a diagnostic blind spot.
//
// `agent_snapshot_emitted` logged only a COUNT, and `dispatchParentId` -- the
// single field the desktop groups child rows by -- was never logged anywhere in
// the engine. When an operator reported that a dispatch's drill-down showed no
// child agents, the logs could not say whether the nesting data was emitted and
// dropped by the client, or never emitted at all. Three separate hypotheses
// were proposed and each was disproved by reading source, because no log line
// carried the answer.
//
// The engine is headless. A payload that is emitted but never described is
// indistinguishable from one that was never emitted.

// nestingLogMu serializes access to the process-global logger test sink.
var nestingLogMu sync.Mutex

type capturedNestingLog struct {
	level  utils.LogLevel
	msg    string
	fields map[string]any
}

func captureNestingLogs(t *testing.T) func() []capturedNestingLog {
	t.Helper()
	nestingLogMu.Lock()
	utils.ResetLogRateLimitForTest()

	var mu sync.Mutex
	var logs []capturedNestingLog
	utils.SetTestSink(func(level utils.LogLevel, tag, msg string, fields map[string]any, _, _ string) {
		if tag != "session.agentstate" {
			return
		}
		copied := map[string]any{}
		for k, v := range fields {
			copied[k] = v
		}
		mu.Lock()
		defer mu.Unlock()
		logs = append(logs, capturedNestingLog{level: level, msg: msg, fields: copied})
	})
	t.Cleanup(func() {
		utils.SetTestSink(nil)
		nestingLogMu.Unlock()
	})

	return func() []capturedNestingLog {
		mu.Lock()
		defer mu.Unlock()
		out := make([]capturedNestingLog, len(logs))
		copy(out, logs)
		return out
	}
}

func nestingAgent(id, name string, meta map[string]interface{}) types.AgentStateUpdate {
	return types.AgentStateUpdate{ID: id, Name: name, Status: "running", Metadata: meta}
}

// The per-agent line must carry the parent id. Without it the "is the nesting
// data in the payload?" question is unanswerable from logs.
func TestAgentSnapshotNestingLogsParentPerAgent(t *testing.T) {
	read := captureNestingLogs(t)

	logAgentSnapshotNesting("sess-1", "dispatch_start", []types.AgentStateUpdate{
		nestingAgent("dispatch-poll-check-1", "poll-check", map[string]interface{}{
			"dispatchParentId": "dispatch-agent-1",
			"dispatchDepth":    2,
			"visibility":       "sticky",
			"invited":          true,
		}),
	})

	var found bool
	for _, entry := range read() {
		if !strings.Contains(entry.msg, "entry nesting") {
			continue
		}
		found = true
		if entry.fields["dispatch_parent_id"] != "dispatch-agent-1" {
			t.Errorf("dispatch_parent_id = %v, want dispatch-agent-1", entry.fields["dispatch_parent_id"])
		}
		if entry.fields["dispatch_depth"] != 2 {
			t.Errorf("dispatch_depth = %v, want 2", entry.fields["dispatch_depth"])
		}
		if entry.fields["model"] != "poll-check" {
			t.Errorf("model = %v, want poll-check", entry.fields["model"])
		}
	}
	if !found {
		t.Fatal("no per-agent nesting line emitted: the payload is still undescribed")
	}
}

// A nested agent with no parent id renders at the root, which is the shape of
// the reported defect. It must WARN rather than sit silently in a DEBUG line.
func TestAgentSnapshotNestingWarnsOnMissingAttribution(t *testing.T) {
	read := captureNestingLogs(t)

	logAgentSnapshotNesting("sess-1", "dispatch_start", []types.AgentStateUpdate{
		nestingAgent("dispatch-orphan-1", "poll-check", map[string]interface{}{
			"dispatchDepth": 2, // nested, but no dispatchParentId
		}),
	})

	var warned bool
	for _, entry := range read() {
		if entry.level == utils.LevelWarn && strings.Contains(entry.msg, "no parent attribution") {
			warned = true
			if entry.fields["missing_attribution"] != 1 {
				t.Errorf("missing_attribution = %v, want 1", entry.fields["missing_attribution"])
			}
		}
	}
	if !warned {
		t.Fatal("a nested agent with no parent id did not warn: it renders at root and nothing in the log says so")
	}
}

// The healthy case reports a summary with the root/nested split, so an operator
// can see attribution is present without enabling DEBUG.
func TestAgentSnapshotNestingSummaryCountsTiers(t *testing.T) {
	read := captureNestingLogs(t)

	logAgentSnapshotNesting("sess-1", "dispatch_progress", []types.AgentStateUpdate{
		nestingAgent("dispatch-agent-1", "agent-1", map[string]interface{}{"dispatchDepth": 1}),
		nestingAgent("dispatch-poll-check-1", "poll-check", map[string]interface{}{
			"dispatchParentId": "dispatch-agent-1", "dispatchDepth": 2,
		}),
	})

	var summary *capturedNestingLog
	for i, entry := range read() {
		if strings.Contains(entry.msg, "nesting summary") {
			logs := read()
			summary = &logs[i]
		}
	}
	if summary == nil {
		t.Fatal("no nesting summary emitted")
	}
	if summary.level != utils.LevelInfo {
		t.Errorf("summary level = %v, want INFO", summary.level)
	}
	if summary.fields["root_count"] != 1 {
		t.Errorf("root_count = %v, want 1", summary.fields["root_count"])
	}
	if summary.fields["nested_count"] != 1 {
		t.Errorf("nested_count = %v, want 1", summary.fields["nested_count"])
	}
	if summary.fields["missing_attribution"] != 0 {
		t.Errorf("missing_attribution = %v, want 0", summary.fields["missing_attribution"])
	}
}

// An empty snapshot must not emit anything. Agent snapshots fire on every
// heartbeat tick, so a line per empty emission would be pure log volume.
func TestAgentSnapshotNestingSilentOnEmptySnapshot(t *testing.T) {
	read := captureNestingLogs(t)
	logAgentSnapshotNesting("sess-1", "heartbeat", nil)
	if got := read(); len(got) != 0 {
		t.Errorf("empty snapshot emitted %d lines, want 0", len(got))
	}
}

// The per-agent line must be INFO, not DEBUG. The engine's default level is
// INFO and the level gate runs BEFORE the log sink, so a DEBUG line never
// reaches an operator's engine.jsonl -- the instrumentation would be invisible
// in exactly the situation it exists for. The first version of this file made
// that mistake and this test is what would have caught it.
func TestAgentSnapshotNestingPerAgentLineIsInfo(t *testing.T) {
	read := captureNestingLogs(t)

	logAgentSnapshotNesting("sess-1", "dispatch_start", []types.AgentStateUpdate{
		nestingAgent("dispatch-poll-check-1", "poll-check", map[string]interface{}{
			"dispatchParentId": "dispatch-agent-1", "dispatchDepth": 2,
		}),
	})

	for _, entry := range read() {
		if !strings.Contains(entry.msg, "entry nesting") {
			continue
		}
		if entry.level == utils.LevelDebug || entry.level == utils.LevelTrace {
			t.Fatalf("per-agent nesting line is %v: below the default INFO level, so it never reaches engine.jsonl", entry.level)
		}
		return
	}
	t.Fatal("no per-agent nesting line emitted")
}

// A root-only roster must not emit per-agent lines. Snapshots fire on every
// heartbeat tick, so describing unattributed rows individually would be pure
// log volume with no diagnostic value for a nesting question.
func TestAgentSnapshotNestingSkipsUnattributedRows(t *testing.T) {
	read := captureNestingLogs(t)

	logAgentSnapshotNesting("sess-1", "heartbeat", []types.AgentStateUpdate{
		nestingAgent("ext-roster-1", "reviewer", map[string]interface{}{"visibility": "always"}),
		nestingAgent("ext-roster-2", "planner", nil),
	})

	for _, entry := range read() {
		if strings.Contains(entry.msg, "entry nesting") {
			t.Errorf("emitted a per-agent line for an unattributed roster row: %v", entry.fields["agent_id"])
		}
	}
}

// Metadata crosses the wire as JSON, so a depth that round-tripped is float64
// while an in-process one is int. Both must read as the same number, or the
// nested/root classification flips depending on where the snapshot came from.
func TestAgentSnapshotNestingReadsJSONNumbers(t *testing.T) {
	read := captureNestingLogs(t)

	logAgentSnapshotNesting("sess-1", "rehydrate", []types.AgentStateUpdate{
		nestingAgent("dispatch-rehydrated-1", "poll-check", map[string]interface{}{
			"dispatchDepth": float64(2), // as it arrives after a JSON round-trip
		}),
	})

	var warned bool
	for _, entry := range read() {
		if entry.level == utils.LevelWarn && strings.Contains(entry.msg, "no parent attribution") {
			warned = true
		}
	}
	if !warned {
		t.Fatal("a float64 depth was not recognised as nested: a rehydrated snapshot would be misclassified as root-level")
	}
}
