package extcontext

import (
	"github.com/dsswift/ion/engine/internal/types"
)

// completedChildResultMessages turns durable registry records into the single
// classified prompt shape used by both an active checkpoint and a parked
// resume. The child result is already bounded by RecordChildResult.
func completedChildResultMessages(results []ChildResultRecord) []types.LlmMessage {
	if len(results) == 0 {
		return nil
	}
	return []types.LlmMessage{{
		Role:    "user",
		Content: buildReviveResumePrompt(results),
	}}
}
