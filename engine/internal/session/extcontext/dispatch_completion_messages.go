package extcontext

import (
	"github.com/dsswift/ion/engine/internal/types"
)

func completedChildResultDeliveries(results []ChildResultRecord) []types.BackgroundWorkDelivery {
	if len(results) == 0 {
		return nil
	}
	items := make([]types.BackgroundWorkItem, 0, len(results))
	for _, result := range results {
		items = append(items, types.BackgroundWorkItem{
			ID: result.ChildID, Source: types.BackgroundWorkSourceAgent, Label: result.Name,
			Status: childResultStatus(result.ExitCode), ExitCode: result.ExitCode,
		})
	}
	return []types.BackgroundWorkDelivery{{
		Content: buildReviveResumePrompt(results),
		Work: types.BackgroundWorkInfo{
			Kind: string(types.InjectionKindAgentCompletion), DeliveryMode: "steer", Items: items,
		},
	}}
}

func childResultStatus(exitCode int) string {
	switch exitCode {
	case 0:
		return "completed"
	case ExitCodeRecalled:
		return "recalled"
	default:
		return "failed"
	}
}
