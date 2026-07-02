package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// seedConversationFile writes a minimal real conversation to the HOME-resolved
// conversations dir so conversation.Exists(id, "") returns true — i.e. the id
// names a genuine resumable conversation, not a phantom. Tests that want a
// real resume call this; tests exercising the phantom path deliberately do NOT.
func seedConversationFile(t *testing.T, id string) {
	t.Helper()
	conv := conversation.CreateConversation(id, "system", "test-model")
	conversation.AddUserMessage(conv, "seeded turn")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seedConversationFile(%s): %v", id, err)
	}
}

// ─── Basic round-trip ────────────────────────────────────────────────────────

func TestSessionBindings_RoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session-bindings.json")

	saveBinding(path, "tab-abc", "conv-111")
	if got := lookupBinding(path, "tab-abc"); got != "conv-111" {
		t.Errorf("lookup: got %q want %q", got, "conv-111")
	}
}

func TestSessionBindings_MultipleKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session-bindings.json")

	saveBinding(path, "key-a", "conv-aaa")
	saveBinding(path, "key-b", "conv-bbb")

	if got := lookupBinding(path, "key-a"); got != "conv-aaa" {
		t.Errorf("key-a: got %q want %q", got, "conv-aaa")
	}
	if got := lookupBinding(path, "key-b"); got != "conv-bbb" {
		t.Errorf("key-b: got %q want %q", got, "conv-bbb")
	}
}

func TestSessionBindings_LookupMissing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session-bindings.json")

	// File does not exist yet.
	if got := lookupBinding(path, "nonexistent-key"); got != "" {
		t.Errorf("missing key should return empty string: got %q", got)
	}
}

func TestSessionBindings_Update(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session-bindings.json")

	saveBinding(path, "tab-x", "conv-old")
	saveBinding(path, "tab-x", "conv-new")

	if got := lookupBinding(path, "tab-x"); got != "conv-new" {
		t.Errorf("after update: got %q want %q", got, "conv-new")
	}
}

func TestSessionBindings_CorruptFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session-bindings.json")

	// Write invalid JSON.
	_ = os.WriteFile(path, []byte("{not valid json"), 0o644)

	// Should not panic; returns empty string.
	if got := lookupBinding(path, "any-key"); got != "" {
		t.Errorf("corrupt file should return empty string: got %q", got)
	}
}

// ─── StartSession integration tests ──────────────────────────────────────────

func TestStartSession_ResumeFromBinding(t *testing.T) {
	// HOME override so conversation.Exists / Save resolve to a tempdir.
	t.Setenv("HOME", t.TempDir())
	bindPath := filepath.Join(t.TempDir(), "session-bindings.json")
	t.Setenv("ION_SESSION_BINDINGS_PATH", bindPath)

	m := NewManager(newMockBackend())
	defer m.Shutdown()

	// Pre-seed the binding store as if the engine had previously run with
	// this key and conversation — AND the conversation file exists on disk
	// (a genuine resume, not a phantom).
	const key = "test-tab"
	const originalConvID = "1700000000000-abcdef123456"
	seedConversationFile(t, originalConvID)
	saveBinding(bindPath, key, originalConvID)

	// StartSession with empty SessionID should resume the bound conversation.
	cfg := types.EngineConfig{WorkingDirectory: t.TempDir()}
	result, err := m.StartSession(key, cfg)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if result.ConversationID != originalConvID {
		t.Errorf("should resume bound conversationId: got %q want %q", result.ConversationID, originalConvID)
	}
}

// TestStartSession_IgnoresPhantomBinding pins the engine half of the
// phantom-resume fix: a binding pointing at a conversation with NO backing file
// (a pre-mint that was never saved) must NOT be resumed. Resuming it would
// start an empty session under that id while the client still displays the real
// tree — the exact divergence that orphaned this morning's history. The engine
// must ignore the phantom binding and mint a fresh id.
//
// Revert the conversation.Exists guard in resolveConversationID's binding
// branch and this test goes red (it resumes the fileless phantom).
func TestStartSession_IgnoresPhantomBinding(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	bindPath := filepath.Join(t.TempDir(), "session-bindings.json")
	t.Setenv("ION_SESSION_BINDINGS_PATH", bindPath)

	m := NewManager(newMockBackend())
	defer m.Shutdown()

	const key = "phantom-tab"
	const phantomConvID = "1700000000000-deadbeef0000" // NO file seeded.
	saveBinding(bindPath, key, phantomConvID)

	cfg := types.EngineConfig{WorkingDirectory: t.TempDir()}
	result, err := m.StartSession(key, cfg)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if result.ConversationID == phantomConvID {
		t.Fatalf("engine resumed a fileless phantom binding: got %q (should have minted fresh)", phantomConvID)
	}
	if result.ConversationID == "" {
		t.Fatal("expected a freshly minted non-empty conversationId")
	}
}

func TestStartSession_PreMintWhenNoBinding(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	bindPath := filepath.Join(t.TempDir(), "session-bindings.json")
	t.Setenv("ION_SESSION_BINDINGS_PATH", bindPath)

	m := NewManager(newMockBackend())
	defer m.Shutdown()

	// No prior binding for this key: should pre-mint a new id.
	cfg := types.EngineConfig{WorkingDirectory: t.TempDir()}
	result, err := m.StartSession("fresh-tab", cfg)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if result.ConversationID == "" {
		t.Error("pre-mint should produce a non-empty conversationId")
	}
	// The binding for a freshly pre-minted id is DEFERRED until the
	// conversation is first saved — it must NOT be written eagerly, or a
	// started-but-never-saved session would leave a phantom binding for the
	// next restart to resume into an empty conversation. (#230/#231)
	if bound := lookupBinding(bindPath, "fresh-tab"); bound != "" {
		t.Errorf("binding for pre-minted id should be deferred (empty), got %q", bound)
	}
}

// TestFlushPendingBinding_WritesOnlyAfterSave pins the deferred-binding
// contract: flushPendingBinding writes the binding only once the conversation
// file exists. Before the first save it writes nothing (no phantom binding);
// after a save it persists the binding and clears bindingPending.
//
// Revert the conversation.Exists gate in flushPendingBinding and the
// "before-save" assertion goes red (a phantom binding gets written).
func TestFlushPendingBinding_WritesOnlyAfterSave(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	bindPath := filepath.Join(t.TempDir(), "session-bindings.json")
	t.Setenv("ION_SESSION_BINDINGS_PATH", bindPath)

	m := NewManager(newMockBackend())
	defer m.Shutdown()

	const key = "defer-tab"
	cfg := types.EngineConfig{WorkingDirectory: t.TempDir()}
	result, err := m.StartSession(key, cfg)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	convID := result.ConversationID

	// Session is bindingPending and the conversation has not been saved.
	// Flushing now must NOT write a binding (no file → phantom).
	m.flushPendingBinding(key, convID)
	if bound := lookupBinding(bindPath, key); bound != "" {
		t.Fatalf("flush before save wrote a phantom binding: got %q", bound)
	}

	// Save the conversation, then flush again — now the binding must land.
	seedConversationFile(t, convID)
	m.flushPendingBinding(key, convID)
	if bound := lookupBinding(bindPath, key); bound != convID {
		t.Fatalf("flush after save did not persist binding: got %q want %q", bound, convID)
	}

	// bindingPending must be cleared so subsequent flushes are no-ops.
	m.mu.Lock()
	stillPending := m.sessions[key].bindingPending
	m.mu.Unlock()
	if stillPending {
		t.Error("bindingPending should be cleared after a successful flush")
	}
}

func TestStartSession_ExplicitSessionIDResumesWhenFilePresent(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	bindPath := filepath.Join(t.TempDir(), "session-bindings.json")
	t.Setenv("ION_SESSION_BINDINGS_PATH", bindPath)

	m := NewManager(newMockBackend())
	defer m.Shutdown()

	// Pre-seed binding with an old id (also fileless — should be irrelevant).
	saveBinding(bindPath, "tab-explicit", "old-conv-id")

	// Caller supplies an explicit SessionID whose file EXISTS — a genuine
	// resume that must win over the bound id.
	const explicitID = "1700000000000-explicit0001"
	seedConversationFile(t, explicitID)
	cfg := types.EngineConfig{
		WorkingDirectory: t.TempDir(),
		SessionID:        explicitID,
	}
	result, err := m.StartSession("tab-explicit", cfg)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if result.ConversationID != explicitID {
		t.Errorf("explicit sessionId with file should win: got %q want %q", result.ConversationID, explicitID)
	}
}

// TestStartSession_ExplicitSessionIDHonoredWithoutFile pins that an explicit
// SessionID is honored unconditionally, even when no conversation file exists
// yet. The caller is the authoritative source of truth for its own ID — it may
// be starting a brand-new session and the file will be created on the first
// run. The phantom guard (require backing file before honoring) applies only to
// stored bindings (implicit resume), not caller-supplied IDs. This is the
// contract TestStartSessionWithSessionID (integration) asserts; both tests must
// agree. The prior behavior (fall through to a fresh mint when no file) was a
// regression introduced in #256 that broke external consumers.
func TestStartSession_ExplicitSessionIDHonoredWithoutFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	bindPath := filepath.Join(t.TempDir(), "session-bindings.json")
	t.Setenv("ION_SESSION_BINDINGS_PATH", bindPath)

	m := NewManager(newMockBackend())
	defer m.Shutdown()

	const explicitID = "1700000000000-phantom00001" // NO file seeded — new session.
	cfg := types.EngineConfig{
		WorkingDirectory: t.TempDir(),
		SessionID:        explicitID,
	}
	result, err := m.StartSession("tab-explicit-no-file", cfg)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if result.ConversationID != explicitID {
		t.Fatalf("explicit SessionID must be honored even without a backing file: got %q want %q", result.ConversationID, explicitID)
	}
}

// Acceptance test (c) for issue #231: the explicit fresh-conversation path must
// allocate a NEW conversationId even when a persisted binding exists, and the
// binding store must be updated so the old conversation is no longer
// auto-resumed for this key.
func TestStartSession_ForceNewConversationBypassesBinding(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	bindPath := filepath.Join(t.TempDir(), "session-bindings.json")
	t.Setenv("ION_SESSION_BINDINGS_PATH", bindPath)

	m := NewManager(newMockBackend())
	defer m.Shutdown()

	const key = "tab-force-new"
	const originalConvID = "1700000000000-cafebabe0001"
	// Pre-seed the binding as if a prior conversation had been established.
	saveBinding(bindPath, key, originalConvID)

	// StartSession with empty SessionID but ForceNewConversation=true must NOT
	// resume the bound conversation; it must mint a fresh id.
	cfg := types.EngineConfig{
		WorkingDirectory:     t.TempDir(),
		ForceNewConversation: true,
	}
	result, err := m.StartSession(key, cfg)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if result.ConversationID == originalConvID {
		t.Fatalf("force-new should NOT resume the bound conversation: got original %q", originalConvID)
	}
	if result.ConversationID == "" {
		t.Fatal("force-new should produce a non-empty conversationId")
	}

	// The stale binding must be cleared eagerly so the old conversation is no
	// longer auto-resumed for this key on a restart-style resume. The freshly
	// minted conversation's own binding is DEFERRED until its first save, so
	// the store holds no binding for this key right now.
	if bound := lookupBinding(bindPath, key); bound != "" {
		t.Errorf("force-new should clear the stale binding (deferring the new one): got %q", bound)
	}
}
