package session

import (
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ErrConversationNotOwned is returned by checkConversationAccess when
// partitioning enforcement refuses the calling principal access to a
// conversation it does not own. Callers surface this as a typed refusal
// rather than a generic error string so a client can distinguish "not
// found" from "found, but not yours".
var ErrConversationNotOwned = errors.New("conversation is owned by a different principal")

// checkConversationAccess is FR-01's engine-side enforcement point: the
// storage-layer partitioning (conversation.resolveDir) already puts each
// conversation in its owner's directory, but resolveDir itself answers
// "where does this id live" for ANY caller -- it has no notion of who is
// asking. This function is what actually stops principal A from binding a
// session to principal B's conversation ID once partitioning is enabled.
//
// Enforcement levels (conversation.PartitioningEnforcement):
//   - EnforcementNone / partitioning disabled: always allowed (today's
//     behavior, unchanged).
//   - EnforcementReadOnly: a cross-principal READ (write=false) is allowed;
//     a cross-principal WRITE is refused.
//   - EnforcementStrict: any cross-principal access is refused, read or
//     write.
//
// An UNATTRIBUTED caller (principal == nil) may only access UNATTRIBUTED
// conversations (no owner recorded) -- symmetric with the storage layer's
// own rule that an unattributed session never sees a partition. A
// conversation with no owner is accessible to any unattributed caller
// (today's single-tenant-desktop shape, unchanged) but never to an
// attributed one once partitioning is enabled, matching resolveDir's own
// "unattributed conversations never live in a partition" invariant.
func checkConversationAccess(principal *types.SessionPrincipal, convID string, write bool) error {
	if convID == "" {
		return nil
	}
	enforcement := conversation.PartitioningEnforcement()
	if enforcement == types.EnforcementNone {
		return nil
	}

	owner, hasFile := conversationOwner(convID)
	callerSubject := ""
	if principal != nil {
		callerSubject = principal.Subject
	}

	if owner == callerSubject {
		return nil
	}
	if !hasFile {
		// No backing file yet (a fresh mint, not a resume) -- nothing to own
		// yet, so nothing to refuse. The conversation is about to be created
		// and will be attributed to the caller at mint time.
		return nil
	}
	if enforcement == types.EnforcementReadOnly && !write {
		return nil
	}

	utils.LogWithFields(utils.LevelWarn, "session.principal_guard", "conversation access refused: not the owning principal", map[string]any{
		"conversation_id": convID, "caller_subject": callerSubject, "owner_subject": owner, "write": write, "enforcement": string(enforcement),
	})
	return fmt.Errorf("%w: conversation %q", ErrConversationNotOwned, convID)
}

// storageRootFor returns the absolute directory principal's conversations
// live under, when partitioning is enabled and principal is non-nil; empty
// otherwise. Populates StartSessionResult.StorageRoot.
func storageRootFor(principal *types.SessionPrincipal) string {
	if principal == nil || principal.Subject == "" || !conversation.PartitioningEnabled() {
		return ""
	}
	return conversation.PartitionConversationsDir(principal.Subject)
}

// conversationOwner returns the subject recorded on convID's durable header,
// and whether a backing file exists at all. Reads the header directly
// (conversation.LoadReadOnly, so an ownership check never writes to the
// record) rather than trusting resolveDir's index alone, since
// the index only tells us WHERE the file is, not who owns it -- the marker
// of record is the conversation's own Principal field, stamped at mint.
func conversationOwner(convID string) (subject string, exists bool) {
	if !conversation.Exists(convID, "") {
		return "", false
	}
	conv, err := conversation.LoadReadOnly(convID)
	if err != nil || conv == nil || conv.Principal == nil {
		return "", true
	}
	return conv.Principal.Subject, true
}
