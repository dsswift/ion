package ion

import (
	"context"
	"testing"
)

func TestCallToolDecodesTypedMCPContent(t *testing.T) {
	fe := newFakeEngine(t, WithName("call-tool-content"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)
	resultCh := make(chan ToolResult, 1)
	errCh := make(chan error, 1)
	go func() {
		result, err := ctx.CallTool(context.Background(), "mcp__example__resource", nil)
		if err != nil {
			errCh <- err
			return
		}
		resultCh <- result
	}()

	frame := fe.awaitMethod("ext/call_tool")
	id, ok := frame["id"].(float64)
	if !ok {
		t.Fatalf("request id = %#v", frame["id"])
	}
	fe.respond(id, map[string]any{
		"content": "attachment.bin, 4 bytes",
		"isError": true,
		"contentItems": []any{
			map[string]any{"type": "text", "text": "attachment.bin, 4 bytes"},
			map[string]any{"type": "resource", "resource": map[string]any{
				"uri": "attachment://example", "mimeType": "application/octet-stream", "blob": "AAECAw==",
			}},
		},
	})

	select {
	case err := <-errCh:
		t.Fatalf("CallTool: %v", err)
	case result := <-resultCh:
		if result.Content != "attachment.bin, 4 bytes" || !result.IsError {
			t.Fatalf("result = %#v", result)
		}
		if len(result.ContentItems) != 2 || result.ContentItems[1].Resource == nil || result.ContentItems[1].Resource.Blob != "AAECAw==" {
			t.Fatalf("typed result lost embedded blob: %#v", result.ContentItems)
		}
	}
}
