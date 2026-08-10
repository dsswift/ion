package backend

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// drainCompletedChildDispatches injects terminal child results at a stable
// run-loop checkpoint. A failed save retains both source records and the staged
// in-memory batch, so retrying persistence cannot lose or duplicate a child
// completion.
func (b *ApiBackend) drainCompletedChildDispatches(run *activeRun, conv *conversation.Conversation) {
	if run.cfg == nil || run.cfg.PeekCompletedChildDispatches == nil {
		return
	}
	if len(run.pendingChildCompletionMessages) == 0 {
		messages, acknowledge := run.cfg.PeekCompletedChildDispatches()
		if len(messages) == 0 {
			return
		}
		for _, message := range messages {
			conversation.AddUserMessageWithKind(conv, message.Content, string(types.InjectionKindAgentCompletion))
		}
		run.pendingChildCompletionMessages = messages
		run.pendingChildCompletionAck = acknowledge
	}

	messages := run.pendingChildCompletionMessages
	if err := conversation.Save(conv, ""); err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "failed to save completed child dispatch results", map[string]any{
			"run_id": run.requestID,
			"count":  len(messages),
			"error":  utils.ErrStr(err),
		})
		return
	}
	if run.pendingChildCompletionAck != nil {
		run.pendingChildCompletionAck()
	}
	run.pendingChildCompletionAck = nil
	run.pendingChildCompletionMessages = nil

	messageLength := 0
	for _, message := range messages {
		messageLength += len(fmt.Sprint(message.Content))
	}
	b.emit(run, types.NormalizedEvent{Data: &types.SteerInjectedEvent{
		MessageLength: messageLength,
	}})
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "completed child dispatch results injected", map[string]any{
		"run_id": run.requestID,
		"count":  len(messages),
	})
}
