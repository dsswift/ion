package extension

import (
	"encoding/json"
	"testing"
	"time"
)

// steerDispatchPayload builds the JSON-RPC frame for ext/steer_dispatch.
func steerDispatchPayload(t *testing.T, dispatchID, message string) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "ext/steer_dispatch",
		"params": map[string]interface{}{
			"dispatchId": dispatchID,
			"message":    message,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestExtSteerDispatch_Delivered verifies the happy path: ctx.SteerDispatch
// is wired, the handler calls it, and the response carries the expected
// delivered=true + outcome="delivered" shape.
func TestExtSteerDispatch_Delivered(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	var gotID, gotMsg string
	ctx := &Context{
		Cwd: "/tmp",
		SteerDispatch: func(dispatchID, message string) (SteerDispatchResult, error) {
			gotID = dispatchID
			gotMsg = message
			return SteerDispatchResult{Delivered: true, Outcome: "delivered"}, nil
		},
	}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/steer_dispatch", 1, steerDispatchPayload(t, "dispatch-abc-123", "focus on tests"))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object result, got %v", resp["result"])
	}
	if got := result["delivered"]; got != true {
		t.Errorf("delivered = %v, want true", got)
	}
	if got := result["outcome"]; got != "delivered" {
		t.Errorf("outcome = %v, want 'delivered'", got)
	}
	if gotID != "dispatch-abc-123" {
		t.Errorf("dispatchID passed = %q, want %q", gotID, "dispatch-abc-123")
	}
	if gotMsg != "focus on tests" {
		t.Errorf("message passed = %q, want %q", gotMsg, "focus on tests")
	}
}

// TestExtSteerDispatch_NotFound verifies a not_found outcome is forwarded.
func TestExtSteerDispatch_NotFound(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	ctx := &Context{
		Cwd: "/tmp",
		SteerDispatch: func(dispatchID, message string) (SteerDispatchResult, error) {
			return SteerDispatchResult{Delivered: false, Outcome: "not_found"}, nil
		},
	}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/steer_dispatch", 1, steerDispatchPayload(t, "no-such-id", "hi"))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object result, got %v", resp["result"])
	}
	if got := result["delivered"]; got != false {
		t.Errorf("delivered = %v, want false", got)
	}
	if got := result["outcome"]; got != "not_found" {
		t.Errorf("outcome = %v, want 'not_found'", got)
	}
}

// TestExtSteerDispatch_NotAvailable verifies the handler returns an error
// when ctx.SteerDispatch is nil (e.g. no registry wired).
func TestExtSteerDispatch_NotAvailable(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	ctx := &Context{Cwd: "/tmp"}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/steer_dispatch", 1, steerDispatchPayload(t, "any", "msg"))

	resp := readResponse(t, ch, time.Second)
	errObj, ok := resp["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected error, got result=%v", resp["result"])
	}
	msg, _ := errObj["message"].(string)
	if msg != "steer dispatch not available" {
		t.Errorf("error message = %q, want 'steer dispatch not available'", msg)
	}
}
