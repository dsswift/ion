package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestSessionAccessor_ListAllSessions_FiltersByCallerPrincipal pins the A2c
// fix: ListAllSessions (the backing implementation of the SDK's
// ctx.sessions.list()) used to return EVERY engine session unfiltered. On a
// shared multi-tenant engine, an extension running in one tenant's session
// could enumerate every other tenant's session key, conversation id, and
// extension name. It now returns only sessions sharing the calling session's
// own principal.
func TestSessionAccessor_ListAllSessions_FiltersByCallerPrincipal(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	alice := &types.SessionPrincipal{Subject: "oidc:alice"}
	bob := &types.SessionPrincipal{Subject: "oidc:bob"}

	if _, err := mgr.StartSession("alice-1", defaultConfig(), alice); err != nil {
		t.Fatalf("StartSession alice-1: %v", err)
	}
	if _, err := mgr.StartSession("alice-2", defaultConfig(), alice); err != nil {
		t.Fatalf("StartSession alice-2: %v", err)
	}
	if _, err := mgr.StartSession("bob-1", defaultConfig(), bob); err != nil {
		t.Fatalf("StartSession bob-1: %v", err)
	}

	mgr.mu.RLock()
	aliceSession := mgr.sessions["alice-1"]
	mgr.mu.RUnlock()
	if aliceSession == nil {
		t.Fatal("alice-1 session not found after StartSession")
	}

	acc := &sessionAccessor{m: mgr, s: aliceSession, key: "alice-1"}
	entries := acc.ListAllSessions()

	if len(entries) != 2 {
		t.Fatalf("expected 2 entries (alice's own sessions only), got %d: %+v", len(entries), entries)
	}
	seen := map[string]bool{}
	for _, e := range entries {
		seen[e.Key] = true
		if e.PrincipalSubject != "oidc:alice" {
			t.Errorf("entry %q carries subject %q, want oidc:alice", e.Key, e.PrincipalSubject)
		}
	}
	if !seen["alice-1"] || !seen["alice-2"] {
		t.Errorf("expected alice-1 and alice-2 in the list, got %+v", entries)
	}
	if seen["bob-1"] {
		t.Fatal("bob-1 leaked into alice's session list")
	}
}

// TestSessionAccessor_ListAllSessions_NoPrincipalSeesEveryUnownedSession pins
// the single-tenant/local case: every session shares the same empty subject,
// so the equality filter is a no-op and behavior is unchanged from before
// this fix.
func TestSessionAccessor_ListAllSessions_NoPrincipalSeesEveryUnownedSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	if _, err := mgr.StartSession("local-1", defaultConfig()); err != nil {
		t.Fatalf("StartSession local-1: %v", err)
	}
	if _, err := mgr.StartSession("local-2", defaultConfig()); err != nil {
		t.Fatalf("StartSession local-2: %v", err)
	}

	mgr.mu.RLock()
	s := mgr.sessions["local-1"]
	mgr.mu.RUnlock()
	if s == nil {
		t.Fatal("local-1 session not found after StartSession")
	}

	acc := &sessionAccessor{m: mgr, s: s, key: "local-1"}
	entries := acc.ListAllSessions()

	if len(entries) != 2 {
		t.Fatalf("expected 2 unowned sessions visible to an unowned caller, got %d: %+v", len(entries), entries)
	}
}
