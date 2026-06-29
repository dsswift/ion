package extension

import (
	"encoding/json"
	"testing"
	"time"
)

// steerSelfPayload builds the JSON-RPC frame for ext/steer_self.
func steerSelfPayload(t *testing.T, message string) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "ext/steer_self",
		"params": map[string]interface{}{
			"message": message,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestExtSteerSelf_Steered verifies the live-run path: ctx.SteerSelf is wired,
// the handler calls it with the message, and the response carries the
// delivered=true + outcome="steered" shape (owning run was live).
func TestExtSteerSelf_Steered(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	var gotMsg string
	ctx := &Context{
		Cwd: "/tmp",
		SteerSelf: func(message string) (SteerDispatchResult, error) {
			gotMsg = message
			return SteerDispatchResult{Delivered: true, Outcome: "steered"}, nil
		},
	}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/steer_self", 1, steerSelfPayload(t, "[Agent dev-lead completed] result"))

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
	if got := result["outcome"]; got != "steered" {
		t.Errorf("outcome = %v, want 'steered'", got)
	}
	if gotMsg != "[Agent dev-lead completed] result" {
		t.Errorf("message passed = %q, want the completion text", gotMsg)
	}
}

// TestExtSteerSelf_Sent verifies the idle-run path: when the owning run is
// idle the engine sends a fresh prompt and reports outcome="sent".
func TestExtSteerSelf_Sent(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	ctx := &Context{
		Cwd: "/tmp",
		SteerSelf: func(message string) (SteerDispatchResult, error) {
			return SteerDispatchResult{Delivered: true, Outcome: "sent"}, nil
		},
	}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/steer_self", 1, steerSelfPayload(t, "hello"))

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
	if got := result["outcome"]; got != "sent" {
		t.Errorf("outcome = %v, want 'sent'", got)
	}
}

// TestExtSteerSelf_NotAvailable verifies the handler returns an error when
// ctx.SteerSelf is nil (e.g. no registry / steer support wired).
func TestExtSteerSelf_NotAvailable(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	ctx := &Context{Cwd: "/tmp"}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/steer_self", 1, steerSelfPayload(t, "msg"))

	resp := readResponse(t, ch, time.Second)
	errObj, ok := resp["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected error, got result=%v", resp["result"])
	}
	msg, _ := errObj["message"].(string)
	if msg != "steer self not available" {
		t.Errorf("error message = %q, want 'steer self not available'", msg)
	}
}
