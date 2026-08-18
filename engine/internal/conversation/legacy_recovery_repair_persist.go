package conversation

import "github.com/dsswift/ion/engine/internal/utils"

// persistRecoveryRepairIfNeeded commits the one-time repair version before a
// caller receives the conversation. The per-conversation funnel keeps this
// write from erasing a concurrent live-run mutation. A failed write retains the
// old on-disk marker, so a later load retries.
func persistRecoveryRepairIfNeeded(conv *Conversation, dir string) {
	if conv == nil || !conv._recoveryRepairPending || conv.ID == "" {
		return
	}
	version := conv.RecoveryRepairVersion
	err := UpdateOnDisk(conv.ID, dir, func(current *Conversation) (bool, error) {
		if current.RecoveryRepairVersion >= version {
			return false, nil
		}
		// Re-run only for this first serialized repair write. The returned load
		// object is already repaired; this owner-aware object receives the same
		// precise mutations before it is saved.
		repairLegacyRecoveryState(current)
		current._recoveryRepairPending = false
		return true, nil
	})
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "conversation.recovery_repair", "could not persist repair version; will retry on next load", map[string]any{"conversation_id": conv.ID, "error": err.Error()})
		return
	}
	conv._recoveryRepairPending = false
	utils.LogWithFields(utils.LevelInfo, "conversation.recovery_repair", "persisted repair version", map[string]any{"conversation_id": conv.ID, "version": version})
}
