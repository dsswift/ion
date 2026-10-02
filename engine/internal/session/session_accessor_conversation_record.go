package session

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ConversationRecordPath returns the absolute path of the file the session's
// conversation record is written to, or empty when no conversation is active.
func (a *sessionAccessor) ConversationRecordPath() string {
	subject := ""
	if p := a.s.principal; p != nil {
		subject = p.Subject
	}
	return conversation.RecordPath(a.s.conversationID, subject)
}

// ReadConversation reads one page of a conversation record by ID from disk.
// The session's principal must have read access to it under the configured
// partitioning enforcement. It never writes to the record.
func (a *sessionAccessor) ReadConversation(conversationID string, offset, limit int) (*extension.ConversationRecord, error) {
	fields := map[string]any{"session_id": a.key, "conversation_id": conversationID, "offset": offset, "limit": limit}
	if err := checkConversationAccess(a.s.principal, conversationID, false); err != nil {
		fields["error"] = err.Error()
		utils.LogWithFields(utils.LevelWarn, "session", "extension conversation read refused", fields)
		return nil, err
	}
	page, err := conversation.ReadMessagesPaginated(conversationID, offset, limit)
	if err != nil {
		fields["error"] = err.Error()
		utils.LogWithFields(utils.LevelWarn, "session", "extension conversation read failed", fields)
		return nil, err
	}
	fields["count"], fields["total"] = len(page.Messages), page.Total
	utils.LogWithFields(utils.LevelInfo, "session", "extension conversation read", fields)
	return &extension.ConversationRecord{Messages: page.Messages, Total: page.Total, HasMore: page.HasMore}, nil
}
