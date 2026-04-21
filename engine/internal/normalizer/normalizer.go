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
		// cache token updates so the desktop context meter updates live).
		if sub.Message != nil {
			usage := sub.Message.Usage
			if usage.InputTokens != nil || usage.CacheReadInputTokens != nil {
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
			events = append(events, types.NormalizedEvent{
				Data: &types.ToolResultEvent{
					ToolID:  block.ToolUseID,
					Content: contentStr,
					IsError: block.IsError,
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
