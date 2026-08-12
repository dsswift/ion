package mcp

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ToolCallResult preserves a full MCP tools/call response. IsError is a tool
// outcome, not a JSON-RPC transport failure.
type ToolCallResult struct {
	Content []types.ToolContent `json:"content"`
	IsError bool                `json:"isError,omitempty"`
}

func parseToolCallResult(raw json.RawMessage) (*ToolCallResult, error) {
	var envelope struct {
		Content []json.RawMessage `json:"content"`
		IsError bool              `json:"isError"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("decode tool result: %w", err)
	}

	result := &ToolCallResult{IsError: envelope.IsError}
	for _, rawItem := range envelope.Content {
		item, err := parseToolContent(rawItem)
		if err != nil {
			return nil, fmt.Errorf("decode tool content: %w", err)
		}
		result.Content = append(result.Content, item)
	}
	return result, nil
}

func parseToolContent(raw json.RawMessage) (types.ToolContent, error) {
	var item types.ToolContent
	if err := json.Unmarshal(raw, &item); err != nil {
		return types.ToolContent{}, err
	}
	if item.Type == "" {
		return types.ToolContent{}, fmt.Errorf("content item has no type")
	}
	if !knownContentType(item.Type) {
		item.Unknown = append(json.RawMessage(nil), raw...)
	}
	return item, nil
}

func knownContentType(kind string) bool {
	switch kind {
	case "text", "image", "audio", "resource", "resource_link":
		return true
	default:
		return false
	}
}

// Text preserves textual MCP output and gives models safe metadata-only
// summaries for opaque binary content. Blob data is never rendered into text.
func (r *ToolCallResult) Text() string {
	var parts []string
	for _, item := range r.Content {
		switch item.Type {
		case "text":
			if item.Text != "" {
				parts = append(parts, item.Text)
			}
		case "resource":
			parts = appendResourceText(parts, item.Resource)
		case "image":
			if !isSupportedImage(item.MimeType, item.Data) {
				parts = append(parts, binarySummary("MCP image", item.MimeType, len(item.Data)))
			}
		case "audio":
			parts = append(parts, binarySummary("MCP audio", item.MimeType, len(item.Data)))
		case "resource_link":
			parts = append(parts, resourceSummary("MCP resource link", item.URI, item.MimeType, item.Size))
		default:
			parts = append(parts, fmt.Sprintf("[MCP content type %q preserved for extension consumers]", item.Type))
		}
	}
	return strings.Join(parts, "\n")
}

func appendResourceText(parts []string, resource *types.EmbeddedResource) []string {
	if resource == nil {
		return append(parts, "[MCP embedded resource: empty]")
	}
	if resource.Text != "" {
		return append(parts, resource.Text)
	}
	if isSupportedImage(resource.MimeType, resource.Blob) {
		return parts
	}
	return append(parts, resourceSummary("MCP embedded resource", resource.URI, resource.MimeType, int64(len(resource.Blob))))
}

func isSupportedImage(mimeType, data string) bool {
	if data == "" || len(data) > types.MaxEphemeralVisionDataChars {
		return false
	}
	switch mimeType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

func binarySummary(kind, mimeType string, encodedLength int) string {
	return fmt.Sprintf("[%s: mime=%s, base64Chars=%d]", kind, mimeType, encodedLength)
}

func resourceSummary(kind, uri, mimeType string, encodedLength int64) string {
	if encodedLength > 0 {
		return fmt.Sprintf("[%s: uri=%s, mime=%s, base64Chars=%d]", kind, uri, mimeType, encodedLength)
	}
	return fmt.Sprintf("[%s: uri=%s, mime=%s]", kind, uri, mimeType)
}

// ToToolResult exposes typed data to SDK consumers and maps supported images to
// transient model input. It logs metadata only, never data or blob fields.
func (r *ToolCallResult) ToToolResult(serverName, toolName string) *types.ToolResult {
	items := append([]types.ToolContent(nil), r.Content...)
	result := &types.ToolResult{
		Content:         r.Text(),
		IsError:         r.IsError,
		ContentItems:    items,
		EphemeralImages: types.ToolContentEphemeralImages(items),
	}
	utils.LogWithFields(utils.LevelDebug, "mcp", "decoded MCP tool result", map[string]any{
		"serverName":   serverName,
		"toolName":     toolName,
		"contentItems": len(items),
		"isError":      r.IsError,
	})
	return result
}
