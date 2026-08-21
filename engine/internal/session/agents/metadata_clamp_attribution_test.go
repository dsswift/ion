package agents

import (
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// captureClampLogs installs a log sink for the duration of the test and
// returns the captured field maps for the clamp WARNs.
func captureClampLogs(t *testing.T) func() []map[string]any {
	t.Helper()
	var mu sync.Mutex
	var got []map[string]any
	utils.SetTestSink(func(_ utils.LogLevel, _, msg string, fields map[string]any, _, _ string) {
		if !strings.HasSuffix(msg, "_clamped") {
			return
		}
		mu.Lock()
		got = append(got, fields)
		mu.Unlock()
	})
	t.Cleanup(func() { utils.SetTestSink(nil) })
	return func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]any(nil), got...)
	}
}

// The clamp runs inside a package with no session identity of its own. Before
// attribution was threaded through, its WARN carried an agent name and byte
// counts and nothing that named the conversation producing them, so a reader
// could see metadata being bounded but could not reach the offending run.
func TestClampLogsCarryConversationAttribution(t *testing.T) {
	read := captureClampLogs(t)

	states := []types.AgentStateUpdate{{
		Name:     "noisy",
		Metadata: map[string]any{"task": strings.Repeat("x", 32*1024)},
	}}
	attr := ClampAttribution{Key: "tab-1", ConversationID: "1787013325381-4f3f7b84b4a1"}

	_, reports := ClampSnapshotCopy(states, MetadataLimits{}, attr)
	if len(reports) == 0 {
		t.Fatal("expected the oversized value to clamp")
	}

	lines := read()
	if len(lines) == 0 {
		t.Fatal("expected a clamp WARN")
	}
	for _, f := range lines {
		if f["conversation_id"] != attr.ConversationID {
			t.Errorf("clamp log conversation_id = %v, want %q", f["conversation_id"], attr.ConversationID)
		}
		if f["key"] != attr.Key {
			t.Errorf("clamp log key = %v, want %q", f["key"], attr.Key)
		}
	}
}

// The snapshot-scope clamp is a separate log line from the entry/value one and
// was equally unattributed. A roster over the snapshot budget exercises it.
func TestSnapshotClampLogCarriesAttribution(t *testing.T) {
	read := captureClampLogs(t)

	var states []types.AgentStateUpdate
	for i := 0; i < 8; i++ {
		states = append(states, types.AgentStateUpdate{
			Name: string(rune('a'+i)) + "-agent",
			// Protected, so the entry tier keeps the key and the mass survives
			// into the roster tier.
			Metadata: map[string]any{"displayName": strings.Repeat("y", 64*1024)},
		})
	}
	attr := ClampAttribution{Key: "tab-2", ConversationID: "1787013325443-cfa26117dcb2"}

	_, _ = ClampSnapshotCopy(states, MetadataLimits{MaxSnapshotBytes: 8 * 1024}, attr)

	var sawSnapshotScope bool
	for _, f := range read() {
		if f["conversation_id"] != attr.ConversationID {
			t.Errorf("clamp log conversation_id = %v, want %q", f["conversation_id"], attr.ConversationID)
		}
		if _, ok := f["agents"]; ok {
			sawSnapshotScope = true
		}
	}
	if !sawSnapshotScope {
		t.Fatal("expected the snapshot-scope clamp to log")
	}
}

// testAttr is the attribution every other clamp test passes. The clamp's
// behavior does not depend on it — it only reaches the log line — so the
// existing cases carry one fixed value rather than each inventing its own.
var testAttr = ClampAttribution{Key: "test-key", ConversationID: "test-conversation"}
