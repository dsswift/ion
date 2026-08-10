package backend

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestCompletedChildDeliveryAcknowledgesOnlyAfterSave pins durable delivery.
// Before this regression, draining cleared registry records before Save; a disk
// error lost child output and retrying also appended duplicate in-memory turns.
func TestCompletedChildDeliveryAcknowledgesOnlyAfterSave(t *testing.T) {
	dataRoot := t.TempDir()
	blockedRoot := filepath.Join(dataRoot, "not-a-directory")
	if err := os.WriteFile(blockedRoot, []byte("file"), 0o644); err != nil {
		t.Fatalf("seed blocked data root: %v", err)
	}
	t.Setenv("ION_DATA_DIR", blockedRoot)

	acknowledged := 0
	pending := []types.LlmMessage{{Role: "user", Content: "[Agent worker completed]\nresult"}}
	cfg := &RunConfig{PeekCompletedChildDispatches: func() ([]types.LlmMessage, func()) {
		return pending, func() {
			acknowledged++
			pending = nil
		}
	}}
	conv := &conversation.Conversation{ID: "child-delivery", Version: conversation.CurrentVersion, Entries: []conversation.SessionEntry{}}
	run := &activeRun{requestID: "run-child-delivery", cfg: cfg}
	backend := NewApiBackend()

	backend.drainCompletedChildDispatches(run, conv)
	backend.drainCompletedChildDispatches(run, conv)
	if acknowledged != 0 || len(pending) != 1 {
		t.Fatalf("failed save acknowledged delivery: acknowledgements=%d pending=%d", acknowledged, len(pending))
	}
	if got := len(conv.Messages); got != 1 {
		t.Fatalf("failed-save retry duplicated in-memory completion: messages=%d, want 1", got)
	}

	t.Setenv("ION_DATA_DIR", dataRoot)
	backend.drainCompletedChildDispatches(run, conv)
	if acknowledged != 1 || len(pending) != 0 {
		t.Fatalf("successful save did not acknowledge exactly once: acknowledgements=%d pending=%d", acknowledged, len(pending))
	}
	if got := len(conv.Messages); got != 1 {
		t.Errorf("successful retry changed staged message count: got %d, want 1", got)
	}
}
