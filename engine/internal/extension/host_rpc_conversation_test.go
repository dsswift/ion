package extension

import (
	"errors"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestBuildHookEnvelope_ConversationRecordPath(t *testing.T) {
	h := NewHost()

	idle := h.buildHookEnvelope(&Context{Cwd: "/work"}, nil)["_ctx"].(map[string]interface{})
	if _, present := idle["conversationRecordPath"]; present {
		t.Errorf("envelope with no conversation must omit conversationRecordPath, got %v", idle["conversationRecordPath"])
	}

	const path = "/data/conversations/conv-1.tree.jsonl"
	bound := h.buildHookEnvelope(&Context{
		Cwd: "/work", ConversationID: "conv-1", ConversationRecordPath: path,
	}, nil)["_ctx"].(map[string]interface{})
	if got := bound["conversationRecordPath"]; got != path {
		t.Errorf("conversationRecordPath = %v, want %s", got, path)
	}
}

// TestExtReadConversation_ForwardsPagingAndReturnsEnvelope pins the wire
// shape: params reach the reader, and the result is { messages, total,
// hasMore } with each message's timestamp.
func TestExtReadConversation_ForwardsPagingAndReturnsEnvelope(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	var gotID string
	var gotOffset, gotLimit int
	h.ctxStack.Push(&Context{
		ReadConversation: func(conversationID string, offset, limit int) (*ConversationRecord, error) {
			gotID, gotOffset, gotLimit = conversationID, offset, limit
			return &ConversationRecord{
				Messages: []types.SessionMessage{{ID: "e1", Role: "user", Content: "hi", Timestamp: 1780093348767}},
				Total:    7,
				HasMore:  true,
			}, nil
		},
	})

	raw := []byte(`{"jsonrpc":"2.0","id":1,"method":"ext/read_conversation","params":{"conversationId":"conv-9","offset":3,"limit":1}}`)
	h.handleExtRequest("ext/read_conversation", 1, raw)

	if gotID != "conv-9" || gotOffset != 3 || gotLimit != 1 {
		t.Errorf("reader got (%q, %d, %d), want (conv-9, 3, 1)", gotID, gotOffset, gotLimit)
	}
	resp := readResponse(t, ch, time.Second)
	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object result, got %#v", resp)
	}
	messages, ok := result["messages"].([]interface{})
	if !ok || len(messages) != 1 {
		t.Fatalf("messages = %#v, want one message", result["messages"])
	}
	m, _ := messages[0].(map[string]interface{}) //nolint:errcheck // fields asserted below
	if m["id"] != "e1" || m["timestamp"] != float64(1780093348767) {
		t.Errorf("message = %#v, want id e1 with its timestamp", m)
	}
	if result["total"] != float64(7) || result["hasMore"] != true {
		t.Errorf("total = %v, hasMore = %v; want 7, true", result["total"], result["hasMore"])
	}
}

func TestExtReadConversation_Errors(t *testing.T) {
	reader := func(string, int, int) (*ConversationRecord, error) {
		return nil, errors.New("conversation not found: conv-9")
	}
	cases := []struct {
		name   string
		ctx    *Context
		params string
		code   float64
	}{
		{"missing id", &Context{ReadConversation: reader}, `{}`, -32602},
		{"reader not wired", &Context{}, `{"conversationId":"conv-9"}`, -32000},
		{"reader error", &Context{ReadConversation: reader}, `{"conversationId":"conv-9"}`, -32000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := NewHost()
			ch := attachStdout(h)
			h.ctxStack.Push(tc.ctx)
			raw := []byte(`{"jsonrpc":"2.0","id":1,"method":"ext/read_conversation","params":` + tc.params + `}`)
			h.handleExtRequest("ext/read_conversation", 1, raw)
			resp := readResponse(t, ch, time.Second)
			rpcErr, ok := resp["error"].(map[string]interface{})
			if !ok || rpcErr["code"] != tc.code {
				t.Fatalf("response = %#v, want error code %v", resp, tc.code)
			}
		})
	}
}
