package providers

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/types"
)

// contentBlocks extracts typed content blocks from an LlmMessage's Content field.
// Content can be a string, []types.LlmContentBlock, or []any (from JSON unmarshal).
func contentBlocks(msg types.LlmMessage) []types.LlmContentBlock {
	switch c := msg.Content.(type) {
	case string:
		return []types.LlmContentBlock{{Type: "text", Text: c}}
	case []types.LlmContentBlock:
		return c
	case []any:
		blocks := make([]types.LlmContentBlock, 0, len(c))
		for _, item := range c {
			switch v := item.(type) {
			case map[string]any:
				b := mapToContentBlock(v)
				blocks = append(blocks, b)
			case types.LlmContentBlock:
				blocks = append(blocks, v)
			}
		}
		return blocks
	default:
		// Try JSON round-trip as last resort
		raw, err := json.Marshal(c)
		if err != nil {
			return nil
		}
		var result []types.LlmContentBlock
		if json.Unmarshal(raw, &result) == nil {
			return result
		}
		return nil
	}
}

// mapToContentBlock converts a map[string]any to a typed LlmContentBlock.
func mapToContentBlock(m map[string]any) types.LlmContentBlock {
	b := types.LlmContentBlock{}
	if v, ok := m["type"].(string); ok {
		b.Type = v
	}
	if v, ok := m["text"].(string); ok {
		b.Text = v
	}
	if v, ok := m["id"].(string); ok {
		b.ID = v
	}
	if v, ok := m["name"].(string); ok {
		b.Name = v
	}
	if v, ok := m["input"].(map[string]any); ok {
		b.Input = v
	}
	if v, ok := m["tool_use_id"].(string); ok {
		b.ToolUseID = v
	}
	if v, ok := m["content"].(string); ok {
		b.Content = v
	}
	if v, ok := m["is_error"].(bool); ok {
		b.IsError = &v
	}
	if v, ok := m["thinking"].(string); ok {
		b.Thinking = v
	}
	if v, ok := m["source"].(map[string]any); ok {
		src := &types.ImageSource{}
		if t, ok := v["type"].(string); ok {
			src.Type = t
		}
		if mt, ok := v["media_type"].(string); ok {
			src.MediaType = mt
		}
		if d, ok := v["data"].(string); ok {
			src.Data = d
		}
		b.Source = src
	}
	return b
}


