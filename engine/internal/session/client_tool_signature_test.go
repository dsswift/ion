package session

// Tests for client-tool signature validity on native-session cursors: codex
// fixes its dynamic-tool set at thread creation, so a resume is only valid
// while the recorded signature equals the live run's. MCP-attach backends
// (claude-code, ACP) never compare signatures. See resolveCliContinuity and
// NativeSessionCursor.ClientToolSignature.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// signatureTestSession stands up a session whose conversation carries a
// cursor for the given kind, with the given recorded signature, and whose
// in-memory map matches — the state a restart-rehydrated codex session holds.
func signatureTestSession(t *testing.T, mgr *Manager, key, convID, kind, cursor, signature string) *engineSession {
	t.Helper()
	_, _ = mgr.StartSession(key, defaultConfig())

	conv := conversation.CreateConversation(convID, "", "gpt-5-codex")
	conversation.AddUserMessage(conv, "earlier turn")
	leaf := conversation.CurrentLeafID(conv)
	conv.NativeSessions = map[string]conversation.NativeSessionCursor{
		kind: {Cursor: cursor, HeadEntryID: leaf, ClientToolSignature: signature},
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.nativeSessions = map[string]conversation.NativeSessionCursor{
		kind: {Cursor: cursor, HeadEntryID: leaf, ClientToolSignature: signature},
	}
	mgr.mu.Unlock()
	return s
}

// TestCliContinuity_CodexSignatureMismatchBridges pins the invalidation: a
// codex cursor recorded under a different client-tool signature must NOT be
// resumed — the resumed thread would silently lack the newly declared tools.
func TestCliContinuity_CodexSignatureMismatchBridges(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewCodexBackend())
	const key, convID = "sig-mismatch", "1784000000001-aaaaaaaaaaaa"
	s := signatureTestSession(t, mgr, key, convID, "codex", "th_old", "old-signature")

	opts := types.RunOptions{Model: "gpt-5-codex", ClientToolSignature: "new-signature"}
	mgr.resolveCliContinuity(s, &opts)

	if opts.CliResumeSessionID != "" {
		t.Fatalf("signature mismatch must bridge, not resume; got resume id %q", opts.CliResumeSessionID)
	}
}

// TestCliContinuity_CodexSignatureMatchResumes pins the positive: an equal
// signature (and an unmoved leaf) resumes exactly as before.
func TestCliContinuity_CodexSignatureMatchResumes(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewCodexBackend())
	const key, convID = "sig-match", "1784000000002-bbbbbbbbbbbb"
	s := signatureTestSession(t, mgr, key, convID, "codex", "th_live", "same-signature")

	opts := types.RunOptions{Model: "gpt-5-codex", ClientToolSignature: "same-signature"}
	mgr.resolveCliContinuity(s, &opts)

	if opts.CliResumeSessionID != "th_live" {
		t.Fatalf("matching signature must resume; got %q", opts.CliResumeSessionID)
	}
}

// TestCliContinuity_CodexLegacyCursorNoSignature pins the migration rule: an
// old cursor with no recorded signature is valid only while the current run
// also declares no client tools ("" == ""); the moment tools are declared,
// the empty recorded signature mismatches and the thread is rebuilt.
func TestCliContinuity_CodexLegacyCursorNoSignature(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewCodexBackend())
	const key, convID = "sig-legacy", "1784000000003-cccccccccccc"
	s := signatureTestSession(t, mgr, key, convID, "codex", "th_legacy", "")

	// No client tools this run: legacy cursor stays valid.
	opts := types.RunOptions{Model: "gpt-5-codex"}
	mgr.resolveCliContinuity(s, &opts)
	if opts.CliResumeSessionID != "th_legacy" {
		t.Fatalf("legacy cursor with no tools declared must resume; got %q", opts.CliResumeSessionID)
	}

	// Tools declared this run: legacy cursor invalidated.
	opts = types.RunOptions{Model: "gpt-5-codex", ClientToolSignature: "first-signature"}
	mgr.resolveCliContinuity(s, &opts)
	if opts.CliResumeSessionID != "" {
		t.Fatalf("legacy cursor must not resume once tools are declared; got %q", opts.CliResumeSessionID)
	}
}

// TestCliContinuity_McpBackendIgnoresSignature pins the transport boundary:
// claude-code attaches its MCP tool server per start, so a signature change
// must NOT invalidate its cursor.
func TestCliContinuity_McpBackendIgnoresSignature(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	const key, convID = "sig-mcp", "1784000000004-dddddddddddd"
	s := signatureTestSession(t, mgr, key, convID, "claude-code", "uuid-live", "")

	opts := types.RunOptions{Model: "claude-sonnet-4-6", ClientToolSignature: "brand-new-signature"}
	mgr.resolveCliContinuity(s, &opts)

	if opts.CliResumeSessionID != "uuid-live" {
		t.Fatalf("MCP-attach backend must ignore the signature and resume; got %q", opts.CliResumeSessionID)
	}
}

// TestClientToolSignature_StableAndOrderInsensitive pins the digest contract:
// equal sets in different order produce one signature; any change to a name,
// schema, or flag produces a different one.
func TestClientToolSignature_StableAndOrderInsensitive(t *testing.T) {
	a := types.ClientToolDef{Name: "A", Description: "a", InputSchema: map[string]any{"type": "object"}}
	b := types.ClientToolDef{Name: "B", HumanWait: true}

	s1 := clientToolSignature([]types.ClientToolDef{a, b})
	s2 := clientToolSignature([]types.ClientToolDef{b, a})
	if s1 == "" || s1 != s2 {
		t.Fatalf("signature must be stable across declaration order: %q vs %q", s1, s2)
	}

	bChanged := b
	bChanged.HumanWait = false
	s3 := clientToolSignature([]types.ClientToolDef{a, bChanged})
	if s3 == s1 {
		t.Fatal("flag change must change the signature")
	}
}
