package ion

import (
	"context"
	"testing"
)

type conversationReadOutcome struct {
	result *DispatchConversationResult
	err    error
}

func readDispatchConversationAsync(fe *fakeEngine, opts ReadDispatchConversationOpts) <-chan conversationReadOutcome {
	done := make(chan conversationReadOutcome, 1)
	go func() {
		result, err := fe.sdk.newContext(nil).ReadDispatchConversation(context.Background(), opts)
		done <- conversationReadOutcome{result, err}
	}()
	return done
}

func TestReadDispatchConversationSendsOptsAndDecodesPage(t *testing.T) {
	fe := newFakeEngine(t, WithName("dispatch-conversation-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	done := readDispatchConversationAsync(fe, ReadDispatchConversationOpts{ConversationID: "conv-1", Cursor: "c-1", Limit: 5, MaxBytes: 4096})
	frame := fe.awaitMethod("ext/read_dispatch_conversation")
	params, _ := frame["params"].(map[string]any)
	if params["conversationId"] != "conv-1" || params["cursor"] != "c-1" || params["limit"] != float64(5) || params["maxBytes"] != float64(4096) {
		t.Errorf("params = %#v", params)
	}
	if _, sent := params["dispatchId"]; sent {
		t.Errorf("an unset dispatchId was sent: %#v", params)
	}
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{
		"outcome": "ok", "conversationId": "conv-1", "dispatchId": "d-1", "agentName": "worker",
		"status": "cancelled", "terminal": true, "reason": "timeout", "exitCode": 2,
		"nextCursor": "c-2", "hasMore": true, "totalEntries": 7,
		"limits": map[string]any{"entries": 5, "bytes": 4096, "maxEntries": 200, "maxBytes": 262144},
		"entries": []any{
			map[string]any{"id": "e-1", "role": "assistant", "timestamp": 10, "blocks": []any{
				map[string]any{"type": "text", "text": "reading"},
				map[string]any{"type": "tool_call", "toolCallId": "t-1", "toolName": "Read", "input": map[string]any{"path": "/a"}},
			}},
			map[string]any{"id": "e-2", "role": "user", "timestamp": 11, "blocks": []any{
				map[string]any{"type": "tool_result", "toolCallId": "t-1", "toolName": "Read", "content": "body", "isError": true, "truncated": true, "originalBytes": 900},
			}},
		},
	})
	got := <-done
	if got.err != nil {
		t.Fatalf("ReadDispatchConversation: %v", got.err)
	}
	r := got.result
	if r.Outcome != DispatchConversationOK || r.Status != "cancelled" || !r.Terminal || r.Reason != "timeout" || r.ExitCode == nil || *r.ExitCode != 2 ||
		r.NextCursor != "c-2" || !r.HasMore || r.TotalEntries != 7 || r.Limits == nil || r.Limits.MaxBytes != 262144 {
		t.Errorf("result = %+v", r)
	}
	if len(r.Entries) != 2 || len(r.Entries[0].Blocks) != 2 {
		t.Fatalf("entries = %+v", r.Entries)
	}
	if call := r.Entries[0].Blocks[1]; call.Type != "tool_call" || call.ToolCallID != "t-1" || call.ToolName != "Read" || call.Input["path"] != "/a" {
		t.Errorf("tool call = %+v", call)
	}
	if res := r.Entries[1].Blocks[0]; res.Type != "tool_result" || res.Content != "body" || !res.IsError || !res.Truncated || res.OriginalBytes != 900 {
		t.Errorf("tool result = %+v", res)
	}
}

func TestReadDispatchConversationReportsUnsupportedEngine(t *testing.T) {
	fe := newFakeEngine(t, WithName("dispatch-conversation-unsupported-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	done := readDispatchConversationAsync(fe, ReadDispatchConversationOpts{DispatchID: "d-1"})
	frame := fe.awaitMethod("ext/read_dispatch_conversation")
	id, _ := frame["id"].(float64)
	fe.respondError(id, CodeMethodNotFound, "method not found")
	got := <-done
	if got.err != nil {
		t.Fatalf("ReadDispatchConversation: %v", got.err)
	}
	if got.result.Outcome != DispatchConversationUnsupported || got.result.Entries == nil || len(got.result.Entries) != 0 {
		t.Errorf("result = %+v, want unsupported with an empty page", got.result)
	}
}

func TestReadDispatchConversationKeepsRefusalAsResult(t *testing.T) {
	fe := newFakeEngine(t, WithName("dispatch-conversation-refusal-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	done := readDispatchConversationAsync(fe, ReadDispatchConversationOpts{ConversationID: "conv-sibling"})
	frame := fe.awaitMethod("ext/read_dispatch_conversation")
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"outcome": "unauthorized", "terminal": false, "entries": []any{}, "hasMore": false, "totalEntries": 0})
	got := <-done
	if got.err != nil || got.result.Outcome != DispatchConversationUnauthorized || len(got.result.Entries) != 0 {
		t.Errorf("result = %+v, err %v; want an unauthorized result and no error", got.result, got.err)
	}

	if _, err := fe.sdk.newContext(nil).ReadDispatchConversation(context.Background(), ReadDispatchConversationOpts{}); err == nil {
		t.Error("a read with no target was sent, want a local error")
	}
}
