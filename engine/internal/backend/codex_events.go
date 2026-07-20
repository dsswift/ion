package backend

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/codexrpc"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// codexExit signals that a notification terminated the run.
type codexExit struct {
	code *int
}

// translateCodexNotification converts one codex server notification into zero
// or more NormalizedEvents, mutating per-run translation state (thinking-block
// bookkeeping, accumulated text, tool index). It must be called with the
// backend mutex held; the caller emits the returned events after releasing it.
// A non-nil codexExit means the run has ended.
func translateCodexNotification(run *codexRun, method string, params json.RawMessage) ([]types.NormalizedEvent, *codexExit) {
	if run == nil {
		if method == codexrpc.NotifError {
			return nil, nil
		}
		return nil, nil
	}

	switch method {
	case codexrpc.NotifAgentMessageDelta:
		var d codexrpc.DeltaNotification
		if err := json.Unmarshal(params, &d); err != nil {
			utils.LogWithFields(utils.LevelDebug, "backend.codex", "notification decode failed", map[string]any{"method": method, "error": err.Error()})
		}
		var events []types.NormalizedEvent
		events = append(events, closeThinking(run)...)
		if d.Delta != "" {
			run.lastText += d.Delta
			events = append(events, types.NormalizedEvent{Data: &types.TextChunkEvent{Text: d.Delta}})
		}
		return events, nil

	case codexrpc.NotifReasoningTextDelta:
		var d codexrpc.DeltaNotification
		if err := json.Unmarshal(params, &d); err != nil {
			utils.LogWithFields(utils.LevelDebug, "backend.codex", "notification decode failed", map[string]any{"method": method, "error": err.Error()})
		}
		var events []types.NormalizedEvent
		events = append(events, openThinking(run)...)
		if d.Delta != "" {
			events = append(events, types.NormalizedEvent{Data: &types.ThinkingDeltaEvent{Text: d.Delta}})
		}
		return events, nil

	case codexrpc.NotifItemStarted:
		var n codexrpc.ItemNotification
		if err := json.Unmarshal(params, &n); err != nil {
			utils.LogWithFields(utils.LevelDebug, "backend.codex", "notification decode failed", map[string]any{"method": method, "error": err.Error()})
		}
		if toolName, ok := codexToolName(n.Item.Type); ok {
			idx := run.nextToolIndex
			run.nextToolIndex++
			events := closeThinking(run)
			events = append(events, types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: toolName, ToolID: n.Item.ID, Index: idx}})
			return events, nil
		}
		if n.Item.Type == "reasoning" {
			return openThinking(run), nil
		}
		return nil, nil

	case codexrpc.NotifItemCompleted:
		var n codexrpc.ItemNotification
		if err := json.Unmarshal(params, &n); err != nil {
			utils.LogWithFields(utils.LevelDebug, "backend.codex", "notification decode failed", map[string]any{"method": method, "error": err.Error()})
		}
		if _, ok := codexToolName(n.Item.Type); ok {
			isErr := n.Item.ExitCode != nil && *n.Item.ExitCode != 0
			return []types.NormalizedEvent{{Data: &types.ToolResultEvent{
				ToolID:  n.Item.ID,
				Content: n.Item.AggregatedOutput,
				IsError: isErr,
			}}}, nil
		}
		if n.Item.Type == "reasoning" {
			return closeThinking(run), nil
		}
		if n.Item.Type == "agentMessage" && n.Item.Text != "" {
			run.lastText = n.Item.Text
		}
		// A completed plan item is codex's authoritative native plan proposal
		// (its text supersedes any item/plan/delta stream). Stash it for the
		// notification handler, which bridges it into Ion's plan-file contract
		// after releasing the backend mutex. Not a tool call, not stream text.
		if n.Item.Type == "plan" && n.Item.Text != "" && run.planMode {
			run.pendingPlanMarkdown = n.Item.Text
			return closeThinking(run), nil
		}
		return nil, nil

	case codexrpc.NotifTokenUsageUpdated:
		var n codexrpc.TokenUsageNotification
		if err := json.Unmarshal(params, &n); err != nil {
			utils.LogWithFields(utils.LevelDebug, "backend.codex", "notification decode failed", map[string]any{"method": method, "error": err.Error()})
		}
		return []types.NormalizedEvent{{Data: &types.UsageEvent{Usage: codexUsage(n.TokenUsage.Last)}}}, nil

	case codexrpc.NotifPlanDelta:
		// Streaming plan drafts are deliberately not accumulated: the completed
		// plan item is authoritative (see NotifPlanDelta in codexrpc) and the
		// plan file is written once, atomically, from that item.
		return nil, nil

	case codexrpc.NotifTurnCompleted:
		events := closeThinking(run)
		// Auto-exit safety net: a plan-mode turn that ends without ever
		// producing a plan item is the stuck-in-plan-mode failure mode.
		// Synthesize the exit (mirroring the ApiBackend's end-of-turn
		// synthesis) so the proposal surfaces ahead of TaskCompleteEvent.
		if run.planMode && !run.planCaptured && run.pendingPlanMarkdown == "" && run.planAutoExit {
			slug := types.PlanSlugFromPath(run.planFilePath)
			events = append(events,
				types.NormalizedEvent{Data: &types.PlanModeAutoExitEvent{
					RunID:        run.requestID,
					StopReason:   "end_turn",
					PlanFilePath: run.planFilePath,
					PlanSlug:     slug,
					Reason:       "engine-synthesized: run ended in plan mode without a plan item",
				}},
				types.NormalizedEvent{Data: &types.PlanProposalEvent{
					Kind:         "exit",
					PlanFilePath: run.planFilePath,
					PlanSlug:     slug,
				}},
			)
		}
		events = append(events, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
			Result:    run.lastText,
			LastText:  run.lastText,
			CostUsd:   0, // subscription-metered; codex reports usage, not cost
			SessionID: run.threadID,
		}})
		return events, &codexExit{code: intPtr(0)}

	case codexrpc.NotifError:
		var n codexrpc.ErrorNotification
		if err := json.Unmarshal(params, &n); err != nil {
			utils.LogWithFields(utils.LevelDebug, "backend.codex", "notification decode failed", map[string]any{"method": method, "error": err.Error()})
		}
		events := []types.NormalizedEvent{{Data: &types.ErrorEvent{
			ErrorMessage: n.Error.Message,
			IsError:      true,
			SessionID:    run.threadID,
		}}}
		if n.WillRetry {
			// Codex will retry internally; surface the error but keep the run.
			return events, nil
		}
		events = append(events, closeThinking(run)...)
		return events, &codexExit{code: intPtr(1)}

	default:
		return nil, nil
	}
}

// openThinking emits a ThinkingBlockStart the first time reasoning text appears
// for the current block.
func openThinking(run *codexRun) []types.NormalizedEvent {
	if run.thinkingOpen {
		return nil
	}
	run.thinkingOpen = true
	return []types.NormalizedEvent{{Data: &types.ThinkingBlockStartEvent{}}}
}

// closeThinking emits a ThinkingBlockEnd when a reasoning block is open and the
// stream transitions away from reasoning (assistant text, tool call, or turn
// completion).
func closeThinking(run *codexRun) []types.NormalizedEvent {
	if !run.thinkingOpen {
		return nil
	}
	run.thinkingOpen = false
	return []types.NormalizedEvent{{Data: &types.ThinkingBlockEndEvent{}}}
}

// codexToolName maps a codex tool-bearing item type to a display tool name.
// Returns false for non-tool item types (userMessage, agentMessage, reasoning,
// plan, etc.).
func codexToolName(itemType string) (string, bool) {
	switch itemType {
	case "commandExecution":
		return "Bash", true
	case "fileChange":
		return "Edit", true
	case "mcpToolCall":
		return "McpTool", true
	case "dynamicToolCall":
		return "Tool", true
	case "webSearch":
		return "WebSearch", true
	default:
		return "", false
	}
}

// codexUsage maps a codex token-usage breakdown into the engine UsageData shape.
func codexUsage(b codexrpc.TokenUsageBreakdown) types.UsageData {
	in, out, cache := b.InputTokens, b.OutputTokens, b.CachedInputTokens
	return types.UsageData{
		InputTokens:          &in,
		OutputTokens:         &out,
		CacheReadInputTokens: &cache,
	}
}
