package backend

import (
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (b *ApiBackend) emitMaxTurns(run *activeRun, conv *conversation.Conversation, maxTurns, turn int) {
	if err := conversation.Save(conv, ""); err != nil {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation", map[string]any{
			"error": utils.ErrStr(err),
		})
	}

	elapsed := time.Since(run.startTime).Milliseconds()
	b.emit(run, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
		Reason:            types.TaskCompletionReasonMaxTurns,
		Result:            fmt.Sprintf("Reached max turns (%d)", maxTurns),
		LastText:          run.lastNonEmptyResultText,
		CostUsd:           run.totalCost,
		DurationMs:        elapsed,
		NumTurns:          turn,
		ConversationTurns: conversation.CountUserPrompts(conv),
		SessionID:         conv.ID,
		Usage:             cumulativeUsage(run),
	}})
	utils.LogWithFields(utils.LevelWarn, "backend.runloop", "max turns exceeded: / cost=$", map[string]any{
		"run_id":     run.requestID,
		"turns":      turn,
		"max_turns":  maxTurns,
		"total_cost": run.totalCost,
	})
	b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
}
