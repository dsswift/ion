package extension

import (
	"encoding/json"
	"testing"
	"time"
)

// TestExtDispatchAgent_DepthCapResultMarshals verifies the host transport sends
// a structured depth-cap outcome as a successful JSON-RPC result. This fails
// when DispatchAgent returns an error because that branch sends JSON-RPC error
// instead of marshaling the result.
func TestExtDispatchAgent_DepthCapResultMarshals(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)
	h.ctxStack.Push(&Context{
		DispatchAgent: func(DispatchAgentOpts) (*DispatchAgentResult, error) {
			return &DispatchAgentResult{
				DepthCapExceeded:     true,
				RemainingDepthBudget: 0,
				ExitCode:             1,
				Output:               "dispatch depth cap reached: child \"worker\" was not launched; caller work is intact",
			}, nil
		},
	})

	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "ext/dispatch_agent",
		"params": map[string]any{
			"name": "worker",
			"task": "work",
		},
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	h.handleExtRequest("ext/dispatch_agent", 1, payload)

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected resolved JSON-RPC result, got error: %v", resp["error"])
	}
	result, ok := resp["result"].(map[string]any)
	if !ok {
		t.Fatalf("expected object result, got %T: %v", resp["result"], resp["result"])
	}
	if got := result["depthCapExceeded"]; got != true {
		t.Errorf("depthCapExceeded = %v, want true", got)
	}
	if got := result["remainingDepthBudget"]; got != float64(0) {
		t.Errorf("remainingDepthBudget = %v, want 0", got)
	}
	if got := result["exitCode"]; got != float64(1) {
		t.Errorf("exitCode = %v, want 1", got)
	}
}
