package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestDispatchExport_EmitsSuccessOnEmptyConversation verifies that /export on
// a session with no conversationID emits exactly one engine_command_result
// (success) without hanging. Pre-fix the dispatch returned silently; consumers
// waiting on engine_command_result would deadlock.
func TestDispatchExport_EmitsSuccessOnEmptyConversation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "export-empty-conv"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	// Do NOT set conversationID — simulates a session that has never run a
	// prompt (same branch the old code silently returned on).
	ec := newEventCollector(mgr)

	mgr.SendCommand(key, "export", "")

	results := ec.byType("engine_command_result")
	if len(results) != 1 {
		t.Fatalf("expected 1 engine_command_result, got %d", len(results))
	}
	if results[0].event.CommandError != "" {
		t.Errorf("expected success (empty CommandError), got %q", results[0].event.CommandError)
	}
	if results[0].event.Command != "export" {
		t.Errorf("expected Command=export, got %q", results[0].event.Command)
	}

	// No engine_export payload expected for an empty conversation.
	if exports := ec.byType("engine_export"); len(exports) != 0 {
		t.Errorf("expected no engine_export events, got %d", len(exports))
	}
}

// TestDispatchExport_EmitsSuccessOnMissingConversation verifies that /export
// emits a success engine_command_result when conversation.Load fails with
// ErrNotFound (e.g. pre-minted ID before any prompt was sent). There is
// nothing to export, so the command is a no-op success — consistent with
// the /clear and /compact handlers.
func TestDispatchExport_EmitsSuccessOnMissingConversation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "export-load-failure"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	// Set a conversationID that points to a file that does not exist on disk.
	// conversation.Load will return ErrNotFound. With the pre-minting change,
	// this is the normal state before the first prompt — export treats it as
	// a no-op success (nothing to export).
	mgr.mu.Lock()
	mgr.sessions[key].conversationID = "nonexistent-conv-for-export-test"
	mgr.mu.Unlock()

	ec := newEventCollector(mgr)

	mgr.SendCommand(key, "export", "")

	results := ec.byType("engine_command_result")
	if len(results) != 1 {
		t.Fatalf("expected 1 engine_command_result, got %d", len(results))
	}
	if results[0].event.CommandError != "" {
		t.Errorf("expected empty CommandError (no-op success), got %q", results[0].event.CommandError)
	}
	if results[0].event.Command != "export" {
		t.Errorf("expected Command=export, got %q", results[0].event.Command)
	}

	// No engine_export payload expected when conversation doesn't exist.
	if exports := ec.byType("engine_export"); len(exports) != 0 {
		t.Errorf("expected no engine_export events on missing conversation, got %d", len(exports))
	}
}

// TestDispatchExport_EmitsResultAfterSuccessfulExport verifies the happy path
// and the ordering invariant: engine_export fires BEFORE engine_command_result.
// This mirrors the engine_status / command_result ordering dispatchClear
// documents for the same reason — consumers that render on every engine_export
// event should have the payload before they receive the completion signal.
func TestDispatchExport_EmitsResultAfterSuccessfulExport(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "export-success"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	// Seed a real conversation file so conversation.Load succeeds.
	convID := "export-success-conv"
	mgr.mu.Lock()
	mgr.sessions[key].conversationID = convID
	mgr.mu.Unlock()

	conv := conversation.CreateConversation(convID, "system", "test-model")
	conv.Messages = []types.LlmMessage{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "world"},
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}

	// Collect all events in emission order.
	var ordered []types.EngineEvent
	mgr.OnEvent(func(_ string, e types.EngineEvent) {
		ordered = append(ordered, e)
	})

	mgr.SendCommand(key, "export", "markdown")

	// engine_export must appear before engine_command_result.
	exportIdx := -1
	resultIdx := -1
	for i, e := range ordered {
		switch e.Type {
		case "engine_export":
			if exportIdx == -1 {
				exportIdx = i
			}
		case "engine_command_result":
			if resultIdx == -1 {
				resultIdx = i
			}
		}
	}

	if exportIdx == -1 {
		t.Fatal("engine_export event not emitted")
	}
	if resultIdx == -1 {
		t.Fatal("engine_command_result event not emitted")
	}
	if exportIdx >= resultIdx {
		t.Errorf("ordering violated: engine_export (index %d) must precede engine_command_result (index %d)", exportIdx, resultIdx)
	}

	// The command_result must be a success.
	if ordered[resultIdx].CommandError != "" {
		t.Errorf("expected success result, got CommandError=%q", ordered[resultIdx].CommandError)
	}

	// engine_export payload must be non-empty.
	if ordered[exportIdx].EventMessage == "" {
		t.Errorf("engine_export EventMessage is empty; expected rendered markdown output")
	}
}
