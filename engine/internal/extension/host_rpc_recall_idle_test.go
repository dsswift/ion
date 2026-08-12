package extension

import (
	"encoding/json"
	"strconv"
	"testing"
	"time"
)

// recallAgentPayload builds the JSON-RPC frame for ext/recall_agent.
func recallAgentPayload(t *testing.T, name, reason string) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "ext/recall_agent",
		"params": map[string]interface{}{
			"name":   name,
			"reason": reason,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestRecallAgentWorksWhenParentIdle verifies that ext/recall_agent succeeds
// via the persistent recall fallback when no run context is active (the parent
// run went idle after a dispatch-and-go-idle). The dispatch registry outlives
// runs by design, so recall must not depend on a live ctxStack entry.
func TestRecallAgentWorksWhenParentIdle(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	var gotName, gotReason string
	var called bool
	h.SetPersistentRecall(func(name, reason string) (bool, error) {
		called = true
		gotName = name
		gotReason = reason
		return true, nil
	})

	// No ctxStack entry pushed: ctx is nil, mimicking an idle parent run.
	h.handleExtRequest("ext/recall_agent", 1, recallAgentPayload(t, "watchdog-agent", "timeout"))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object result, got %v", resp["result"])
	}
	if got := result["found"]; got != true {
		t.Errorf("found = %v, want true", got)
	}
	if !called {
		t.Error("persistentRecall was not called")
	}
	if gotName != "watchdog-agent" {
		t.Errorf("name passed = %q, want %q", gotName, "watchdog-agent")
	}
	if gotReason != "timeout" {
		t.Errorf("reason passed = %q, want %q", gotReason, "timeout")
	}
}

// TestRecallAgentNotAvailableWhenIdleAndNoFallback verifies that with no run
// context AND no persistent recall wired, the handler returns the
// "recall not available" error (the negative case).
func TestRecallAgentNotAvailableWhenIdleAndNoFallback(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	// No ctxStack entry and no SetPersistentRecall call.
	h.handleExtRequest("ext/recall_agent", 1, recallAgentPayload(t, "orphan", "cleanup"))

	resp := readResponse(t, ch, time.Second)
	errObj, ok := resp["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected error, got result=%v", resp["result"])
	}
	msg, _ := errObj["message"].(string)
	if msg != "recall not available" {
		t.Errorf("error message = %q, want 'recall not available'", msg)
	}
}

func TestAckDispatchLostCallsPersistentSinkAndIsIdempotent(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	var acknowledged []string
	h.SetPersistentAckDispatchLost(func(dispatchID string) {
		acknowledged = append(acknowledged, dispatchID)
	})
	payload := func(id int) []byte {
		return []byte(`{"jsonrpc":"2.0","id":` + strconv.Itoa(id) + `,"method":"ext/ack_dispatch_lost","params":{"dispatchId":"dispatch-1"}}`)
	}
	for id := 1; id <= 2; id++ {
		h.handleExtRequest("ext/ack_dispatch_lost", int64(id), payload(id))
		response := readResponse(t, ch, time.Second)
		result, ok := response["result"].(map[string]interface{})
		if !ok || result["ok"] != true {
			t.Fatalf("response = %#v, want {ok:true}", response)
		}
	}
	if got := len(acknowledged); got != 2 {
		t.Fatalf("acknowledgements = %d, want 2 idempotent sink calls", got)
	}
}

func TestAckDispatchLostRejectsEmptyDispatchID(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	h.SetPersistentAckDispatchLost(func(dispatchID string) {
		t.Fatal("sink must not be called with empty dispatchId")
	})
	raw := []byte(`{"jsonrpc":"2.0","id":1,"method":"ext/ack_dispatch_lost","params":{"dispatchId":""}}`)
	h.handleExtRequest("ext/ack_dispatch_lost", 1, raw)
	resp := readResponse(t, ch, time.Second)
	if _, ok := resp["error"]; !ok {
		t.Fatalf("expected error for empty dispatchId, got %#v", resp)
	}
}
