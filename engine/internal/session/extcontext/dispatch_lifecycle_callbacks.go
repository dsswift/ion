package extcontext

import (

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// fireLifecycleCallbacks processes a NormalizedEvent and fires the
// appropriate Phase 2 structured lifecycle callbacks on the opts. Mutates
// the tracking state (toolNames, toolCount, accumulatedText, cumulative
// counters) as a side effect.
func fireLifecycleCallbacks(
	opts *extension.DispatchAgentOpts,
	ev types.NormalizedEvent,
	agentID string,
	toolNames map[string]string,
	toolCount *int,
	accumulatedText *string,
	cumulativeInputTokens, cumulativeOutputTokens *int,
	cumulativeCost *float64,
) {
	switch e := ev.Data.(type) {
	case *types.ToolCallEvent:
		*toolCount++
		toolNames[e.ToolID] = e.ToolName
		if opts.OnToolStart != nil {
			opts.OnToolStart(extension.DispatchToolStartInfo{
				DispatchID: agentID,
				ToolName:   e.ToolName,
				ToolID:     e.ToolID,
			})
		}

	case *types.ToolResultEvent:
		name := toolNames[e.ToolID]
		delete(toolNames, e.ToolID)
		if e.IsError {
			if opts.OnToolError != nil {
				opts.OnToolError(extension.DispatchToolErrorInfo{
					DispatchID: agentID,
					ToolName:   name,
					ToolID:     e.ToolID,
					Content:    e.Content,
				})
			}
		} else {
			if opts.OnToolEnd != nil {
				opts.OnToolEnd(extension.DispatchToolEndInfo{
					DispatchID: agentID,
					ToolName:   name,
					ToolID:     e.ToolID,
					Content:    e.Content,
				})
			}
		}

	case *types.UsageEvent:
		turnInput := 0
		turnOutput := 0
		if e.Usage.InputTokens != nil {
			turnInput = *e.Usage.InputTokens
		}
		if e.Usage.OutputTokens != nil {
			turnOutput = *e.Usage.OutputTokens
		}
		*cumulativeInputTokens += turnInput
		*cumulativeOutputTokens += turnOutput
		// Cost is not carried on UsageEvent, so cumulative cost tracks from
		// TaskCompleteEvent only. For per-turn reporting we pass what we have.
		if opts.OnUsage != nil {
			opts.OnUsage(extension.DispatchUsageInfo{
				DispatchID:             agentID,
				InputTokens:            turnInput,
				OutputTokens:           turnOutput,
				CumulativeInputTokens:  *cumulativeInputTokens,
				CumulativeOutputTokens: *cumulativeOutputTokens,
				CumulativeCost:         *cumulativeCost,
			})
		}

	case *types.TextChunkEvent:
		*accumulatedText += e.Text
		if opts.OnTextDelta != nil {
			opts.OnTextDelta(extension.DispatchTextDeltaInfo{
				DispatchID:  agentID,
				Delta:       e.Text,
				Accumulated: *accumulatedText,
			})
		}

	case *types.TaskCompleteEvent:
		// Update cumulative cost from the authoritative source.
		*cumulativeCost = e.CostUsd

	case *types.PlanProposalEvent:
		if opts.OnPlanProposal != nil {
			info := extension.DispatchPlanProposalInfo{
				Name:          opts.Name,
				AgentID:       agentID,
				PlanFilePath:  e.PlanFilePath,
				PlanSlug:      e.PlanSlug,
				PlanRequested: opts.PlanMode,
			}
			opts.OnPlanProposal(info)
			utils.LogWithFields(utils.LevelInfo, "server", "plan proposal callback fired", map[string]any{"model": opts.Name, "plan_slug": e.PlanSlug, "plan_mode": opts.PlanMode})
		}
	}
}

// truncate shortens s to at most maxLen characters, appending "…" if truncated.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "…"
}
