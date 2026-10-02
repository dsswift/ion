package session

import (
	"errors"
	"os"
	"testing"

	"github.com/dsswift/ion/engine/internal/session/extcontext"
)

var _ extcontext.ConversationRecordAccessor = (*sessionAccessor)(nil)

func TestConversationRecordPath_EmptyWithNoConversation(t *testing.T) {
	setupPrincipalGuardTest(t)
	acc := &sessionAccessor{s: &engineSession{principal: principalFor("oidc:alice")}, key: "k"}
	if got := acc.ConversationRecordPath(); got != "" {
		t.Errorf("ConversationRecordPath with no conversation = %q, want empty", got)
	}
}

func TestConversationRecordPath_NamesTheSessionsRecord(t *testing.T) {
	setupPrincipalGuardTest(t)
	id := savedConversationOwnedBy(t, "oidc:alice")
	acc := &sessionAccessor{s: &engineSession{conversationID: id, principal: principalFor("oidc:alice")}, key: "k"}

	path := acc.ConversationRecordPath()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("record not at reported path %q: %v", path, err)
	}
}

// A session reads a record that is not its own and has no live session: the
// finished-conversation case.
func TestReadConversation_ReadsAFinishedRecordByID(t *testing.T) {
	setupPrincipalGuardTest(t)
	finished := savedConversationOwnedBy(t, "oidc:alice")
	acc := &sessionAccessor{s: &engineSession{principal: principalFor("oidc:alice")}, key: "k"}

	record, err := acc.ReadConversation(finished, 0, 10)
	if err != nil {
		t.Fatalf("ReadConversation: %v", err)
	}
	if len(record.Messages) != 1 || record.Total != 1 || record.HasMore {
		t.Fatalf("record = %d messages, total %d, hasMore %v; want 1, 1, false", len(record.Messages), record.Total, record.HasMore)
	}
	if record.Messages[0].Timestamp == 0 {
		t.Error("message has no timestamp")
	}
}

func TestReadConversation_RefusesAnotherPrincipalsRecordUnderStrict(t *testing.T) {
	setupPrincipalGuardTest(t)
	theirs := savedConversationOwnedBy(t, "oidc:alice")
	acc := &sessionAccessor{s: &engineSession{principal: principalFor("oidc:bob")}, key: "k"}

	if _, err := acc.ReadConversation(theirs, 0, 0); !errors.Is(err, ErrConversationNotOwned) {
		t.Fatalf("cross-principal read error = %v, want ErrConversationNotOwned", err)
	}
}
