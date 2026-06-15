package session

import (
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestSendCommand_Clear_FiresSessionStart verifies that dispatching the
// `clear` command re-fires the session_start hook on an already-loaded
// extension group. This is the load-bearing behaviour of the /clear
// checkpoint feature: the harness must get a chance to re-prime the
// now-empty conversation.
//
// In-process hook pattern adapted from engine/internal/extension/sdk_test.go
// (TestHost_InProcessExtension).
func TestSendCommand_Clear_FiresSessionStart(t *testing.T) {
	// HOME override so the engine's conversation.Save/Load (called with "")
	// writes to a tempdir and not the developer's real ~/.ion.
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "clear-fires-session-start"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	// Seed a conversationID so the clear branch actually runs (the engine
	// guards on conversationID != "" before attempting any clear work).
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = "test-conv-" + key
	mgr.mu.Unlock()

	// Persist a stub conversation file so conversation.Load succeeds.
	conv := conversation.CreateConversation(s.conversationID, "system", "test-model")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation save: %v", err)
	}

	// Register an in-process extension whose session_start handler increments
	// a counter. We do NOT fire session_start as part of setup — counter
	// should stay 0 until SendCommand("clear") triggers the re-fire.
	var fired atomic.Int32
	host := extension.NewHost()
	host.SDK().On(extension.HookSessionStart, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		fired.Add(1)
		return nil, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	mgr.TestSetExtGroup(key, group)

	if got := fired.Load(); got != 0 {
		t.Fatalf("session_start fired before /clear: got %d, want 0", got)
	}

	// Dispatch /clear via the manager's command entrypoint.
	mgr.SendCommand(key, "clear", "")

	if got := fired.Load(); got != 1 {
		t.Fatalf("session_start did not re-fire on /clear: got %d, want 1", got)
	}
}

// TestSendCommand_Clear_WipesConversationMessages verifies the existing
// (pre-PR) behaviour of /clear is preserved: it wipes Messages on the
// on-disk conversation file. This was previously untested. We're adding
// it now as a regression net for the load-bearing wipe behaviour.
func TestSendCommand_Clear_WipesConversationMessages(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "clear-wipes-messages"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	// Seed a conversation with at least one persisted message so we can
	// observe the wipe.
	convID := "wipe-test-conv-" + key
	mgr.mu.Lock()
	mgr.sessions[key].conversationID = convID
	mgr.mu.Unlock()

	conv := conversation.CreateConversation(convID, "system", "test-model")
	conv.Messages = []types.LlmMessage{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "world"},
	}
	conv.LastInputTokens = 42
	conv.LastInputTokensMsgCount = 2
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation save: %v", err)
	}

	// Confirm setup wrote what we expect.
	convDir := filepath.Join(tempHome, ".ion", "conversations")
	loaded, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("verify-seed Load: %v", err)
	}
	if len(loaded.Messages) != 2 {
		t.Fatalf("verify-seed: expected 2 messages on disk before clear, got %d", len(loaded.Messages))
	}

	// Dispatch /clear.
	mgr.SendCommand(key, "clear", "")

	// Reload from disk and assert Messages was wiped.
	cleared, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("post-clear Load: %v", err)
	}
	if len(cleared.Messages) != 0 {
		t.Errorf("expected Messages wiped after /clear, got %d messages: %+v", len(cleared.Messages), cleared.Messages)
	}
	if cleared.LastInputTokens != 0 {
		t.Errorf("expected LastInputTokens reset to 0, got %d", cleared.LastInputTokens)
	}
	if cleared.LastInputTokensMsgCount != 0 {
		t.Errorf("expected LastInputTokensMsgCount reset to 0, got %d", cleared.LastInputTokensMsgCount)
	}
}

// TestSendCommand_Clear_NoExtensionsIsOk verifies that /clear on a session
// without any extensions does not panic or error — it should just wipe
// messages and skip the session_start re-fire (because there's nothing to
// fire it on). Normal (non-engine) conversation tabs hit this branch.
func TestSendCommand_Clear_NoExtensionsIsOk(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "clear-no-extensions"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	convID := "no-ext-conv-" + key
	mgr.mu.Lock()
	mgr.sessions[key].conversationID = convID
	mgr.mu.Unlock()

	conv := conversation.CreateConversation(convID, "", "test-model")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}

	// Should not panic. extGroup is nil at this point (no extensions loaded).
	mgr.SendCommand(key, "clear", "")
}

// TestClearConversationFile verifies the stateless file-wipe path used when
// the desktop issues /clear on a tab that has a loaded conversationId but
// has never sent a prompt (so no live engine session exists).
//
// Key invariants:
//   - Messages is nil after the wipe (LLM sees no prior history).
//   - LastInputTokens and LastInputTokensMsgCount are zeroed.
//   - Fields that MUST be preserved (TotalInputTokens, TotalCost, Entries,
//     ID, Model, …) are untouched so the conversation tree, cost accounting,
//     and metadata survive the /clear checkpoint.
func TestClearConversationFile(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	mb := newMockBackend()
	mgr := NewManager(mb)

	const convID = "no-session-clear-conv"
	convDir := filepath.Join(tempHome, ".ion", "conversations")

	// Seed a conversation with messages and non-zero counters.
	conv := conversation.CreateConversation(convID, "system prompt", "test-model")
	conv.Messages = []types.LlmMessage{
		{Role: "user", Content: "msg 1"},
		{Role: "assistant", Content: "reply 1"},
		{Role: "user", Content: "msg 2"},
	}
	conv.LastInputTokens = 500
	conv.LastInputTokensMsgCount = 3
	conv.TotalInputTokens = 1200
	conv.TotalCost = 0.42
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation save: %v", err)
	}

	// Verify seeded state.
	seeded, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("verify-seed Load: %v", err)
	}
	if len(seeded.Messages) != 3 {
		t.Fatalf("verify-seed: expected 3 messages, got %d", len(seeded.Messages))
	}

	// Call ClearConversationFile — no session required.
	if err := mgr.ClearConversationFile(convID); err != nil {
		t.Fatalf("ClearConversationFile: %v", err)
	}

	// Reload and assert wipe.
	cleared, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("post-clear Load: %v", err)
	}

	if len(cleared.Messages) != 0 {
		t.Errorf("Messages not wiped: got %d message(s): %+v", len(cleared.Messages), cleared.Messages)
	}
	if cleared.LastInputTokens != 0 {
		t.Errorf("LastInputTokens not reset: got %d", cleared.LastInputTokens)
	}
	if cleared.LastInputTokensMsgCount != 0 {
		t.Errorf("LastInputTokensMsgCount not reset: got %d", cleared.LastInputTokensMsgCount)
	}

	// Preserved fields must be untouched.
	if cleared.ID != convID {
		t.Errorf("ID changed: got %q, want %q", cleared.ID, convID)
	}
	if cleared.TotalInputTokens != 1200 {
		t.Errorf("TotalInputTokens changed: got %d, want 1200", cleared.TotalInputTokens)
	}
	if cleared.TotalCost != 0.42 {
		t.Errorf("TotalCost changed: got %f, want 0.42", cleared.TotalCost)
	}
}

// TestSendCommand_Clear_ClearsPendingPermissionDenials verifies that /clear
// dismisses any retained AskUserQuestion / ExitPlanMode denial along with the
// conversation history. Without this, the engine keeps re-publishing the stale
// denial on every engine_status snapshot (heartbeat / ReconcileState /
// QuerySessionStatus), so the pending question/plan card reappears after the
// clear. The test asserts BOTH halves of the fix:
//   - the retained slice is wiped on the session (so future snapshots are clean)
//   - the engine_status snapshot emitted by /clear carries empty denials
func TestSendCommand_Clear_ClearsPendingPermissionDenials(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "clear-clears-denials"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	// Seed a conversationID + on-disk file so the clear branch runs fully
	// (it loads/wipes the conversation), and seed a retained denial that
	// /clear must dismiss.
	convID := "denial-conv-" + key
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.lastPermissionDenials = []types.PermissionDenial{
		{
			ToolUseID: "tu-1",
			ToolName:  "AskUserQuestion",
			ToolInput: map[string]any{"question": "Pick one", "options": []string{"A", "B"}},
		},
	}
	mgr.mu.Unlock()

	conv := conversation.CreateConversation(convID, "system", "test-model")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation save: %v", err)
	}

	// Collect engine_status events emitted during /clear.
	var statusEvents []types.EngineEvent
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_status" {
			statusEvents = append(statusEvents, ev)
		}
	})

	mgr.SendCommand(key, "clear", "")

	// Half 1: the retained slice is wiped on the session.
	mgr.mu.Lock()
	got := s.lastPermissionDenials
	mgr.mu.Unlock()
	if len(got) != 0 {
		t.Errorf("expected lastPermissionDenials cleared after /clear, got %d: %+v", len(got), got)
	}

	// Half 2: the engine_status snapshot from /clear carries empty denials.
	if len(statusEvents) == 0 {
		t.Fatal("expected at least one engine_status event from /clear")
	}
	last := statusEvents[len(statusEvents)-1]
	if last.Fields == nil {
		t.Fatal("expected non-nil StatusFields on /clear engine_status")
	}
	if len(last.Fields.PermissionDenials) != 0 {
		t.Errorf("expected empty PermissionDenials on /clear status snapshot, got %d: %+v", len(last.Fields.PermissionDenials), last.Fields.PermissionDenials)
	}
}

// TestClearConversationFile_MissingConv verifies that ClearConversationFile
// treats a missing conversation file as an already-empty success, not an
// error. This is the unified clear contract: a missing file means "there is
// nothing to wipe, so the clear semantically succeeded" — identical to the
// live-session /clear path (dispatchClear), which has always treated
// ErrNotFound as success. Before unification this path returned an error,
// diverging from dispatchClear; the shared clearConversationCore removes that
// divergence. The desktop caller (handleLocalClearShortCircuit) renders the
// clear divider regardless, so success-on-missing is strictly better than a
// spurious RPC error.
func TestClearConversationFile_MissingConv(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.ClearConversationFile("no-such-conv-id")
	if err != nil {
		t.Fatalf("expected nil (already-empty success) for missing conversation file, got %v", err)
	}
}

// TestClearConversationFile_MessagesDurableAfterReload is the end-to-end
// regression guard for issue #146. The root cause was that the legacy
// loadFromJSONL path called BuildContextPath(conv) after loading, which
// reconstructed Messages from Entries — making /clear invisible after a
// process restart (the tree always had N entries → N messages rebuilt).
//
// With the split format (.llm.jsonl + .tree.jsonl), Messages is read verbatim
// from .llm.jsonl. After /clear writes an empty body to .llm.jsonl, a fresh
// Load must return Messages == nil regardless of how many Entries exist in
// .tree.jsonl.
func TestClearConversationFile_MessagesDurableAfterReload(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	mb := newMockBackend()
	mgr := NewManager(mb)

	const convID = "clear-durability-146"
	convDir := filepath.Join(tempHome, ".ion", "conversations")

	// Seed a conversation with 5 messages (and corresponding Entries).
	conv := conversation.CreateConversation(convID, "system", "test-model")
	for i := 0; i < 5; i++ {
		conversation.AddUserMessage(conv, "user message")
		conversation.AddAssistantMessage(conv,
			[]types.LlmContentBlock{{Type: "text", Text: "assistant reply"}},
			types.LlmUsage{InputTokens: 100, OutputTokens: 50})
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed Save: %v", err)
	}

	// Verify seed: 10 messages in the split format.
	seeded, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("seed Load: %v", err)
	}
	if len(seeded.Messages) != 10 {
		t.Fatalf("seed: expected 10 messages, got %d", len(seeded.Messages))
	}
	seedEntryCount := len(seeded.Entries)
	if seedEntryCount != 10 {
		t.Fatalf("seed: expected 10 entries, got %d", seedEntryCount)
	}

	// Apply /clear via ClearConversationFile.
	if err := mgr.ClearConversationFile(convID); err != nil {
		t.Fatalf("ClearConversationFile: %v", err)
	}

	// Reload — this is the critical assertion: Messages must be empty even
	// though Entries still has 10 items. In the buggy code, BuildContextPath
	// would reconstruct 10 messages from the tree.
	cleared, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("post-clear Load: %v", err)
	}
	if len(cleared.Messages) != 0 {
		t.Errorf("BUG #146: Messages not cleared after reload — got %d message(s): %+v",
			len(cleared.Messages), cleared.Messages)
	}
	// Entries must be preserved — /clear is a checkpoint, not a delete.
	if len(cleared.Entries) != seedEntryCount {
		t.Errorf("Entries count changed after clear: got %d, want %d",
			len(cleared.Entries), seedEntryCount)
	}
	if cleared.LastInputTokens != 0 {
		t.Errorf("LastInputTokens = %d after clear, want 0", cleared.LastInputTokens)
	}
}


// TestClearConversationFile_LiveSessionClearsDenialsAndEmits verifies the
// unified clear contract for the file-only path: when a live session owns the
// conversationId, ClearConversationFile reverse-looks-up that session, clears
// its retained AskUserQuestion / ExitPlanMode denials, and emits the shared
// clear signal (engine_status with empty PermissionDenials + an
// engine_command_result{command:"clear"}). This is the regression net for the
// reported bug: a reopened conversation cleared via the file-only path used to
// leave the pending card because the engine emitted no dismissal signal.
func TestClearConversationFile_LiveSessionClearsDenialsAndEmits(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "file-clear-live-session"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	// Seed a conversationId on the session + an on-disk file + a retained
	// denial that the file-only clear must dismiss via reverse lookup.
	convID := "file-clear-conv-" + key
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.lastPermissionDenials = []types.PermissionDenial{
		{ToolUseID: "tu-1", ToolName: "AskUserQuestion", ToolInput: map[string]any{"question": "Pick one"}},
	}
	mgr.mu.Unlock()

	conv := conversation.CreateConversation(convID, "system", "test-model")
	conv.Messages = []types.LlmMessage{{Role: "user", Content: "hi"}}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation save: %v", err)
	}

	// Collect emitted events so we can assert the shared clear signal fires
	// on the owning session key.
	var statusEvents []types.EngineEvent
	var commandResults []types.EngineEvent
	mgr.OnEvent(func(k string, ev types.EngineEvent) {
		switch ev.Type {
		case "engine_status":
			statusEvents = append(statusEvents, ev)
		case "engine_command_result":
			commandResults = append(commandResults, ev)
		}
	})

	// Call the FILE-ONLY path (no session key passed) — it must find the
	// owning session by conversationId.
	if err := mgr.ClearConversationFile(convID); err != nil {
		t.Fatalf("ClearConversationFile: %v", err)
	}

	// Denials cleared on the owning session.
	mgr.mu.Lock()
	got := s.lastPermissionDenials
	mgr.mu.Unlock()
	if len(got) != 0 {
		t.Errorf("expected lastPermissionDenials cleared after file-only clear, got %d: %+v", len(got), got)
	}

	// engine_status with empty denials emitted.
	if len(statusEvents) == 0 {
		t.Fatal("expected at least one engine_status from file-only clear with live session")
	}
	last := statusEvents[len(statusEvents)-1]
	if last.Fields == nil || len(last.Fields.PermissionDenials) != 0 {
		t.Errorf("expected engine_status with empty PermissionDenials, got %+v", last.Fields)
	}

	// engine_command_result{clear} emitted.
	var sawClear bool
	for _, ev := range commandResults {
		if ev.Command == "clear" && ev.CommandError == "" {
			sawClear = true
		}
	}
	if !sawClear {
		t.Errorf("expected engine_command_result{command:clear} from file-only clear, got %+v", commandResults)
	}

	// On-disk Messages wiped.
	convDir := filepath.Join(tempHome, ".ion", "conversations")
	cleared, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("post-clear Load: %v", err)
	}
	if len(cleared.Messages) != 0 {
		t.Errorf("expected Messages wiped, got %d", len(cleared.Messages))
	}
}

// TestClearConversationFile_NoLiveSessionWipesOnly verifies the other half of
// the unified contract: when NO live session owns the conversationId, the
// file is still wiped and no clear signal is emitted (there is no in-memory
// card to dismiss). No panic, no spurious event.
func TestClearConversationFile_NoLiveSessionWipesOnly(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	mb := newMockBackend()
	mgr := NewManager(mb)

	const convID = "orphan-conv-no-session"
	conv := conversation.CreateConversation(convID, "system", "test-model")
	conv.Messages = []types.LlmMessage{{Role: "user", Content: "hi"}, {Role: "assistant", Content: "yo"}}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation save: %v", err)
	}

	var emitted []types.EngineEvent
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_status" || ev.Type == "engine_command_result" {
			emitted = append(emitted, ev)
		}
	})

	if err := mgr.ClearConversationFile(convID); err != nil {
		t.Fatalf("ClearConversationFile: %v", err)
	}

	// No signal emitted (no live session owns it).
	if len(emitted) != 0 {
		t.Errorf("expected no clear signal for orphan conversation, got %d events: %+v", len(emitted), emitted)
	}

	// File still wiped.
	convDir := filepath.Join(tempHome, ".ion", "conversations")
	cleared, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("post-clear Load: %v", err)
	}
	if len(cleared.Messages) != 0 {
		t.Errorf("expected Messages wiped on orphan clear, got %d", len(cleared.Messages))
	}
}

// TestStartSession_IdempotentReusesConversation verifies that a second
// StartSession on the same key returns Existed=true with the same
// conversationId and does not mint a new conversation. This pins the engine
// affordance the desktop's ensureSession relies on: reopening / re-attaching a
// tab resumes the same conversation under the same key instead of spawning a
// fresh session identity.
func TestStartSession_IdempotentReusesConversation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "idempotent-start"
	first, err := mgr.StartSession(key, defaultConfig())
	if err != nil {
		t.Fatalf("first StartSession: %v", err)
	}
	if first.ConversationID == "" {
		t.Fatal("expected a pre-minted conversationId on first start")
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	second, err := mgr.StartSession(key, defaultConfig())
	if err != nil {
		t.Fatalf("second StartSession: %v", err)
	}
	if !second.Existed {
		t.Errorf("expected Existed=true on second StartSession, got false")
	}
	if second.ConversationID != first.ConversationID {
		t.Errorf("expected same conversationId on idempotent start: first=%s second=%s", first.ConversationID, second.ConversationID)
	}
}
