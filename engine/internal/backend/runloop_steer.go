package backend

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// drainSteer performs a non-blocking check of the run's steer channel.
// If a steer message is present it is injected into the conversation as a
// user message, persisted, logged, and a SteerInjectedEvent is emitted so
// clients can confirm the steer was captured. Returns true when a steer
// was consumed; false when the channel is empty.
//
// Call sites:
//   - Top of each agent-loop iteration (replaces the inline select): catches
//     steers that arrive between turns.
//   - Before end_turn/stop exit: converts an in-flight steer into a forced
//     continuation instead of letting the session layer start a new run.
//   - After tool results are saved: catches steers that arrived during
//     potentially long tool-execution phases before the next LLM call.
func (b *ApiBackend) drainSteer(run *activeRun, conv *conversation.Conversation) bool {
	select {
	case steerMsg := <-run.steerCh:
		conversation.AddUserMessage(conv, steerMsg)
		if err := conversation.Save(conv, ""); err != nil {
			utils.Log("ApiBackend", fmt.Sprintf(
				"failed to save conversation after steer injection: runID=%s err=%s",
				run.requestID, err.Error(),
			))
		}
		utils.Log("ApiBackend", fmt.Sprintf(
			"steer message injected into conversation: runID=%s msgLen=%d",
			run.requestID, len(steerMsg),
		))
		b.emit(run, types.NormalizedEvent{Data: &types.SteerInjectedEvent{
			MessageLength: len(steerMsg),
		}})
		return true
	default:
		return false
	}
}
