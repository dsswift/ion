package extension

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestRPCCallToolPreservesTypedContent(t *testing.T) {
	const blob = "AAECAw=="
	h := NewHost()
	responseLines := attachStdout(h)
	ctx := &Context{CallToolWithContext: func(_ string, _ map[string]interface{}, _ *float64) (*types.ToolResult, error) {
		return &types.ToolResult{
			Content: "attachment.bin, 4 bytes",
			ContentItems: []types.ToolContent{{
				Type: "resource", Resource: &types.EmbeddedResource{
					URI: "attachment://example", MimeType: "application/octet-stream", Blob: blob,
				},
			}},
		}, nil
	}}
	h.rpcCallTool(ctx, 77, []byte(`{"params":{"name":"mcp__example__resource"}}`))
	response := readResponse(t, responseLines, time.Second)

	encoded, err := json.Marshal(response["result"])
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if !strings.Contains(string(encoded), blob) || !strings.Contains(string(encoded), "attachment://example") {
		t.Fatalf("typed content lost from RPC result: %s", encoded)
	}
}
