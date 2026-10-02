package extcontext

import "github.com/dsswift/ion/engine/internal/extension"

// ConversationRecordAccessor is the optional SessionAccessor capability
// behind Context.ConversationRecordPath and Context.ReadConversation. An
// accessor that does not implement it leaves both unset.
type ConversationRecordAccessor interface {
	// ConversationRecordPath returns the absolute path of the session's
	// conversation record, or empty when no conversation is active.
	ConversationRecordPath() string
	// ReadConversation reads one page of a conversation record by ID, subject
	// to the session principal's read access. limit <= 0 means no page cap.
	ReadConversation(conversationID string, offset, limit int) (*extension.ConversationRecord, error)
}
