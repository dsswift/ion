package conversation

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SanitizeMessages fixes issues in loaded conversations that would cause API
// errors. The Anthropic API requires strict tool_use/tool_result pairing:
//   - Every tool_use in an assistant message must have a tool_result in the next user message
//   - Every tool_result in a user message must reference a tool_use in the previous assistant message
//   - No thinking blocks (not valid for re-submission)
//
// Strategy: two passes.
//   - Pass 1: normalize all content to []LlmContentBlock, remove thinking blocks
//   - Pass 2: for each assistant message, collect tool_use IDs. Check the next
//     message for matching tool_results. Remove unmatched from both sides.
func SanitizeMessages(messages []types.LlmMessage) []types.LlmMessage {
	if len(messages) == 0 {
		return messages
	}

	removed := 0

	// Pass 1: normalize content and remove thinking blocks
	normalized := make([]types.LlmMessage, 0, len(messages))
	for _, msg := range messages {
		blocks := contentToBlockSlice(msg.Content)
		if blocks == nil {
			// String content -- keep as-is
			normalized = append(normalized, msg)
			continue
		}
		var filtered []types.LlmContentBlock
		for _, b := range blocks {
			if b.Type == "thinking" {
				removed++
				continue
			}
			filtered = append(filtered, b)
		}
		if len(filtered) == 0 {
			removed++
			continue
		}
		normalized = append(normalized, types.LlmMessage{Role: msg.Role, Content: filtered})
	}

	// Pass 2: enforce tool_use/tool_result pairing
	result := make([]types.LlmMessage, 0, len(normalized))
	for i := 0; i < len(normalized); i++ {
		msg := normalized[i]
		blocks := contentToBlockSlice(msg.Content)

		if msg.Role == "assistant" && blocks != nil {
			// Collect tool_use IDs in this assistant message
			toolUseIDs := make(map[string]bool)
			for _, b := range blocks {
				if b.Type == "tool_use" && b.ID != "" {
					toolUseIDs[b.ID] = true
				}
			}

			if len(toolUseIDs) > 0 {
				// Check next message for matching tool_results
				matchedIDs := make(map[string]bool)
				if i+1 < len(normalized) && normalized[i+1].Role == "user" {
					nextBlocks := contentToBlockSlice(normalized[i+1].Content)
					for _, b := range nextBlocks {
						if b.Type == "tool_result" && toolUseIDs[b.ToolUseID] {
							matchedIDs[b.ToolUseID] = true
						}
					}
				}

				// Keep only tool_use blocks that have matching tool_results (or non-tool_use blocks)
				if len(matchedIDs) < len(toolUseIDs) {
					var filtered []types.LlmContentBlock
					for _, b := range blocks {
						if b.Type == "tool_use" && b.ID != "" && !matchedIDs[b.ID] {
							removed++
							continue
						}
						filtered = append(filtered, b)
					}
					if len(filtered) == 0 {
						removed++
						continue
					}
					result = append(result, types.LlmMessage{Role: msg.Role, Content: filtered})
					continue
				}
			}

			result = append(result, msg)
			continue
		}

		if msg.Role == "user" && blocks != nil {
			// Collect tool_use IDs from the previous assistant message in result
			prevToolUseIDs := make(map[string]bool)
			for j := len(result) - 1; j >= 0; j-- {
				if result[j].Role == "assistant" {
					prevBlocks := contentToBlockSlice(result[j].Content)
					for _, b := range prevBlocks {
						if b.Type == "tool_use" && b.ID != "" {
							prevToolUseIDs[b.ID] = true
						}
					}
					break
				}
			}

			// Remove tool_result blocks with no matching tool_use
			var filtered []types.LlmContentBlock
			for _, b := range blocks {
				if b.Type == "tool_result" && b.ToolUseID != "" {
					if !prevToolUseIDs[b.ToolUseID] {
						removed++
						continue
					}
				}
				filtered = append(filtered, b)
			}
			if len(filtered) == 0 {
				removed++
				continue
			}
			result = append(result, types.LlmMessage{Role: msg.Role, Content: filtered})
			continue
		}

		result = append(result, msg)
	}

	if removed > 0 {
		utils.Log("Conversation", fmt.Sprintf("sanitized: removed %d orphaned blocks/messages", removed))
	}
	return result
}

// contentToBlockSlice converts the Content field (any) to []LlmContentBlock if possible.
func contentToBlockSlice(content any) []types.LlmContentBlock {
	switch v := content.(type) {
	case []types.LlmContentBlock:
		return v
	case []interface{}:
		var blocks []types.LlmContentBlock
		for _, item := range v {
			if m, ok := item.(map[string]interface{}); ok {
				b := types.LlmContentBlock{}
				if t, ok := m["type"].(string); ok {
					b.Type = t
				}
				if t, ok := m["text"].(string); ok {
					b.Text = t
				}
				if t, ok := m["id"].(string); ok {
					b.ID = t
				}
				if t, ok := m["name"].(string); ok {
					b.Name = t
				}
				if t, ok := m["tool_use_id"].(string); ok {
					b.ToolUseID = t
				}
				if t, ok := m["content"].(string); ok {
					b.Content = t
				}
				if t, ok := m["thinking"].(string); ok {
					b.Thinking = t
				}
				if t, ok := m["input"].(map[string]interface{}); ok {
					b.Input = t
				}
				if t, ok := m["is_error"].(bool); ok {
					b.IsError = &t
				}
				blocks = append(blocks, b)
			}
		}
		return blocks
	}
	return nil
}
