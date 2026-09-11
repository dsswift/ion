// Package normalizer converts raw NDJSON stream events into canonical
// NormalizedEvent values. Each raw event may produce zero or more normalized events.
package normalizer

import (
	"encoding/json"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// Normalize parses a raw JSON event and returns zero or more NormalizedEvents.
func Normalize(raw json.RawMessage) []types.NormalizedEvent {
	var peek struct {
		Type    string `json:"type"`
		Subtype string `json:"subtype"`
	}
	if err := json.Unmarshal(raw, &peek); err != nil {
		return nil
	}

	switch peek.Type {
	case "system":
		return normalizeSystem(raw, peek.Subtype)
	case "stream_event":
		return normalizeStreamEvent(raw)
	case "assistant":
		return normalizeAssistant(raw)
	case "result":
		return normalizeResult(raw, peek.Subtype)
	case "rate_limit_event":
		return normalizeRateLimit(raw)
	case "permission_request":
		return normalizePermissionRequest(raw)
	case "user":
		return normalizeUser(raw)
	default:
		return nil
	}
}

func normalizeSystem(raw json.RawMessage, subtype string) []types.NormalizedEvent {
	if subtype == "compact_boundary" {
		return normalizeCompactBoundary(raw)
	}
	if subtype != "init" {
		return nil
	}

	var init types.InitEvent
	if err := json.Unmarshal(raw, &init); err != nil {
		return nil
	}

	var mcpServers []types.McpServerInfo
	for _, s := range init.McpServers {
		mcpServers = append(mcpServers, types.McpServerInfo{Name: s.Name, Status: s.Status})
	}

	return []types.NormalizedEvent{{
		Data: &types.SessionInitEvent{
			SessionID:  init.SessionID,
			Tools:      init.Tools,
			Model:      init.Model,
			McpServers: mcpServers,
			Skills:     init.Skills,
			Version:    init.ClaudeCodeVersion,
		},
	}}
}

func normalizeStreamEvent(raw json.RawMessage) []types.NormalizedEvent {
	var se types.StreamEvent
	if err := json.Unmarshal(raw, &se); err != nil {
		return nil
	}

	sub := se.Event
	var events []types.NormalizedEvent

	switch sub.Type {
	case "message_start":
		// Emit a usage event if the message carries cache token counts (TS parity:
		// event-normalizer.ts emits a 'usage' NormalizedEvent for early/mid-stream
		// cache token updates so consumers tracking context can update live).
		if sub.Message != nil {
			if usage, ok := occupancyUsage(sub.Message.Usage); ok {
				events = append(events, types.NormalizedEvent{
					Data: &types.UsageEvent{Usage: usage},
				})
			}
		}

	case "content_block_start":
		if sub.ContentBlock != nil && sub.Index != nil {
			if sub.ContentBlock.Type == "tool_use" {
				events = append(events, types.NormalizedEvent{
					Data: &types.ToolCallEvent{
						ToolName: sub.ContentBlock.Name,
						ToolID:   sub.ContentBlock.ID,
						Index:    *sub.Index,
					},
				})
			}
		}

	case "content_block_delta":
		if sub.Delta != nil {
			switch sub.Delta.Type {
			case "text_delta":
				if sub.Delta.Text != "" {
					events = append(events, types.NormalizedEvent{
						Data: &types.TextChunkEvent{Text: sub.Delta.Text},
					})
				}
			case "input_json_delta":
				if sub.Delta.PartialJSON != "" {
					toolID := ""
					// We don't have toolID in delta; upstream correlates by index.
					events = append(events, types.NormalizedEvent{
						Data: &types.ToolCallUpdateEvent{
							ToolID:       toolID,
							PartialInput: sub.Delta.PartialJSON,
						},
					})
				}
			}
		}

	case "content_block_stop":
		if sub.Index != nil {
			events = append(events, types.NormalizedEvent{
				Data: &types.ToolCallCompleteEvent{Index: *sub.Index},
			})
		}

	case "message_delta":
		// Usage from message_delta is accumulated internally, not emitted.
		// TS suppresses this to avoid double-counting with final result usage.

	case "message_stop":
		// Terminal; no separate normalized event needed.
	}

	return events
}

func normalizeAssistant(raw json.RawMessage) []types.NormalizedEvent {
	var ae types.AssistantEvent
	if err := json.Unmarshal(raw, &ae); err != nil {
		return nil
	}

	return []types.NormalizedEvent{{
		Data: &types.TaskUpdateEvent{
			Message: ae.Message,
		},
	}}
}

func normalizeResult(raw json.RawMessage, subtype string) []types.NormalizedEvent {
	var re types.ResultEvent
	if err := json.Unmarshal(raw, &re); err != nil {
		return nil
	}

	if re.IsError {
		return []types.NormalizedEvent{{
			Data: &types.ErrorEvent{
				ErrorMessage: re.Result,
				IsError:      true,
				SessionID:    re.SessionID,
			},
		}}
	}

	var denials []types.PermissionDenial
	for _, d := range re.PermissionDenials {
		denials = append(denials, types.PermissionDenial{ToolName: d.ToolName, ToolUseID: d.ToolUseID})
	}

	return []types.NormalizedEvent{{
		Data: &types.TaskCompleteEvent{
			Reason:            resultCompletionReason(subtype),
			Result:            re.Result,
			CostUsd:           re.TotalCostUsd,
			DurationMs:        re.DurationMs,
			NumTurns:          re.NumTurns,
			Usage:             re.Usage,
			SessionID:         re.SessionID,
			PermissionDenials: denials,
		},
	}}
}

func normalizeRateLimit(raw json.RawMessage) []types.NormalizedEvent {
	var rle types.RateLimitEvent
	if err := json.Unmarshal(raw, &rle); err != nil {
		return nil
	}

	return []types.NormalizedEvent{{
		Data: &types.RateLimitNormalizedEvent{
			Status:        rle.RateLimitInfo.Status,
			ResetsAt:      rle.RateLimitInfo.ResetsAt,
			RateLimitType: rle.RateLimitInfo.RateLimitType,
		},
	}}
}

func normalizePermissionRequest(raw json.RawMessage) []types.NormalizedEvent {
	var pe types.PermissionEvent
	if err := json.Unmarshal(raw, &pe); err != nil {
		return nil
	}

	return []types.NormalizedEvent{{
		Data: &types.PermissionRequestEvent{
			QuestionID:      pe.QuestionID,
			ToolName:        pe.Tool.Name,
			ToolDescription: pe.Tool.Description,
			ToolInput:       pe.Tool.Input,
			Options:         pe.Options,
		},
	}}
}

// normalizeUser extracts tool_result content blocks from user-type events.
// These events appear in the Claude CLI stream when tool results are returned.
func normalizeUser(raw json.RawMessage) []types.NormalizedEvent {
	var ue struct {
		Type    string `json:"type"`
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(raw, &ue); err != nil {
		return nil
	}

	// Content can be a string or an array of content blocks.
	content := ue.Message.Content
	if len(content) == 0 {
		return nil
	}

	// If it's a plain string, nothing to extract.
	if content[0] == '"' {
		return nil
	}

	// Parse as array of content blocks.
	var blocks []struct {
		Type      string          `json:"type"`
		ToolUseID string          `json:"tool_use_id,omitempty"`
		Content   json.RawMessage `json:"content,omitempty"`
		IsError   bool            `json:"is_error,omitempty"`
	}
	if err := json.Unmarshal(content, &blocks); err != nil {
		return nil
	}

	var events []types.NormalizedEvent
	for _, block := range blocks {
		if block.Type == "tool_result" {
			// Content within a tool_result can also be a string or array.
			contentStr := extractContentString(block.Content)
			// Recover the asynchronous-work ID the delegated CLI could not
			// carry. A background Bash command, a Poll, or an asynchronous
			// agent dispatch starts INSIDE the engine, but its result leaves
			// over MCP and comes back on the CLI's stream, and neither hop has
			// a field for an Ion task or dispatch ID --
			// the block above is the whole shape the CLI reports. Without this
			// the row loses its only link to the live task and renders as an
			// instantly-finished tool, while the engine holds the session open
			// for a command the transcript says already ended.
			//
			// The decode is exact: the content being read is the engine's own
			// fixed template with the ID interpolated in, and the parser
			// rejects anything that is not that template.
			bgID, _ := types.ParseCanonicalAsyncStartResult(contentStr)
			events = append(events, types.NormalizedEvent{
				Data: &types.ToolResultEvent{
					ToolID:           block.ToolUseID,
					Content:          contentStr,
					IsError:          block.IsError,
					BackgroundTaskID: bgID,
				},
			})
		}
	}
	return events
}

// extractContentString converts a json.RawMessage that may be a string or an
// array of {type,text} blocks into a single string.
func extractContentString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	// Try as a plain JSON string first.
	if raw[0] == '"' {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			return s
		}
	}
	// Try as array of content blocks with text fields.
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text,omitempty"`
	}
	if err := json.Unmarshal(raw, &parts); err == nil {
		var sb strings.Builder
		for _, p := range parts {
			sb.WriteString(p.Text)
		}
		return sb.String()
	}
	// Fallback: return raw string representation.
	return string(raw)
}

func resultCompletionReason(subtype string) types.TaskCompletionReason {
	switch subtype {
	case "success":
		return types.TaskCompletionReasonNormal
	case "error_max_turns", "max_turns":
		return types.TaskCompletionReasonMaxTurns
	case "cancelled", "aborted":
		return types.TaskCompletionReasonAborted
	default:
		return types.TaskCompletionReasonBackendExit
	}
}

// occupancyUsage restates a raw Anthropic message usage record in the shape
// UsageEvent consumers expect, reporting false when it carries no input
// accounting at all.
//
// The contract on UsageEvent.Usage.InputTokens is "what the model actually
// carried" — the summed occupancy, not the raw prompt field. The ApiBackend
// runloop emits it that way (input + cache_read + cache_creation), and
// translateToEngineEvent reads InputTokens alone to derive both
// engine_message_end's token count and its context percent.
//
// Anthropic's accounting is ADDITIVE: cache_read_input_tokens and
// cache_creation_input_tokens are counted separately from input_tokens, not as
// a subset of it. On a cached turn the raw input_tokens field is therefore
// tiny — a real observed record reads input_tokens=2 against
// cache_read_input_tokens=840543 — so forwarding it unsummed reported a ~840K
// context as ~2 tokens and pinned the live occupancy readout near 0%. The
// component fields ride alongside the total, exactly as the runloop emits them.
//
// This deliberately does NOT generalise to every delegated CLI. OpenAI-shaped
// accounting reports cached tokens as a SUBSET of the prompt total, where the
// same sum would double-count; see codexUsage in
// internal/backend/codex_events.go, which is correct as written.
func occupancyUsage(raw types.UsageData) (types.UsageData, bool) {
	if raw.InputTokens == nil && raw.CacheReadInputTokens == nil && raw.CacheCreationInputTokens == nil {
		return types.UsageData{}, false
	}
	total := derefTokens(raw.InputTokens) + derefTokens(raw.CacheReadInputTokens) + derefTokens(raw.CacheCreationInputTokens)
	out := raw
	out.InputTokens = &total
	return out, true
}

func derefTokens(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}

// normalizeCompactBoundary converts a delegated CLI's compact_boundary frame
// into a NativeCompactionEvent.
//
// Every non-init `system` frame used to be dropped here, so a Claude Code
// conversation could compact its own session and Ion would neither report it
// to consumers nor record that it happened — the engine's context readout and
// the CLI's were describing different worlds with no event between them.
//
// A frame with unparseable or absent metadata still produces the event. The
// compaction is the signal; the token counts are decoration, and reporting
// "the provider compacted" with empty numbers beats reporting nothing.
func normalizeCompactBoundary(raw json.RawMessage) []types.NormalizedEvent {
	var frame types.CompactBoundaryFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		return []types.NormalizedEvent{{Data: &types.NativeCompactionEvent{}}}
	}
	ev := &types.NativeCompactionEvent{SessionID: frame.SessionID}
	if md := frame.CompactMetadata; md != nil {
		ev.Trigger = md.Trigger
		ev.PreTokens = md.PreTokens
		ev.MessagesSummarized = md.MessagesSummarized
		ev.DurationMs = md.DurationMs
	}
	return []types.NormalizedEvent{{Data: ev}}
}
