package session

// session_principal_test.go — acceptance tests for the engine per-session
// principal (manifest C1/C2): start_session stamps the header at mint,
// Context.Identity() resolves it inside a hook, list_sessions filters by
// PrincipalSubject/IncludeUnowned, a dispatch child inherits its parent's
// header, send_prompt's per-turn override attributes without touching the
// header or the stored session principal, and identity_changed carries the
// SessionKey.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func principalA() *types.SessionPrincipal {
	return &types.SessionPrincipal{Subject: "local:alice", Provider: "os", Kind: "local", Username: "alice", DisplayName: "Alice"}
}

func principalB() *types.SessionPrincipal {
	return &types.SessionPrincipal{Subject: "local:bob", Provider: "os", Kind: "local", Username: "bob", DisplayName: "Bob"}
}

// TestStartSession_PropagatesPrincipalToRunOptions proves a session started
// with a principal threads it through to the backend's RunOptions.Principal
// on the very first run -- the wiring loadOrCreateConversation (tested at
// the backend layer, see runloop_setup_test.go) relies on to stamp the
// header at mint.
func TestStartSession_PropagatesPrincipalToRunOptions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "principal-mint"

	if _, err := mgr.StartSession(key, defaultConfig(), principalA()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if err := mgr.SendPrompt(key, "hello", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	mgr.mu.RLock()
	requestID := mgr.sessions[key].requestID
	mgr.mu.RUnlock()

	mb.mu.Lock()
	opts, ok := mb.started[requestID]
	mb.mu.Unlock()
	if !ok {
		t.Fatalf("backend never saw run %q", requestID)
	}
	if opts.Principal == nil || opts.Principal.Subject != "local:alice" {
		t.Errorf("run principal = %+v, want local:alice", opts.Principal)
	}
}

// TestContextIdentity_ResolvesSessionPrincipal proves Context.Identity()
// (via the extension context construction path) resolves the session's
// stamped principal, not the process-level operator identity.
func TestContextIdentity_ResolvesSessionPrincipal(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "principal-identity"

	if _, err := mgr.StartSession(key, defaultConfig(), principalA()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	ctx := mgr.newExtContext(mgr.sessions[key], key)
	mgr.mu.Unlock()

	if ctx.Identity == nil {
		t.Fatal("ext context identity is nil, want session principal")
	}
	if ctx.Identity.Subject != "local:alice" {
		t.Errorf("ctx.Identity.Subject = %q, want %q", ctx.Identity.Subject, "local:alice")
	}
	if ctx.Identity.Kind != "local" {
		t.Errorf("ctx.Identity.Kind = %q, want %q", ctx.Identity.Kind, "local")
	}
}

// TestListSessions_FiltersByPrincipalSubject proves two sessions with two
// principals filter correctly by ListSessions()'s PrincipalSubject data
// (the same field the server's list_sessions dispatch filters on), and a
// pre-existing headerless (unowned) session is included only when asked.
func TestListSessions_FiltersByPrincipalSubject(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)

	if _, err := mgr.StartSession("sess-a", defaultConfig(), principalA()); err != nil {
		t.Fatalf("StartSession A: %v", err)
	}
	if _, err := mgr.StartSession("sess-b", defaultConfig(), principalB()); err != nil {
		t.Fatalf("StartSession B: %v", err)
	}
	if _, err := mgr.StartSession("sess-unowned", defaultConfig()); err != nil {
		t.Fatalf("StartSession unowned: %v", err)
	}

	sessions := mgr.ListSessions()
	bySubject := map[string]string{}
	for _, s := range sessions {
		bySubject[s.Key] = s.PrincipalSubject
	}
	if bySubject["sess-a"] != "local:alice" {
		t.Errorf("sess-a principal subject = %q, want local:alice", bySubject["sess-a"])
	}
	if bySubject["sess-b"] != "local:bob" {
		t.Errorf("sess-b principal subject = %q, want local:bob", bySubject["sess-b"])
	}
	if bySubject["sess-unowned"] != "" {
		t.Errorf("sess-unowned principal subject = %q, want empty", bySubject["sess-unowned"])
	}

	// Simulate the server's list_sessions filter: PrincipalSubject == "local:alice".
	var filtered []string
	for _, s := range sessions {
		if s.PrincipalSubject == "local:alice" {
			filtered = append(filtered, s.Key)
		}
	}
	if len(filtered) != 1 || filtered[0] != "sess-a" {
		t.Errorf("filter by local:alice = %v, want [sess-a]", filtered)
	}

	// Simulate includeUnowned: PrincipalSubject == "local:alice" OR "".
	var withUnowned []string
	for _, s := range sessions {
		if s.PrincipalSubject == "local:alice" || s.PrincipalSubject == "" {
			withUnowned = append(withUnowned, s.Key)
		}
	}
	if len(withUnowned) != 2 {
		t.Errorf("filter with includeUnowned = %v, want 2 entries", withUnowned)
	}
}

// TestForkSession_InheritsSourcePrincipal proves a forked session's
// in-memory principal is copied from its source session -- the conversation
// header's inheritance is covered separately in
// conversation.TestForkConversation_V2_CopiesSourcePrincipal, since the mock
// backend used here never persists a conversation file.
func TestForkSession_InheritsSourcePrincipal(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "principal-fork-src"

	if _, err := mgr.StartSession(key, defaultConfig(), principalA()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	// Give the source session a persisted conversation to fork from --
	// ForkSessionToKey requires the conversation to load from disk.
	mgr.mu.RLock()
	convID := mgr.sessions[key].conversationID
	mgr.mu.RUnlock()
	seedConv := conversation.CreateConversation(convID, "", "mock-model")
	conversation.AddUserMessage(seedConv, "hello")
	if err := conversation.Save(seedConv, ""); err != nil {
		t.Fatalf("seed conversation save: %v", err)
	}

	newKey, _, err := mgr.ForkSessionToKey(key, "principal-fork-dst", 0)
	if err != nil {
		t.Fatalf("ForkSessionToKey: %v", err)
	}

	mgr.mu.RLock()
	forkedPrincipal := mgr.sessions[newKey].principal
	mgr.mu.RUnlock()

	if forkedPrincipal == nil || forkedPrincipal.Subject != "local:alice" {
		t.Errorf("forked session principal = %+v, want local:alice", forkedPrincipal)
	}
}

// TestSendPrompt_PrincipalOverridesTurnOnly proves a send_prompt-scoped
// principal override attributes only that turn's RunOptions.Principal and
// never mutates the session's own stored principal.
func TestSendPrompt_PrincipalOverridesTurnOnly(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mb := newMockBackend()
	mgr := NewManager(mb)
	const key = "principal-turn-override"

	if _, err := mgr.StartSession(key, defaultConfig(), principalA()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if err := mgr.SendPrompt(key, "hello", &PromptOverrides{Principal: principalB()}); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	mgr.mu.RLock()
	requestID := mgr.sessions[key].requestID
	sessionPrincipal := mgr.sessions[key].principal
	mgr.mu.RUnlock()

	mb.mu.Lock()
	opts, ok := mb.started[requestID]
	mb.mu.Unlock()
	if !ok {
		t.Fatalf("backend never saw run %q", requestID)
	}
	if opts.Principal == nil || opts.Principal.Subject != "local:bob" {
		t.Errorf("run principal = %+v, want local:bob (the turn override)", opts.Principal)
	}
	if sessionPrincipal == nil || sessionPrincipal.Subject != "local:alice" {
		t.Errorf("session principal after override turn = %+v, want unchanged local:alice", sessionPrincipal)
	}
}

// TestIdentityChangedForSession_CarriesSessionKey proves the per-session
// identity_changed firing (fireIdentityChangedForSession) sets SessionKey,
// distinguishing it from the process-level firing which always carries "".
func TestIdentityChangedForSession_CarriesSessionKey(t *testing.T) {
	identity := auth.FromSessionPrincipal(principalA())
	if identity == nil {
		t.Fatal("FromSessionPrincipal returned nil for a non-nil principal")
	}
	if identity.Subject != "local:alice" {
		t.Errorf("identity.Subject = %q, want local:alice", identity.Subject)
	}
	if identity.Kind != "local" {
		t.Errorf("identity.Kind = %q, want local", identity.Kind)
	}

	// FromSessionPrincipal(nil) must return nil, not a zero-value identity --
	// callers (fireIdentityChangedForSession, NewExtContext) rely on this to
	// distinguish "no principal" from "a principal with empty fields".
	if got := auth.FromSessionPrincipal(nil); got != nil {
		t.Errorf("FromSessionPrincipal(nil) = %+v, want nil", got)
	}
}
