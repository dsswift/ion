package mcp

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const maxMcpImageBytes = 20 * 1024 * 1024

// mcpContentBlock is the MCP tool-result content union. Fields not applicable
// to a block type remain empty after JSON decoding.
type mcpContentBlock struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	URI      string `json:"uri,omitempty"`
	Name     string `json:"name,omitempty"`
	Resource *struct {
		URI      string `json:"uri,omitempty"`
		MimeType string `json:"mimeType,omitempty"`
		Text     string `json:"text,omitempty"`
		Blob     string `json:"blob,omitempty"`
	} `json:"resource,omitempty"`
}

func toolResultFromContent(serverName, toolName string, content []mcpContentBlock, structured json.RawMessage) *types.ToolResult {
	result := &types.ToolResult{}
	var textParts []string
	hadTextBlock := false
	for _, block := range content {
		switch block.Type {
		case "text":
			if block.Text != "" {
				hadTextBlock = true
				textParts = append(textParts, block.Text)
			}
			logMcpContent(serverName, toolName, block.Type, len(block.Text), utils.LevelDebug)
		case "image":
			appendMcpImage(result, &textParts, serverName, toolName, block.MimeType, block.Data)
		case "audio":
			textParts = append(textParts, fmt.Sprintf("[MCP audio: %s, %d base64 chars]", block.MimeType, len(block.Data)))
			logMcpContent(serverName, toolName, block.Type, len(block.Data), utils.LevelInfo)
		case "resource_link":
			textParts = append(textParts, fmt.Sprintf("[MCP resource link: %s (%s, %s)]", block.Name, block.URI, block.MimeType))
			logMcpContent(serverName, toolName, block.Type, len(block.URI), utils.LevelInfo)
		case "resource":
			if block.Resource == nil {
				textParts = append(textParts, "[MCP embedded resource: empty]")
				logMcpContent(serverName, toolName, block.Type, 0, utils.LevelWarn)
				continue
			}
			if strings.HasPrefix(block.Resource.MimeType, "image/") && block.Resource.Blob != "" {
				appendMcpImage(result, &textParts, serverName, toolName, block.Resource.MimeType, block.Resource.Blob)
			} else if block.Resource.Text != "" {
				textParts = append(textParts, block.Resource.Text)
				logMcpContent(serverName, toolName, block.Type, len(block.Resource.Text), utils.LevelDebug)
			} else {
				textParts = append(textParts, fmt.Sprintf("[MCP embedded resource: %s (%s)]", block.Resource.URI, block.Resource.MimeType))
				logMcpContent(serverName, toolName, block.Type, len(block.Resource.Blob), utils.LevelInfo)
			}
		default:
			textParts = append(textParts, fmt.Sprintf("[MCP content type %q is not supported]", block.Type))
			logMcpContent(serverName, toolName, block.Type, 0, utils.LevelWarn)
		}
	}
	if !hadTextBlock && len(structured) > 0 && string(structured) != "null" {
		textParts = append(textParts, string(structured))
		logMcpContent(serverName, toolName, "structuredContent", len(structured), utils.LevelInfo)
	}
	result.Content = strings.Join(textParts, "\n")
	return result
}

func appendMcpImage(result *types.ToolResult, textParts *[]string, serverName, toolName, mimeType, data string) {
	if len(data) > maxMcpImageBytes*4/3 {
		*textParts = append(*textParts, fmt.Sprintf("[MCP image too large: %s, %d base64 chars]", mimeType, len(data)))
		logMcpContent(serverName, toolName, "image_too_large", len(data), utils.LevelWarn)
		return
	}
	result.Images = append(result.Images, &types.ImageSource{Type: "base64", MediaType: mimeType, Data: data})
	logMcpContent(serverName, toolName, "image", len(data), utils.LevelInfo)
}

func logMcpContent(serverName, toolName, kind string, size int, level utils.LogLevel) {
	utils.LogWithFields(level, "mcp", "decoded MCP tool content", map[string]any{"serverName": serverName, "toolName": toolName, "contentType": kind, "bytes": size})
}
