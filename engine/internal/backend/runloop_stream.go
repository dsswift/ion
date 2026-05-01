package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// processStream consumes LLM stream events, emits normalized events, and
// returns the collected assistant content blocks, stop reason, and usage.
func (b *ApiBackend) processStream(
	ctx context.Context,
	run *activeRun,
	events <-chan types.LlmStreamEvent,
	errc <-chan error,
) ([]types.LlmContentBlock, string, *types.LlmUsage, error) {

	var assistantBlocks []types.LlmContentBlock
	var currentBlockIndex int
	var currentPartialJSON strings.Builder
	var stopReason string
	var cumUsage types.LlmUsage
	var toolCallIndex int

	for ev := range events {
		if ctx.Err() != nil {
			return nil, "", nil, ctx.Err()
		}

		switch ev.Type {
		case "message_start":
			if ev.MessageInfo != nil {
				cumUsage = ev.MessageInfo.Usage
				// Emit cache token counts so clients see them immediately
				// (TS emits cache_read from message_start).
				if cumUsage.CacheReadInputTokens > 0 || cumUsage.CacheCreationInputTokens > 0 {
					cri := cumUsage.CacheReadInputTokens
					cci := cumUsage.CacheCreationInputTokens
					b.emit(run, types.NormalizedEvent{Data: &types.UsageEvent{
						Usage: types.UsageData{
							CacheReadInputTokens:     &cri,
							CacheCreationInputTokens: &cci,
						},
					}})
				}
			}

		case "content_block_start":
			if ev.ContentBlock == nil {
				continue
			}
			cb := ev.ContentBlock
			block := types.LlmContentBlock{
				Type:      cb.Type,
				ID:        cb.ID,
				Name:      cb.Name,
				Text:      cb.Text,
				ToolUseID: cb.ToolUseID,
			}
			// web_search_tool_result: serialize search results into Content string
			if cb.Type == "web_search_tool_result" && cb.Content != nil {
				if raw, err := json.Marshal(cb.Content); err == nil {
					block.Content = string(raw)
				}
			}
			currentBlockIndex = ev.BlockIndex
			assistantBlocks = appendOrGrow(assistantBlocks, currentBlockIndex, block)

			if cb.Type == "tool_use" {
				b.emit(run, types.NormalizedEvent{Data: &types.ToolCallEvent{
					ToolName: cb.Name,
					ToolID:   cb.ID,
					Index:    toolCallIndex,
				}})
				toolCallIndex++
				currentPartialJSON.Reset()
			}

			// Server-side tool use (e.g. web_search) -- accumulate input JSON but don't execute locally
			if cb.Type == "server_tool_use" {
				currentPartialJSON.Reset()
			}

			// Server-side search results -- emit event for desktop rendering
			if cb.Type == "web_search_tool_result" && cb.Content != nil {
				if results, ok := cb.Content.([]any); ok {
					var hits []types.WebSearchHit
					for _, r := range results {
						if m, ok := r.(map[string]any); ok {
							hit := types.WebSearchHit{}
							if t, ok := m["title"].(string); ok {
								hit.Title = t
							}
							if u, ok := m["url"].(string); ok {
								hit.URL = u
							}
							if hit.URL != "" {
								hits = append(hits, hit)
							}
						}
					}
					if len(hits) > 0 {
						b.emit(run, types.NormalizedEvent{Data: &types.WebSearchResultEvent{
							Results: hits,
						}})
					}
				}
			}

		case "content_block_delta":
			if ev.Delta == nil {
				continue
			}
			delta := ev.Delta

			if delta.Type == "text_delta" && delta.Text != "" {
				if currentBlockIndex < len(assistantBlocks) {
					assistantBlocks[currentBlockIndex].Text += delta.Text
				}
				b.emit(run, types.NormalizedEvent{Data: &types.TextChunkEvent{
					Text: delta.Text,
				}})
			}

			if delta.Type == "input_json_delta" && delta.PartialJSON != "" {
				currentPartialJSON.WriteString(delta.PartialJSON)
				if currentBlockIndex < len(assistantBlocks) {
					toolID := assistantBlocks[currentBlockIndex].ID
					b.emit(run, types.NormalizedEvent{Data: &types.ToolCallUpdateEvent{
						ToolID:       toolID,
						PartialInput: delta.PartialJSON,
					}})
				}
			}

		case "content_block_stop":
			// Parse accumulated tool input JSON (client or server tool).
			// On parse failure we coerce to an empty map and warn — the API
			// rejects messages whose tool_use.input is not a JSON object,
			// which would otherwise poison the conversation history forever.
			if currentBlockIndex < len(assistantBlocks) {
				block := &assistantBlocks[currentBlockIndex]
				if block.Type == "tool_use" || block.Type == "server_tool_use" {
					raw := currentPartialJSON.String()
					if raw == "" {
						block.Input = map[string]any{}
					} else {
						var input map[string]any
						if err := json.Unmarshal([]byte(raw), &input); err == nil {
							block.Input = input
						} else {
							preview := raw
							if len(preview) > 500 {
								preview = preview[:500] + "...(truncated)"
							}
							utils.Warn("ApiBackend", fmt.Sprintf("tool_use input parse failed (toolID=%s name=%s err=%v) coercing to {}: %s", block.ID, block.Name, err, preview))
							block.Input = map[string]any{}
						}
					}
					currentPartialJSON.Reset()
				}
			}

			b.emit(run, types.NormalizedEvent{Data: &types.ToolCallCompleteEvent{
				Index: currentBlockIndex,
			}})

		case "message_delta":
			if ev.Delta != nil && ev.Delta.StopReason != nil {
				stopReason = *ev.Delta.StopReason
			}
			if ev.DeltaUsage != nil {
				// Accumulate final usage
				cumUsage.OutputTokens += ev.DeltaUsage.OutputTokens
			}
		}
	}

	// Check for stream error
	var streamErr error
	if errc != nil {
		streamErr = <-errc
	}

	return assistantBlocks, stopReason, &cumUsage, streamErr
}
