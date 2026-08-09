package extension

import (
	"encoding/json"
	"testing"
	"time"
)

// steerSelfPayload builds the JSON-RPC frame for ext/steer_self.
func steerSelfPayload(t *testing.T, message string) []byte {
	return steerSelfPayloadWithKind(t, message, "")
}

// steerSelfPayloadWithKind exercises the optional injection classification on
// the wire. The persistent fallback is the primary completion-delivery path,
// so losing this field there makes a machine-authored completion reappear as a
// user turn even though the SDK sent the correct classification.
func steerSelfPayloadWithKind(t *testing.T, message, kind string) []byte {
	t.Helper()
	params := map[string]interface{}{"message": message}
	if kind != "" {
		params["kind"] = kind
	}
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "ext/steer_self",
		"params":  params,
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
// neither arm is available: ctx.SteerSelf is nil AND no persistent fallback is
// wired. This is the only shape that should still be refused.
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

// TestExtSteerSelf_PersistentFallback_EmptyCtxStack is the regression pin for
// the defect that made the whole mid-turn steer path dead in production.
//
// This is the REAL shape of a completion delivery, not an edge case: a harness
// calls ctx.steerSelf from a background dispatch's onComplete, which runs on
// the dispatch goroutine after the parent run already exited. Nothing is on the
// ctxStack at that moment, so the ctx arm cannot match. Before the persistent
// fallback existed the handler answered every such call with
// "steer self not available", and the harness fell back to sendPrompt on 100%
// of completions.
//
// Reverting SetPersistentSteerSelf (or the fallback arm in handleSteerRPC)
// turns this red with exactly that error.
func TestExtSteerSelf_PersistentFallback_EmptyCtxStack(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	// Deliberately push nothing: this is the post-run state.
	if h.ctxStack.Current() != nil {
		t.Fatal("precondition: ctxStack must be empty for this test")
	}

	var gotMsg, gotKind string
	h.SetPersistentSteerSelf(func(message, kind string) (SteerDispatchResult, error) {
		gotMsg = message
		gotKind = kind
		return SteerDispatchResult{Delivered: true, Outcome: "steered"}, nil
	})

	h.handleExtRequest("ext/steer_self", 1, steerSelfPayloadWithKind(t, "[Agent obs-specialist completed] telemetry", "agent_completion"))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected the persistent fallback to serve the call, got error %v", resp["error"])
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
	if gotMsg != "[Agent obs-specialist completed] telemetry" {
		t.Errorf("message passed to fallback = %q, want the completion text", gotMsg)
	}
	if gotKind != "agent_completion" {
		t.Errorf("kind passed to fallback = %q, want agent_completion", gotKind)
	}
}

// TestExtSteerSelf_CtxArmWinsOverFallback verifies precedence: when a live
// hook/tool context owns the run, its SteerSelf is used and the persistent
// fallback is left alone. The ctx arm knows the owning run's dispatch identity
// (it may be a depth-N child steering its own run), so it must not be bypassed.
func TestExtSteerSelf_CtxArmWinsOverFallback(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	ctxCalled := false
	fallbackCalled := false

	h.ctxStack.Push(&Context{
		Cwd: "/tmp",
		SteerSelf: func(message string) (SteerDispatchResult, error) {
			ctxCalled = true
			return SteerDispatchResult{Delivered: true, Outcome: "steered"}, nil
		},
	})
	h.SetPersistentSteerSelf(func(message, kind string) (SteerDispatchResult, error) {
		fallbackCalled = true
		return SteerDispatchResult{Delivered: true, Outcome: "sent"}, nil
	})

	h.handleExtRequest("ext/steer_self", 1, steerSelfPayload(t, "msg"))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	if !ctxCalled {
		t.Error("ctx.SteerSelf was not called; the ctx arm must take precedence")
	}
	if fallbackCalled {
		t.Error("persistent fallback was called even though a live ctx was available")
	}
}
