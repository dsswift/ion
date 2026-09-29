package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// prePersistCliUserTurn writes a delegated-CLI run's opening user turn to the
// conversation at dispatch and returns its entry id.
//
// A delegated CLI persists nothing itself; the session writes its turn. Doing
// that at run exit left the turn with no id for the whole run, so the run could
// not announce it (UserTurnPersistedEvent) and a history load mid-run did not
// contain the turn the user had just sent. Engine-owned backends already write
// the turn before streaming; this gives delegated runs the same ordering.
//
// Run recovery writes the same entry as part of its journal commit, so this is
// only called when recovery did not. Returns "" when there is no conversation
// yet or the write failed; persistCliTurn then writes the turn at exit, as it
// did before, so a failure here costs the early id and never the turn.
func (m *Manager) prePersistCliUserTurn(s *engineSession, key string, opts types.RunOptions) string {
	if s.conversationID == "" {
		utils.LogWithFields(utils.LevelDebug, "session.native_session", "cli user turn not pre-persisted: no conversation id", map[string]any{"key": key})
		return ""
	}
	var userEntryID string
	err := conversation.UpdateOrCreateOnDisk(s.conversationID, "", func() *conversation.Conversation {
		return conversation.CreateConversation(s.conversationID, "", opts.Model)
	}, func(conv *conversation.Conversation) (bool, error) {
		if userEntry := backend.AppendInboundUserMessage(conv, &opts); userEntry != nil {
			userEntryID = userEntry.ID
		}
		return true, nil
	})
	if err != nil {
		utils.LogWithFields(utils.LevelError, "session.native_session", "cli user turn pre-persist failed; the turn will be written at run exit", map[string]any{
			"key": key, "conversation_id": s.conversationID, "error": err.Error(),
		})
		return ""
	}
	utils.LogWithFields(utils.LevelInfo, "session.native_session", "cli user turn pre-persisted", map[string]any{
		"key": key, "conversation_id": s.conversationID, "user_entry_id": userEntryID,
	})
	return userEntryID
}
