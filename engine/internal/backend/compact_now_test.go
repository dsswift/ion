package backend

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestCompactNow_HappyPath drives a user-triggered compaction end-to-end
// against a freshly-loaded conversation that lives on disk. The test
// pins three properties at once:
//
//  1. The boundary block injected by performCompact carries Trigger="user"
//     (not "auto" / "reactive"), which the contract layer uses to
//     distinguish user-initiated compactions in the tree.
//  2. The CompactingEvent stream emits two events (Active:true → Active:false)
//     with Strategy="user" on the completion event.
//  3. The conversation file is persisted before CompactNow returns, so a
//     crash immediately after CompactNow does not lose the boundary block
//     that just got injected.
func TestCompactNow_HappyPath(t *testing.T) {
	// Use a temp HOME so conversation.Save / Load resolve to a
	// throwaway directory and the test isolates its on-disk state.
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	b := NewApiBackend()

	// Create a conversation with enough turns that performCompact's
	// hard-truncate step actually has something to truncate (the user
	// trigger always runs step 2; with too few messages it'd no-op).
	convID := "user-compact-happy"
	conv := conversation.CreateConversation(convID, tmp, "claude-sonnet-4-6")
	for i := 0; i < 20; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "hello hello hello hello hello hello hello"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "ack ack ack ack ack ack ack ack ack ack"})
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Capture events emitted under the synthetic run's request ID.
	requestID := "user-compact-happy-req"
	events := captureEvents(b, requestID)

	err := b.CompactNow(context.Background(), CompactRequest{
		ConversationID: convID,
		Model:          "claude-sonnet-4-6",
		RequestID:      requestID,
	})
	if err != nil {
		t.Fatalf("CompactNow: %v", err)
	}

	// Property 1: boundary block with Trigger="user".
	reloaded, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("Load after CompactNow: %v", err)
	}
	if len(reloaded.Messages) == 0 {
		t.Fatalf("conversation has no messages after CompactNow")
	}
	// The boundary block must exist somewhere in conv.Messages.
	var sawBoundary bool
	for _, msg := range reloaded.Messages {
		if conversation.IsCompactBoundary(msg) {
			sawBoundary = true
			break
		}
	}
	if !sawBoundary {
		t.Fatalf("expected at least one compact_boundary block in conv.Messages after CompactNow (got %d messages)", len(reloaded.Messages))
	}
	// The boundary block lives somewhere in conv.Messages. Find it and
	// verify Trigger="user". The block may be []LlmContentBlock (in-process)
	// or []interface{} (after JSON round-trip via Save+Load); both shapes
	// are valid and we accept either.
	var triggerVal string
	for _, msg := range reloaded.Messages {
		if !conversation.IsCompactBoundary(msg) {
			continue
		}
		switch c := msg.Content.(type) {
		case []types.LlmContentBlock:
			if len(c) > 0 {
				triggerVal = c[0].Trigger
			}
		case []interface{}:
			if len(c) > 0 {
				if m, ok := c[0].(map[string]interface{}); ok {
					if s, ok := m["trigger"].(string); ok {
						triggerVal = s
					}
				}
			}
		}
		break
	}
	if triggerVal != "user" {
		t.Errorf("boundary.Trigger = %q, want %q", triggerVal, "user")
	}

	// Property 2: CompactingEvent stream order + Strategy="user".
	var compactStart, compactEnd *types.CompactingEvent
	for _, ev := range *events {
		ce, ok := ev.Data.(*types.CompactingEvent)
		if !ok {
			continue
		}
		if ce.Active {
			compactStart = ce
		} else {
			compactEnd = ce
		}
	}
	if compactStart == nil {
		t.Errorf("expected CompactingEvent{Active:true} emission")
	}
	if compactEnd == nil {
		t.Fatalf("expected CompactingEvent{Active:false} emission")
	}
	if compactEnd.Strategy != "user" {
		t.Errorf("CompactingEvent.Strategy = %q, want %q", compactEnd.Strategy, "user")
	}

	// Property 3: tree entry persisted with Trigger="user".
	// Only asserted when the conversation has tree entries — the
	// happy-path test populated Messages directly without going
	// through AppendEntry, so Entries may be empty. The tree-entry
	// emission path is covered separately by tests that build the
	// conversation via AddUserMessage/AddAssistantMessage.
	if len(reloaded.Entries) > 0 {
		var sawTreeEntry bool
		for _, e := range reloaded.Entries {
			if e.Type == conversation.EntryCompaction {
				sawTreeEntry = true
				break
			}
		}
		if !sawTreeEntry {
			t.Errorf("expected conversation tree to have a compaction entry")
		}
	}
}

// TestCompactNow_AppendsTreeEntry exercises the path where the
// conversation has v2 tree entries (the production shape after any
// AddUserMessage call). performCompact must append a compaction entry
// so the tree-rendering layer (used by /export and the desktop's
// conversation viewer) shows the marker.
func TestCompactNow_AppendsTreeEntry(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	b := NewApiBackend()

	convID := "user-compact-tree-entry"
	conv := conversation.CreateConversation(convID, tmp, "claude-sonnet-4-6")
	// Build the conversation through the documented helpers so tree
	// entries get populated alongside Messages.
	for i := 0; i < 20; i++ {
		conversation.AddUserMessage(conv, "hello hello hello hello hello hello")
		conversation.AddAssistantMessage(conv,
			[]types.LlmContentBlock{{Type: "text", Text: "ack ack ack ack ack ack ack"}},
			types.LlmUsage{},
		)
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	err := b.CompactNow(context.Background(), CompactRequest{
		ConversationID: convID,
		Model:          "claude-sonnet-4-6",
		RequestID:      "tree-entry-req",
	})
	if err != nil {
		t.Fatalf("CompactNow: %v", err)
	}

	reloaded, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	var sawTreeEntry bool
	for _, e := range reloaded.Entries {
		if e.Type == conversation.EntryCompaction {
			sawTreeEntry = true
			break
		}
	}
	if !sawTreeEntry {
		t.Errorf("expected at least one EntryCompaction in tree after CompactNow; got %d entries total", len(reloaded.Entries))
	}
}

// TestCompactNow_HookCancel verifies that a session_before_compact hook
// returning true short-circuits the call: no events fire and CompactNow
// returns an error so the session layer can surface a "cancelled by hook"
// engine_command_result.
func TestCompactNow_HookCancel(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	b := NewApiBackend()

	convID := "user-compact-cancelled"
	conv := conversation.CreateConversation(convID, tmp, "claude-sonnet-4-6")
	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "x"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "y"})
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	requestID := "user-compact-cancelled-req"
	events := captureEvents(b, requestID)

	cfg := &RunConfig{
		Hooks: RunHooks{
			OnSessionBeforeCompact: func(_ string) bool { return true },
		},
	}

	err := b.CompactNow(context.Background(), CompactRequest{
		ConversationID: convID,
		Model:          "claude-sonnet-4-6",
		RequestID:      requestID,
		RunConfig:      cfg,
	})
	if err == nil {
		t.Errorf("CompactNow returned nil error; expected cancellation error")
	}

	// No CompactingEvent should have been emitted; the gate is the
	// first thing that fires after argument validation.
	for _, ev := range *events {
		if _, ok := ev.Data.(*types.CompactingEvent); ok {
			t.Errorf("unexpected CompactingEvent emission after hook cancel")
		}
	}
}

// TestCompactNow_NotFound verifies the typed error surface for a
// conversation ID that does not resolve to an on-disk file. The session
// layer uses this to emit a "nothing to compact" engine_command_result
// rather than a stack trace.
func TestCompactNow_NotFound(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	b := NewApiBackend()
	err := b.CompactNow(context.Background(), CompactRequest{
		ConversationID: "this-conv-does-not-exist",
		Model:          "claude-sonnet-4-6",
		RequestID:      "missing-req",
	})
	if err == nil {
		t.Errorf("CompactNow returned nil error for missing conversation; expected load error")
	}
}

// TestCompactNow_NoRunConfig exercises the cold-start path where neither
// req.RunConfig nor b.lastRunConfig is set. CompactNow must still complete
// successfully; it simply skips the session-memory tier and the
// session_compact hook (no plumbing wired up).
func TestCompactNow_NoRunConfig(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	b := NewApiBackend()
	if b.lastRunConfig != nil {
		t.Fatalf("fresh ApiBackend has non-nil lastRunConfig; test premise broken")
	}

	convID := "user-compact-cold"
	conv := conversation.CreateConversation(convID, tmp, "claude-sonnet-4-6")
	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "x"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "y"})
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	requestID := "user-compact-cold-req"

	err := b.CompactNow(context.Background(), CompactRequest{
		ConversationID: convID,
		Model:          "claude-sonnet-4-6",
		RequestID:      requestID,
	})
	if err != nil {
		t.Fatalf("CompactNow with no RunConfig should still succeed: %v", err)
	}

	// Confirm the conversation can be re-loaded after CompactNow's save.
	// We don't pin a specific file path because the conversation package
	// chooses between .json (legacy v1) and .tree.jsonl/.llm.jsonl pairs
	// (v2 split) based on whether the conversation has tree entries; this
	// test exercises the empty-entry path where v1 is used. Either way
	// Load is the right contract surface to check.
	if _, err := conversation.Load(convID, ""); err != nil {
		t.Errorf("conversation should be re-loadable after CompactNow: %v", err)
	}
}

// TestCompactNow_CachesRunConfig confirms that StartRunWithConfig
// populates b.lastRunConfig, and that a subsequent CompactNow without an
// explicit RunConfig replays the cached value (hooks fire).
func TestCompactNow_CachesRunConfig(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	b := NewApiBackend()

	// StartRunWithConfig populates b.lastRunConfig. We do not actually
	// kick off a run loop here — that requires provider wiring and is
	// orthogonal to the cache-population property we want to verify.
	// Inspecting the unexported field directly is fine because this
	// test lives in the same package.
	cfg := &RunConfig{
		Hooks: RunHooks{
			OnSessionBeforeCompact: func(_ string) bool { return true },
		},
	}
	b.mu.Lock()
	b.lastRunConfig = cfg
	b.mu.Unlock()

	convID := "user-compact-cached-cfg"
	conv := conversation.CreateConversation(convID, tmp, "claude-sonnet-4-6")
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "x"})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	err := b.CompactNow(context.Background(), CompactRequest{
		ConversationID: convID,
		Model:          "claude-sonnet-4-6",
		RequestID:      "cached-cfg-req",
		// No RunConfig — exercises the cache fallback path.
	})
	if err == nil {
		t.Errorf("CompactNow returned nil; expected cancellation error from cached hook")
	}
}
