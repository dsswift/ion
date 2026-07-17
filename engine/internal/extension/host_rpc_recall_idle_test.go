package extension

import (
	"encoding/json"
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
