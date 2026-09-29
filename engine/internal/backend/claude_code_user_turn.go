package backend

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// announceUserTurnPersisted emits UserTurnPersistedEvent for a run whose
// opening user turn the session layer already wrote to the conversation
// (RunOptions.PrePersistedUserEntryID). This backend writes no user turn
// itself, so that id is the only one it can announce; with none set there is
// no persisted entry to name and nothing is emitted. Both outcomes are logged.
func (b *ClaudeCodeBackend) announceUserTurnPersisted(runID string, opts types.RunOptions) {
	if opts.PrePersistedUserEntryID == "" {
		utils.LogWithFields(utils.LevelDebug, "backend.claude_code", "no pre-persisted user turn to announce", map[string]any{
			"run_id": runID,
		})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "announcing persisted user turn", map[string]any{
		"run_id":   runID,
		"entry_id": opts.PrePersistedUserEntryID,
	})
	b.emit(runID, userTurnPersistedEvent(opts, opts.PrePersistedUserEntryID))
}
