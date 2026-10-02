package extension

import (
	"testing"
	"time"
)

// TestExtReadDispatchConversation_ReturnsPage pins the wire shape of a
// successful read: the params reach the wired reader, and the page comes back
// with its typed entries, cursor, status, and limits under the documented
// field names.
func TestExtReadDispatchConversation_ReturnsPage(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	var got ReadDispatchConversationOpts
	h.ctxStack.Push(&Context{
		Cwd: "/tmp",
		ReadDispatchConversation: func(opts ReadDispatchConversationOpts) (*DispatchConversationResult, error) {
			got = opts
			return &DispatchConversationResult{
				Outcome: DispatchConversationOK, ConversationID: "conv-1", DispatchID: "d-1", AgentName: "worker",
				Status: "running", NextCursor: "cursor-2", HasMore: true, TotalEntries: 9,
				Limits: &DispatchConversationLimits{Entries: 2, Bytes: 100, MaxEntries: 200, MaxBytes: 1000},
				Entries: []DispatchConversationEntry{{
					ID: "e-1", Role: "assistant", Timestamp: 5,
					Blocks: []DispatchConversationBlock{{Type: "tool_call", ToolCallID: "t-1", ToolName: "Read", Input: map[string]any{"path": "/a"}}},
				}},
			}, nil
		},
	})
	raw := []byte(`{"jsonrpc":"2.0","id":1,"method":"ext/read_dispatch_conversation","params":{"conversationId":"conv-1","dispatchId":"d-1","cursor":"cursor-1","limit":2,"maxBytes":100}}`)
	h.handleExtRequest("ext/read_dispatch_conversation", 1, raw)

	resp := readResponse(t, ch, time.Second)
	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object result, got %#v", resp)
	}
	if got != (ReadDispatchConversationOpts{ConversationID: "conv-1", DispatchID: "d-1", Cursor: "cursor-1", Limit: 2, MaxBytes: 100}) {
		t.Errorf("reader received %+v", got)
	}
	if result["outcome"] != "ok" || result["status"] != "running" || result["terminal"] != false ||
		result["nextCursor"] != "cursor-2" || result["hasMore"] != true || result["totalEntries"] != float64(9) {
		t.Errorf("page envelope = %#v", result)
	}
	limits, ok := result["limits"].(map[string]interface{})
	if !ok || limits["entries"] != float64(2) || limits["maxBytes"] != float64(1000) {
		t.Errorf("limits = %#v", result["limits"])
	}
	entries, ok := result["entries"].([]interface{})
	if !ok || len(entries) != 1 {
		t.Fatalf("entries = %#v, want one", result["entries"])
	}
	entry, ok := entries[0].(map[string]interface{})
	if !ok || entry["id"] != "e-1" || entry["role"] != "assistant" {
		t.Fatalf("entry = %#v", entries[0])
	}
	blocks, ok := entry["blocks"].([]interface{})
	if !ok || len(blocks) != 1 {
		t.Fatalf("blocks = %#v", entry["blocks"])
	}
	block, ok := blocks[0].(map[string]interface{})
	if !ok || block["type"] != "tool_call" || block["toolCallId"] != "t-1" || block["toolName"] != "Read" {
		t.Errorf("block = %#v", blocks[0])
	}
}

// TestExtReadDispatchConversation_RefusesWithoutLineage pins fail-closed
// behavior: a context with no reader wired cannot prove ownership, so it is
// answered "unauthorized" with an empty array, not an error and not content.
func TestExtReadDispatchConversation_RefusesWithoutLineage(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	raw := []byte(`{"jsonrpc":"2.0","id":1,"method":"ext/read_dispatch_conversation","params":{"conversationId":"conv-1"}}`)
	h.handleExtRequest("ext/read_dispatch_conversation", 1, raw)

	resp := readResponse(t, ch, time.Second)
	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object result, got %#v", resp)
	}
	if result["outcome"] != "unauthorized" {
		t.Errorf("outcome = %#v, want unauthorized", result["outcome"])
	}
	if entries, ok := result["entries"].([]interface{}); !ok || len(entries) != 0 {
		t.Errorf("entries = %#v, want []", result["entries"])
	}
}

// TestExtReadDispatchConversation_RequiresTarget pins that a request naming
// neither a conversation nor a dispatch is an invalid-params error.
func TestExtReadDispatchConversation_RequiresTarget(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	raw := []byte(`{"jsonrpc":"2.0","id":1,"method":"ext/read_dispatch_conversation","params":{}}`)
	h.handleExtRequest("ext/read_dispatch_conversation", 1, raw)

	resp := readResponse(t, ch, time.Second)
	rpcErr, ok := resp["error"].(map[string]interface{})
	if !ok || rpcErr["code"] != float64(-32602) {
		t.Fatalf("response = %#v, want a -32602 error", resp)
	}
}
