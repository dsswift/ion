package ion

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
	"time"
)

// TestGeneratedAgentToolAcknowledgesAsyncDispatch pins the default dispatch
// result visible to the model. The engine returns only a stub at this point, so
// forwarding result.Output would silently report an empty successful tool call.
func TestGeneratedAgentToolAcknowledgesAsyncDispatch(t *testing.T) {
	fe := newFakeEngine(t, WithName("agent-tool-ack-test"))
	fe.sdk.registerDispatchTool("dispatch_reviewer", "Dispatch reviewer", DiscoveredAgent{
		Name: "reviewer", Model: "opus", SystemPrompt: "Review carefully.",
	})
	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(10, "tool/dispatch_reviewer", map[string]any{
		"task": "Review the change",
		ctxKey: map[string]any{"sessionKey": "session-1"},
	})
	frame := fe.awaitMethod("ext/dispatch_agent")
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"dispatchId": "dispatch-42"})

	response := fe.awaitResponse(10)
	result, ok := response["result"].(map[string]any)
	if !ok {
		t.Fatalf("tool result = %#v, want object", response["result"])
	}
	if got := result["content"]; got != "Dispatched reviewer specialist (dispatch-42)." {
		t.Errorf("tool content = %q, want dispatch acknowledgement", got)
	}
	if got := result["isError"]; got == true {
		t.Errorf("tool result unexpectedly reported an error: %#v", result)
	}
}

// TestAsyncDispatchTerminalBeforeStubResponse pins name-keyed terminal routing.
// A fast child may notify completion before its dispatch stub response arrives;
// that race must still invoke the terminal callback exactly once and clean every
// lifecycle route before a later notification can reach stale state.
func TestAsyncDispatchTerminalBeforeStubResponse(t *testing.T) {
	fe := newFakeEngine(t, WithName("dispatch-terminal-race-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	ctx := fe.sdk.newContext(nil)
	completed := make(chan DispatchAgentResult, 1)
	stale := make(chan DispatchTextDeltaInfo, 1)
	returned := make(chan error, 1)
	go func() {
		_, err := ctx.DispatchAgent(context.Background(), DispatchAgentOpts{
			Name:        "worker",
			Task:        "finish quickly",
			OnComplete:  func(result DispatchAgentResult) { completed <- result },
			OnTextDelta: func(info DispatchTextDeltaInfo) { stale <- info },
		})
		returned <- err
	}()

	frame := fe.awaitMethod("ext/dispatch_agent")
	id, _ := frame["id"].(float64)
	fe.notify("dispatch_complete", map[string]any{
		"name": "worker", "dispatchId": "dispatch-fast", "output": "done", "exitCode": 0,
	})
	fe.respond(id, map[string]any{"name": "worker", "dispatchId": "dispatch-fast"})

	if err := <-returned; err != nil {
		t.Fatalf("dispatch returned error: %v", err)
	}
	select {
	case result := <-completed:
		if result.DispatchID != "dispatch-fast" || result.Output != "done" {
			t.Errorf("OnComplete = %+v, want terminal fast dispatch", result)
		}
	case <-time.After(time.Second):
		t.Fatal("terminal notification before stub response did not reach OnComplete")
	}
	fe.notify("dispatch_text_delta", map[string]any{
		"name": "worker", "dispatchId": "dispatch-fast", "delta": "late", "accumulated": "late",
	})
	select {
	case info := <-stale:
		t.Fatalf("stale lifecycle handler received %+v after terminal completion", info)
	case <-time.After(100 * time.Millisecond):
	}
}

// TestHookResultWithEventsPreservesLargeInteger pins JSON numeric fidelity for
// structured results. Decoding through map[string]any turns values above 2^53
// into float64 and silently rounds them before the engine sees the hook result.
func TestHookResultWithEventsPreservesLargeInteger(t *testing.T) {
	const largeID int64 = 9_007_199_254_740_993
	wrapped := wrapHookResult(struct {
		ID int64 `json:"id"`
	}{ID: largeID}, []EngineEvent{NewEvent("engine_notify", map[string]any{"message": "queued"})})
	raw, ok := wrapped.(json.RawMessage)
	if !ok {
		t.Fatalf("wrapped result = %T, want raw JSON object", wrapped)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var result map[string]any
	if err := decoder.Decode(&result); err != nil {
		t.Fatalf("decode hook result: %v", err)
	}
	if got := result["id"]; got != json.Number("9007199254740993") {
		t.Errorf("id = %v, want exact %d", got, largeID)
	}
}
