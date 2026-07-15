package backend

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/codexrpc"
	"github.com/dsswift/ion/engine/internal/types"
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
		_ = json.Unmarshal(params, &d)
		var events []types.NormalizedEvent
		events = append(events, closeThinking(run)...)
		if d.Delta != "" {
			run.lastText += d.Delta
			events = append(events, types.NormalizedEvent{Data: &types.TextChunkEvent{Text: d.Delta}})
		}
		return events, nil

	case codexrpc.NotifReasoningTextDelta:
		var d codexrpc.DeltaNotification
		_ = json.Unmarshal(params, &d)
		var events []types.NormalizedEvent
		events = append(events, openThinking(run)...)
		if d.Delta != "" {
			events = append(events, types.NormalizedEvent{Data: &types.ThinkingDeltaEvent{Text: d.Delta}})
		}
		return events, nil

	case codexrpc.NotifItemStarted:
		var n codexrpc.ItemNotification
		_ = json.Unmarshal(params, &n)
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
		_ = json.Unmarshal(params, &n)
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
		return nil, nil

	case codexrpc.NotifTokenUsageUpdated:
		var n codexrpc.TokenUsageNotification
		_ = json.Unmarshal(params, &n)
		return []types.NormalizedEvent{{Data: &types.UsageEvent{Usage: codexUsage(n.TokenUsage.Last)}}}, nil

	case codexrpc.NotifTurnCompleted:
		events := closeThinking(run)
		events = append(events, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
			Result:    run.lastText,
			LastText:  run.lastText,
			CostUsd:   0, // subscription-metered; codex reports usage, not cost
			SessionID: run.threadID,
		}})
		return events, &codexExit{code: intPtr(0)}

	case codexrpc.NotifError:
		var n codexrpc.ErrorNotification
		_ = json.Unmarshal(params, &n)
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
