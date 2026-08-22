package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	mcpgo "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dsswift/ion/engine/internal/utils"
)

func TestConvertToolResultPreservesMixedMCPContent(t *testing.T) {
	result := &mcpgo.CallToolResult{
		Content: []mcpgo.Content{
			&mcpgo.TextContent{Text: "attachment.bin, 4 bytes"},
			&mcpgo.ImageContent{MIMEType: "image/png", Data: []byte{0, 1, 2, 3}},
			&mcpgo.EmbeddedResource{Resource: &mcpgo.ResourceContents{URI: "attachment://example", MIMEType: "application/octet-stream", Blob: []byte{0, 1, 2, 3}}},
			&mcpgo.EmbeddedResource{Resource: &mcpgo.ResourceContents{URI: "attachment://example", MIMEType: "text/plain", Text: "attachment.bin, 4 bytes"}},
		},
		IsError: true,
	}
	toolResult := convertToolResult(result)
	if !toolResult.IsError || !strings.Contains(toolResult.Content, "attachment.bin, 4 bytes") {
		t.Fatalf("tool result = %#v", toolResult)
	}
	if len(toolResult.ContentItems) != 4 {
		t.Fatalf("ContentItems = %d, want 4", len(toolResult.ContentItems))
	}
	if len(toolResult.EphemeralImages) != 1 || toolResult.EphemeralImages[0].Data != "AAECAw==" {
		t.Fatalf("EphemeralImages = %#v", toolResult.EphemeralImages)
	}
}

func TestConvertToolResultNeverLogsBlob(t *testing.T) {
	const blob = "AAECAw=="
	var fields []map[string]any
	utils.SetTestSink(func(_ utils.LogLevel, _ string, _ string, got map[string]any, _, _ string) {
		fields = append(fields, got)
	})
	t.Cleanup(func() { utils.SetTestSink(nil) })

	_ = convertToolResult(&mcpgo.CallToolResult{Content: []mcpgo.Content{
		&mcpgo.EmbeddedResource{Resource: &mcpgo.ResourceContents{URI: "attachment://x", Blob: []byte{0, 1, 2, 3}}},
	}})
	for _, got := range fields {
		encoded, err := json.Marshal(got)
		if err != nil {
			t.Fatalf("marshal log fields: %v", err)
		}
		if strings.Contains(string(encoded), blob) {
			t.Fatalf("blob leaked to log fields: %s", encoded)
		}
	}
}

func TestSessionBoundResourceLookupRejectsMissingConnection(t *testing.T) {
	_, err := ListMcpResourcesForContext(context.Background(), "missing")
	if err == nil || !strings.Contains(err.Error(), "not connected for this session") {
		t.Fatalf("error = %v", err)
	}
}
