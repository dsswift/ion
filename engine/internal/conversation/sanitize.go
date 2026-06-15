package conversation

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SanitizeMessages fixes issues in loaded conversations that would cause API
// errors. The Anthropic API requires strict tool pairing:
//   - Every tool_use in an assistant message must have a tool_result in the next user message
//   - Every tool_result in a user message must reference a tool_use in the previous assistant message
//   - Every server_tool_use in an assistant message must have a web_search_tool_result in the same message
//   - No thinking blocks (not valid for re-submission)
//
// Strategy: two passes.
//   - Pass 1: normalize all content to []LlmContentBlock, remove thinking blocks
//   - Pass 2: for each assistant message, enforce cross-message tool_use ↔ tool_result
//     pairing and intra-message server_tool_use ↔ web_search_tool_result pairing.
//     Remove unmatched blocks from both sides.
func SanitizeMessages(messages []types.LlmMessage) []types.LlmMessage {
	if len(messages) == 0 {
		return messages
	}

	removed := 0

	// Pass 1: normalize content, remove thinking blocks, coerce malformed
	// tool_use.Input to an empty map (Anthropic rejects non-object input).
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
			// Empty text blocks serve no semantic purpose and cause Anthropic
			// API errors when the cache_control layer attaches ephemeral
			// markers to them ("cache_control cannot be set for empty text
			// blocks"). Remove them at load time so already-stuck
			// conversations become sendable again.
			if b.Type == "text" && b.Text == "" {
				utils.Debug("Conversation", fmt.Sprintf(
					"sanitize: removed empty text block from message (role=%s)", msg.Role))
				removed++
				continue
			}
			if b.Type == "tool_use" && b.Input == nil {
				b.Input = map[string]any{}
			}
			if b.Type == "server_tool_use" && b.Input == nil {
				b.Input = map[string]any{}
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
			current := blocks
			changed := false

			// --- client tool pairing: tool_use ↔ tool_result (cross-message) ---
			toolUseIDs := make(map[string]bool)
			for _, b := range current {
				if b.Type == "tool_use" && b.ID != "" {
					toolUseIDs[b.ID] = true
				}
			}

			if len(toolUseIDs) > 0 {
				matchedIDs := make(map[string]bool)
				if i+1 < len(normalized) && normalized[i+1].Role == "user" {
					nextBlocks := contentToBlockSlice(normalized[i+1].Content)
					for _, b := range nextBlocks {
						if b.Type == "tool_result" && toolUseIDs[b.ToolUseID] {
							matchedIDs[b.ToolUseID] = true
						}
					}
				}

				if len(matchedIDs) < len(toolUseIDs) {
					var filtered []types.LlmContentBlock
					for _, b := range current {
						if b.Type == "tool_use" && b.ID != "" && !matchedIDs[b.ID] {
							removed++
							continue
						}
						filtered = append(filtered, b)
					}
					current = filtered
					changed = true
				}
			}

			// --- server tool pairing: server_tool_use ↔ web_search_tool_result (intra-message) ---
			serverIDs := make(map[string]bool)
			resultIDs := make(map[string]bool)
			for _, b := range current {
				if b.Type == "server_tool_use" && b.ID != "" {
					serverIDs[b.ID] = true
				}
				if b.Type == "web_search_tool_result" && b.ToolUseID != "" {
					resultIDs[b.ToolUseID] = true
				}
			}

			if len(serverIDs) > 0 || len(resultIDs) > 0 {
				hasOrphan := false
				for id := range serverIDs {
					if !resultIDs[id] {
						hasOrphan = true
						break
					}
				}
				if !hasOrphan {
					for id := range resultIDs {
						if !serverIDs[id] {
							hasOrphan = true
							break
						}
					}
				}

				if hasOrphan {
					var filtered []types.LlmContentBlock
					for _, b := range current {
						if b.Type == "server_tool_use" && b.ID != "" && !resultIDs[b.ID] {
							removed++
							continue
						}
						if b.Type == "web_search_tool_result" && b.ToolUseID != "" && !serverIDs[b.ToolUseID] {
							removed++
							continue
						}
						filtered = append(filtered, b)
					}
					current = filtered
					changed = true
				}
			}

			if changed {
				if len(current) == 0 {
					removed++
					continue
				}
				result = append(result, types.LlmMessage{Role: msg.Role, Content: current})
				continue
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

const planFilePlaceholder = "[plan-file]"

// replaceInContent replaces all occurrences of placeholder with replacement in
// a Content field (any type: string, []LlmContentBlock, or []interface{}).
// Returns the new content and whether any replacement occurred.
func replaceInContent(content any, placeholder, replacement string) (any, bool) {
	// Handle string content
	if s, ok := content.(string); ok {
		if strings.Contains(s, placeholder) {
			return strings.ReplaceAll(s, placeholder, replacement), true
		}
		return content, false
	}

	// Handle block slice content (typed or untyped)
	blocks := contentToBlockSlice(content)
	if blocks == nil {
		return content, false
	}

	changed := false
	for j, b := range blocks {
		// Text blocks: replace in .Text
		if b.Text != "" && strings.Contains(b.Text, placeholder) {
			blocks[j].Text = strings.ReplaceAll(b.Text, placeholder, replacement)
			changed = true
		}

		// Tool result blocks: replace in .Content (the string field)
		if b.Content != "" && strings.Contains(b.Content, placeholder) {
			blocks[j].Content = strings.ReplaceAll(b.Content, placeholder, replacement)
			changed = true
		}

		// Tool use blocks: replace placeholder in Input["file_path"] if it's a string
		if b.Input != nil {
			if fp, ok := b.Input["file_path"].(string); ok && strings.Contains(fp, placeholder) {
				blocks[j].Input["file_path"] = strings.ReplaceAll(fp, placeholder, replacement)
				changed = true
			}
		}
	}

	if changed {
		return blocks, true
	}
	return content, false
}

// ReplacePlanFilePlaceholder replaces the literal string "[plan-file]" with the
// actual plan file path in all text-bearing fields of the conversation's
// Messages and Entries. This is an in-memory fixup so that persistence (which
// rebuilds from Entries via BuildContextPath and serializes entries to
// .tree.jsonl) writes the real path, not the placeholder.
//
// The replacement is idempotent and safe to call multiple times with the same
// path.
//
// Background: a prior agent run replaced real plan file paths with the
// placeholder "[plan-file]" in ~300 conversation files. When these conversations
// are resumed, the model sees "[plan-file]" as a literal path and uses it in
// tool calls, which the engine rejects. This function restores the real path at
// load time in both Messages and Entries so that subsequent saves are clean.
func ReplacePlanFilePlaceholder(conv *Conversation, planFilePath string) {
	if planFilePath == "" || conv == nil {
		return
	}

	replaced := 0

	// 1. Fix Messages
	for i, msg := range conv.Messages {
		if newContent, changed := replaceInContent(msg.Content, planFilePlaceholder, planFilePath); changed {
			conv.Messages[i].Content = newContent
			replaced++
		}
	}

	// 2. Fix Entries — entry data is a MessageData struct after rehydrateEntries;
	// its .Content field has the same any type as LlmMessage.Content.
	for i, entry := range conv.Entries {
		if entry.Type != EntryMessage {
			continue
		}
		md := asMessageData(entry.Data)
		if md == nil {
			continue
		}
		if newContent, changed := replaceInContent(md.Content, planFilePlaceholder, planFilePath); changed {
			md.Content = newContent
			conv.Entries[i].Data = *md
			replaced++
		}
	}

	if replaced > 0 {
		utils.Log("Conversation", fmt.Sprintf("replaced [plan-file] placeholder with %q in %d messages/entries", planFilePath, replaced))
	}
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
				// compact_boundary structured fields. Optional on every
				// block type; copied so persistence round-trips keep
				// boundary metadata. Matches providers/messages.go
				// mapToContentBlock — keep in sync if either side
				// changes.
				if t, ok := m["trigger"].(string); ok {
					b.Trigger = t
				}
				if t, ok := m["messagesSummarized"].(float64); ok {
					b.MessagesSummarized = int(t)
				}
				if t, ok := m["messagesBefore"].(float64); ok {
					b.MessagesBefore = int(t)
				}
				if t, ok := m["messagesAfter"].(float64); ok {
					b.MessagesAfter = int(t)
				}
				if t, ok := m["clearedBlocks"].(float64); ok {
					b.ClearedBlocks = int(t)
				}
				if t, ok := m["tokensBefore"].(float64); ok {
					b.TokensBefore = int(t)
				}
				if t, ok := m["summary"].(string); ok {
					b.Summary = t
				}
				if t, ok := m["factCount"].(float64); ok {
					b.FactCount = int(t)
				}
				if t, ok := m["recentFiles"].([]interface{}); ok {
					files := make([]string, 0, len(t))
					for _, item := range t {
						if s, ok := item.(string); ok {
							files = append(files, s)
						}
					}
					b.RecentFiles = files
				}
				blocks = append(blocks, b)
			}
		}
		return blocks
	}
	return nil
}
