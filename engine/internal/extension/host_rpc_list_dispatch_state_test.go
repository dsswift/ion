package extension

import (
	"encoding/json"
	"testing"
	"time"
)

// ─── ext/list_dispatch_state ──────────────────────────────────────────────────

// listDispatchStatePayload returns a JSON-RPC request frame for
// ext/list_dispatch_state. The handler accepts an optional params object;
// we send {} to match the TS SDK wire shape.
func listDispatchStatePayload(t *testing.T) []byte {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "ext/list_dispatch_state",
		"params":  map[string]interface{}{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// TestExtListDispatchState_ReturnsEnvelopeWithEntries verifies the happy path:
// a ctx with ListDispatchState wired returns a { dispatches: [...] } object
// whose entries carry the documented field names. This test fails without the
// ext/list_dispatch_state case in handleExtRequest — reverting the handler
// would route the RPC to the default "not implemented" branch and return an
// error, failing the error check below.
func TestExtListDispatchState_ReturnsEnvelopeWithEntries(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	now := time.Now().UTC()

	ctx := &Context{
		Cwd: "/tmp",
		ListDispatchState: func() ([]DispatchStateEntry, error) {
			return []DispatchStateEntry{
				{
					DispatchID:       "dispatch-alpha-123-abc",
					Name:             "alpha",
					Status:           "running",
					ParentDispatchID: "",
					Depth:            1,
					StartedAt:        now.Format(time.RFC3339Nano),
					ElapsedMs:        500,
				},
				{
					DispatchID:       "dispatch-beta-124-def",
					Name:             "beta",
					Status:           "running",
					ParentDispatchID: "dispatch-alpha-123-abc",
					Depth:            2,
					StartedAt:        now.Format(time.RFC3339Nano),
					ElapsedMs:        200,
				},
			}, nil
		},
	}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/list_dispatch_state", 1, listDispatchStatePayload(t))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}

	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object result, got %T: %v", resp["result"], resp["result"])
	}

	// Envelope must have a "dispatches" array.
	dispatches, ok := result["dispatches"].([]interface{})
	if !ok {
		t.Fatalf("result[\"dispatches\"] = %T, want []interface{}", result["dispatches"])
	}
	if len(dispatches) != 2 {
		t.Fatalf("dispatches len = %d, want 2", len(dispatches))
	}

	// Verify first entry field names and values.
	first, ok := dispatches[0].(map[string]interface{})
	if !ok {
		t.Fatalf("dispatches[0] = %T, want map", dispatches[0])
	}
	if got := first["dispatchId"]; got != "dispatch-alpha-123-abc" {
		t.Errorf("dispatches[0].dispatchId = %v, want %q", got, "dispatch-alpha-123-abc")
	}
	if got := first["name"]; got != "alpha" {
		t.Errorf("dispatches[0].name = %v, want %q", got, "alpha")
	}
	if got := first["status"]; got != "running" {
		t.Errorf("dispatches[0].status = %v, want \"running\"", got)
	}
	if got := first["depth"]; got != float64(1) {
		t.Errorf("dispatches[0].depth = %v, want 1", got)
	}
	if got := first["elapsedMs"]; got != float64(500) {
		t.Errorf("dispatches[0].elapsedMs = %v, want 500", got)
	}
	// parentDispatchId is omitempty; absent for top-level entry.
	if got, exists := first["parentDispatchId"]; exists && got != "" {
		t.Errorf("dispatches[0].parentDispatchId = %v, want absent or empty", got)
	}

	// Verify second entry parentDispatchId is populated.
	second, ok := dispatches[1].(map[string]interface{})
	if !ok {
		t.Fatalf("dispatches[1] = %T, want map", dispatches[1])
	}
	if got := second["parentDispatchId"]; got != "dispatch-alpha-123-abc" {
		t.Errorf("dispatches[1].parentDispatchId = %v, want %q", got, "dispatch-alpha-123-abc")
	}
}

// TestExtListDispatchState_EmptyEnvelopeWhenUnwired verifies that a nil ctx
// (no active hook context) returns { dispatches: [] } without error, so
// extensions loaded outside a dispatch-capable session degrade gracefully.
// Reverting the handler's nil-ctx guard would produce an error response.
func TestExtListDispatchState_EmptyEnvelopeWhenUnwired(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	// No ctx pushed — simulates a hook context that lacks the getter.
	h.handleExtRequest("ext/list_dispatch_state", 1, listDispatchStatePayload(t))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error for nil ctx, got %v", resp["error"])
	}

	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object result, got %T: %v", resp["result"], resp["result"])
	}
	dispatches, ok := result["dispatches"].([]interface{})
	if !ok {
		t.Fatalf("result[\"dispatches\"] = %T, want []interface{}", result["dispatches"])
	}
	if len(dispatches) != 0 {
		t.Errorf("dispatches len = %d, want 0 for unwired ctx", len(dispatches))
	}
}

// TestExtListDispatchState_EmptyArrayWhenNoDispatches verifies that a wired ctx
// whose getter returns an empty slice produces { dispatches: [] } (not null,
// not a missing field). Consumers must be able to iterate the result safely.
func TestExtListDispatchState_EmptyArrayWhenNoDispatches(t *testing.T) {
	h := NewHost()
	ch := attachStdout(h)

	ctx := &Context{
		Cwd: "/tmp",
		ListDispatchState: func() ([]DispatchStateEntry, error) {
			return []DispatchStateEntry{}, nil
		},
	}
	h.ctxStack.Push(ctx)

	h.handleExtRequest("ext/list_dispatch_state", 1, listDispatchStatePayload(t))

	resp := readResponse(t, ch, time.Second)
	if resp["error"] != nil {
		t.Fatalf("expected no error, got %v", resp["error"])
	}
	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected object result, got %T", resp["result"])
	}
	dispatches, ok := result["dispatches"].([]interface{})
	if !ok {
		t.Fatalf("result[\"dispatches\"] = %T, want []interface{}", result["dispatches"])
	}
	if len(dispatches) != 0 {
		t.Errorf("dispatches len = %d, want 0", len(dispatches))
	}
}
