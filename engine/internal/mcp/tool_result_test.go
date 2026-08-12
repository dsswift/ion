package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

func TestToolCallResultPreservesMixedMCPContent(t *testing.T) {
	const blob = "AAECAw=="
	raw := []byte(`{"content":[{"type":"text","text":"attachment.bin, 4 bytes"},{"type":"image","mimeType":"image/png","data":"AAECAw=="},{"type":"resource","resource":{"uri":"attachment://example","mimeType":"application/octet-stream","blob":"` + blob + `"}},{"type":"resource","resource":{"uri":"attachment://example","mimeType":"text/plain","text":"attachment.bin, 4 bytes"}},{"type":"unknown"}],"isError":true}`)

	result, err := parseToolCallResult(raw)
	if err != nil {
		t.Fatalf("parseToolCallResult: %v", err)
	}
	if !result.IsError || len(result.Content) != 5 {
		t.Fatalf("result = %#v, want five items and isError", result)
	}
	if result.Content[2].Resource == nil || result.Content[2].Resource.Blob != blob {
		t.Fatalf("embedded blob lost: %#v", result.Content[2])
	}
	if len(result.Content[4].Unknown) == 0 || !strings.Contains(string(result.Content[4].Unknown), "unknown") {
		t.Fatalf("unknown content was not preserved: %#v", result.Content[4])
	}

	toolResult := result.ToToolResult("srv", "mixed")
	if !strings.Contains(toolResult.Content, "attachment.bin, 4 bytes") || !strings.Contains(toolResult.Content, "attachment://example") {
		t.Fatalf("safe text = %q", toolResult.Content)
	}
	if strings.Contains(toolResult.Content, blob) {
		t.Fatalf("safe text leaked blob: %q", toolResult.Content)
	}
	if len(toolResult.ContentItems) != 5 {
		t.Fatalf("ContentItems = %d, want 5", len(toolResult.ContentItems))
	}
	if len(toolResult.EphemeralImages) != 1 || toolResult.EphemeralImages[0].Data != "AAECAw==" {
		t.Fatalf("EphemeralImages = %#v", toolResult.EphemeralImages)
	}
}

func TestToolCallResultNeverLogsBlob(t *testing.T) {
	const blob = "AAECAw=="
	var fields []map[string]any
	utils.SetTestSink(func(_ utils.LogLevel, _ string, _ string, got map[string]any, _, _ string) {
		fields = append(fields, got)
	})
	t.Cleanup(func() { utils.SetTestSink(nil) })

	result, err := parseToolCallResult([]byte(`{"content":[{"type":"resource","resource":{"uri":"attachment://x","blob":"` + blob + `"}}]}`))
	if err != nil {
		t.Fatalf("parseToolCallResult: %v", err)
	}
	_ = result.ToToolResult("srv", "safe")
	for _, got := range fields {
		encoded, marshalErr := json.Marshal(got)
		if marshalErr != nil {
			t.Fatalf("marshal log fields: %v", marshalErr)
		}
		if strings.Contains(string(encoded), blob) {
			t.Fatalf("blob leaked to log fields: %s", encoded)
		}
	}
}

func TestCallToolTextCompatibility(t *testing.T) {
	conn := &Connection{
		name: "test",
		transport: &mockTransport{recvMsgs: []json.RawMessage{mustMarshal(map[string]any{
			"jsonrpc": "2.0", "id": 1,
			"result": map[string]any{"content": []map[string]any{{"type": "text", "text": "attachment.bin, 4 bytes"}, {"type": "text", "text": "attachment.bin, 4 bytes"}}},
		})}},
		dead: make(chan struct{}),
	}
	text, err := conn.CallTool(context.Background(), "echo", nil)
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if text != "attachment.bin, 4 bytes\nattachment.bin, 4 bytes" {
		t.Errorf("CallTool text = %q, want text-only compatibility", text)
	}
}
