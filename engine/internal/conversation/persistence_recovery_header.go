package conversation

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// decodeTreeHeaderRecovery restores optional active-run recovery metadata from
// the split tree header. A malformed journal never makes conversation history
// unreadable: it is dropped and logged, leaving the caller with normal resume.
func decodeTreeHeaderRecovery(conv *Conversation, header map[string]any) {
	conv.RecoveryRepairVersion = int(jsonFloat(header, "recoveryRepairVersion", 0))
	rawActiveRun, ok := header["activeRun"]
	if !ok || rawActiveRun == nil {
		return
	}
	activeRunBytes, err := json.Marshal(rawActiveRun)
	if err == nil {
		var activeRun RunJournalEntry
		if err = json.Unmarshal(activeRunBytes, &activeRun); err == nil {
			conv.ActiveRun = &activeRun
		}
	}
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "conversation", "load: dropping malformed activeRun header", map[string]any{
			"conversation_id": conv.ID, "error": err.Error(),
		})
	}
}
