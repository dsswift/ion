package extcontext

import (
	"github.com/dsswift/ion/engine/internal/types"
)

func completedChildResultMessages(results []ChildResultRecord) []types.LlmMessage {
	if len(results) == 0 {
		return nil
	}
	return []types.LlmMessage{{
		Role:    "user",
		Content: buildReviveResumePrompt(results),
	}}
}
