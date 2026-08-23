package backend

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// drainCompletedChildDispatches persists and emits each batch only after its
// conversation save succeeds. Child results share one model-facing payload but
// retain item identity for client rendering.
func (b *ApiBackend) drainCompletedChildDispatches(run *activeRun, conv *conversation.Conversation) bool {
	if run.cfg == nil || run.cfg.PeekCompletedChildDispatches == nil {
		return false
	}
	if len(run.pendingChildCompletionMessages) == 0 {
		deliveries, acknowledge := run.cfg.PeekCompletedChildDispatches()
		if len(deliveries) == 0 {
			return false
		}
		entryIDs := make([]string, 0, len(deliveries))
		for _, delivery := range deliveries {
			entry := conversation.AddUserMessageWithBackgroundWork(conv, delivery.Content, delivery.Work)
			if entry != nil {
				entryIDs = append(entryIDs, entry.ID)
			}
		}
		run.pendingChildCompletionMessages = deliveries
		run.pendingChildCompletionEntryIDs = entryIDs
		run.pendingChildCompletionAck = acknowledge
	}

	deliveries := run.pendingChildCompletionMessages
	if err := conversation.Save(conv, ""); err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "failed to save completed child dispatch results", map[string]any{
			"run_id": run.requestID, "count": len(deliveries), "error": utils.ErrStr(err),
		})
		return false
	}
	if run.pendingChildCompletionAck != nil {
		run.pendingChildCompletionAck()
	}
	run.pendingChildCompletionAck = nil
	entryIDs := run.pendingChildCompletionEntryIDs
	run.pendingChildCompletionMessages = nil
	run.pendingChildCompletionEntryIDs = nil

	for index, delivery := range deliveries {
		entryID := ""
		if index < len(entryIDs) {
			entryID = entryIDs[index]
		}
		b.emit(run, types.NormalizedEvent{Data: &types.BackgroundWorkDeliveredEvent{
			EntryID: entryID, Content: delivery.Content, Work: delivery.Work,
		}})
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "completed child dispatch results injected", map[string]any{
		"run_id": run.requestID, "count": len(deliveries),
	})
	return true
}
