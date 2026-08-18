package mcp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
	mcpgo "github.com/modelcontextprotocol/go-sdk/mcp"
)

// TestModernMRTRRetriesWithOpaqueState pins Ion's adapter around the SDK's
// automatic multi-round-trip middleware. The server returns input_required on
// its first tool invocation. Ion must deliver the request through its callback,
// then the SDK must retry with the opaque requestState and the accepted form
// response before a normal result reaches CallTool.
func TestModernMRTRRetriesWithOpaqueState(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	var calls atomic.Int32
	server := mcpgo.NewServer(&mcpgo.Implementation{Name: "mrtr-fixture", Version: "1"}, nil)
	mcpgo.AddTool(server, &mcpgo.Tool{
		Name:        "confirm_operation",
		Description: "requires a confirmation",
		InputSchema: map[string]any{"type": "object"},
	}, func(_ context.Context, request *mcpgo.CallToolRequest, _ map[string]any) (*mcpgo.CallToolResult, any, error) {
		if calls.Add(1) == 1 {
			return &mcpgo.CallToolResult{
				InputRequests: mcpgo.InputRequestMap{
					"confirm": &mcpgo.ElicitParams{
						Mode:            "form",
						Message:         "Confirm operation",
						RequestedSchema: map[string]any{"type": "object", "properties": map[string]any{"approved": map[string]any{"type": "boolean"}}, "required": []string{"approved"}},
					},
				},
				RequestState: "opaque-state-must-survive",
			}, nil, nil
		}

		if request.Params.RequestState != "opaque-state-must-survive" {
			t.Fatalf("requestState = %q", request.Params.RequestState)
		}
		response, ok := request.Params.InputResponses["confirm"].(*mcpgo.ElicitResult)
		if !ok {
			t.Fatalf("confirm response type = %T", request.Params.InputResponses["confirm"])
		}
		if response.Action != "accept" || response.Content["approved"] != true {
			t.Fatalf("confirmation = %#v", response)
		}
		return &mcpgo.CallToolResult{Content: []mcpgo.Content{&mcpgo.TextContent{Text: "operation confirmed"}}}, nil, nil
	})

	httpServer := httptest.NewServer(mcpgo.NewStreamableHTTPHandler(func(*http.Request) *mcpgo.Server {
		return server
	}, &mcpgo.StreamableHTTPOptions{Stateless: true, JSONResponse: true}))
	defer httpServer.Close()

	var elicited atomic.Int32
	connection, err := ConnectWithOptions("mrtr", types.McpServerConfig{Type: "http", URL: httpServer.URL}, ConnectionOptions{
		Elicit: func(_ context.Context, request ElicitationRequest) (ElicitationReply, error) {
			elicited.Add(1)
			if request.ServerName != "mrtr" || request.Mode != "form" || request.Message != "Confirm operation" {
				t.Fatalf("elicitation = %#v", request)
			}
			return ElicitationReply{Action: "accept", Response: map[string]any{"approved": true}}, nil
		},
	})
	if err != nil {
		t.Fatalf("ConnectWithOptions: %v", err)
	}
	defer func() {
		if closeErr := connection.Close(); closeErr != nil {
			t.Errorf("close: %v", closeErr)
		}
	}()

	result, err := connection.CallTool(context.Background(), "confirm_operation", nil)
	if err != nil {
		t.Fatalf("CallTool: %v", err)
	}
	if result.Content != "operation confirmed" || result.IsError {
		t.Fatalf("result = %#v", result)
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("tool calls = %d, want 2", got)
	}
	if got := elicited.Load(); got != 1 {
		t.Fatalf("elicitation calls = %d, want 1", got)
	}
}
