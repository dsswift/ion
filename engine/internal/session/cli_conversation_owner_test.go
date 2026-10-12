package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func ownerOnDisk(t *testing.T, convID string) string {
	t.Helper()
	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("load conversation: %v", err)
	}
	if conv.Principal == nil {
		return ""
	}
	return conv.Principal.Subject
}

// A delegated-CLI conversation never reaches the API runloop, so its first
// write is the only place its owner can be recorded. A record saved without
// one is refused to its own owner on resume once partitioning is enforced.
func TestDispatch_DelegatedCliFirstWriteRecordsTheOwner(t *testing.T) {
	for _, recovery := range []bool{false, true} {
		name := "recovery off"
		if recovery {
			name = "recovery on"
		}
		t.Run(name, func(t *testing.T) {
			t.Setenv("HOME", t.TempDir())
			mgr := NewManager(&nativeSessionMockBackend{mockBackend: newMockBackend()})
			cfg := defaultConfig()
			cfg.RunRecovery = &types.RunRecoveryConfig{Enabled: &recovery}
			_, _ = mgr.StartSession("cli-owner", cfg)

			const convID = "1784000000081-aaaaaaaaaaaa"
			mgr.mu.Lock()
			s := mgr.sessions["cli-owner"]
			s.conversationID = convID
			s.principal = &types.SessionPrincipal{Subject: "local:alice", Provider: "os", Kind: "local"}
			mgr.mu.Unlock()

			if err := mgr.SendPrompt("cli-owner", "hello", nil); err != nil {
				t.Fatalf("send prompt: %v", err)
			}
			if got := ownerOnDisk(t, convID); got != "local:alice" {
				t.Fatalf("the first write must record the session's owner, got %q", got)
			}
		})
	}
}

// Run exit creates the record when nothing wrote it at dispatch.
func TestPersistCliTurn_CreatedRecordCarriesTheOwner(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(&nativeSessionMockBackend{mockBackend: newMockBackend()})
	_, _ = mgr.StartSession("cli-owner-exit", defaultConfig())

	const convID = "1784000000082-bbbbbbbbbbbb"
	mgr.mu.Lock()
	s := mgr.sessions["cli-owner-exit"]
	s.conversationID = convID
	s.principal = &types.SessionPrincipal{Subject: "local:alice", Provider: "os", Kind: "local"}
	s.pendingCliUserTurn = "hello"
	s.pendingCliAssistantText = "hi"
	mgr.mu.Unlock()

	mgr.persistCliTurn("cli-owner-exit", convID)

	if got := ownerOnDisk(t, convID); got != "local:alice" {
		t.Fatalf("a record created at run exit must carry the session's owner, got %q", got)
	}
}
