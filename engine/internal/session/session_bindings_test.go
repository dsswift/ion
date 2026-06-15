package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

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
	bindPath := filepath.Join(t.TempDir(), "session-bindings.json")
	t.Setenv("ION_SESSION_BINDINGS_PATH", bindPath)

	m := NewManager(newMockBackend())
	defer m.Shutdown()

	// Pre-seed the binding store as if the engine had previously run with
	// this key and conversation.
	const key = "test-tab"
	const originalConvID = "1700000000000-abcdef123456"
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

func TestStartSession_PreMintWhenNoBinding(t *testing.T) {
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
	// The new id should be persisted in the binding store.
	if bound := lookupBinding(bindPath, "fresh-tab"); bound != result.ConversationID {
		t.Errorf("binding not persisted: got %q want %q", bound, result.ConversationID)
	}
}

func TestStartSession_ExplicitSessionIDBypassesBinding(t *testing.T) {
	bindPath := filepath.Join(t.TempDir(), "session-bindings.json")
	t.Setenv("ION_SESSION_BINDINGS_PATH", bindPath)

	m := NewManager(newMockBackend())
	defer m.Shutdown()

	// Pre-seed binding with an old id.
	saveBinding(bindPath, "tab-explicit", "old-conv-id")

	// Caller supplies an explicit SessionID (new tab or explicit override).
	cfg := types.EngineConfig{
		WorkingDirectory: t.TempDir(),
		SessionID:        "explicit-conv-id",
	}
	result, err := m.StartSession("tab-explicit", cfg)
	if err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	// Explicit id must win over the bound id.
	if result.ConversationID != "explicit-conv-id" {
		t.Errorf("explicit sessionId should win: got %q want %q", result.ConversationID, "explicit-conv-id")
	}
}

// Acceptance test (c) for issue #231: the explicit fresh-conversation path must
// allocate a NEW conversationId even when a persisted binding exists, and the
// binding store must be updated so the old conversation is no longer
// auto-resumed for this key.
func TestStartSession_ForceNewConversationBypassesBinding(t *testing.T) {
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

	// The binding store must now hold the NEW id, so the old conversation is no
	// longer reachable via this key on a subsequent restart-style resume.
	if bound := lookupBinding(bindPath, key); bound != result.ConversationID {
		t.Errorf("binding not replaced with new id: got %q want %q", bound, result.ConversationID)
	}
	if bound := lookupBinding(bindPath, key); bound == originalConvID {
		t.Errorf("old conversation still bound after force-new: %q", originalConvID)
	}
}
