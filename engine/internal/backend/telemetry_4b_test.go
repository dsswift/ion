package backend

import (
	"context"
	"errors"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/types"
)

// failureCategories extracts the set of failure_category values from all
// tool.failure events the mock captured.
func failureCategories(m *mockTelemetry) map[string]bool {
	out := map[string]bool{}
	for _, e := range m.eventsByName("tool.failure") {
		if c, ok := e.Payload["failure_category"].(string); ok {
			out[c] = true
		}
	}
	return out
}

// TestToolFailurePermissionDenied verifies the permission_denied category fires
// when the permission engine denies a tool call.
func TestToolFailurePermissionDenied(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	permEng := permissions.NewEngine(&types.PermissionPolicy{Mode: "deny"})
	run := &activeRun{
		requestID: "deny-req",
		conv:      &conversation.Conversation{ID: "conv-deny"},
		cfg:       &RunConfig{Telemetry: telem, PermEngine: permEng},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Read",
		ID:    "tc-deny",
		Input: map[string]interface{}{"path": "/tmp/x"},
	}}
	if _, err := b.executeTools(context.Background(), run, blocks, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if !failureCategories(telem)["permission_denied"] {
		t.Error("expected a tool.failure event with category permission_denied")
	}
	// The event must carry the tool name, tool_use_id, and a turn.
	for _, e := range telem.eventsByName("tool.failure") {
		if e.Payload["failure_category"] == "permission_denied" {
			if e.Payload["tool"] != "Read" {
				t.Errorf("tool = %v, want Read", e.Payload["tool"])
			}
			if e.Payload["tool_use_id"] != "tc-deny" {
				t.Errorf("tool_use_id = %v, want tc-deny", e.Payload["tool_use_id"])
			}
			if _, ok := e.Payload["turn"]; !ok {
				t.Error("turn field missing")
			}
		}
	}
}

// TestToolFailureHookBlocked verifies the hook_blocked category fires when the
// OnToolCall hook blocks a call.
func TestToolFailureHookBlocked(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "block-req",
		conv:      &conversation.Conversation{ID: "conv-block"},
		cfg: &RunConfig{
			Telemetry: telem,
			Hooks: RunHooks{
				OnToolCall: func(ToolCallInfo) (*ToolCallResult, error) {
					return &ToolCallResult{Block: true, Reason: "blocked by test"}, nil
				},
			},
		},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Read",
		ID:    "tc-block",
		Input: map[string]interface{}{"path": "/tmp/x"},
	}}
	if _, err := b.executeTools(context.Background(), run, blocks, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if !failureCategories(telem)["hook_blocked"] {
		t.Error("expected a tool.failure event with category hook_blocked")
	}
}

// TestToolFailureHookError verifies the hook_error category fires when the
// OnToolCall hook returns an error.
func TestToolFailureHookError(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "hookerr-req",
		conv:      &conversation.Conversation{ID: "conv-hookerr"},
		cfg: &RunConfig{
			Telemetry: telem,
			Hooks: RunHooks{
				OnToolCall: func(ToolCallInfo) (*ToolCallResult, error) {
					return nil, errors.New("hook exploded")
				},
			},
		},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Read",
		ID:    "tc-hookerr",
		Input: map[string]interface{}{"path": "/tmp/x"},
	}}
	if _, err := b.executeTools(context.Background(), run, blocks, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if !failureCategories(telem)["hook_error"] {
		t.Error("expected a tool.failure event with category hook_error")
	}
}

// TestToolFailureUnknownTool verifies the unknown_tool category fires when the
// model invokes a tool the engine does not recognize.
func TestToolFailureUnknownTool(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "unknown-req",
		conv:      &conversation.Conversation{ID: "conv-unknown"},
		cfg:       &RunConfig{Telemetry: telem},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "NoSuchToolXYZ",
		ID:    "tc-unknown",
		Input: map[string]interface{}{},
	}}
	if _, err := b.executeTools(context.Background(), run, blocks, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if !failureCategories(telem)["unknown_tool"] {
		t.Error("expected a tool.failure event with category unknown_tool")
	}
}

// TestToolFailureNilTelemetryNoop verifies executeTools does not panic when
// telemetry is nil (the common disabled case).
func TestToolFailureNilTelemetryNoop(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run := &activeRun{
		requestID: "nil-telem",
		conv:      &conversation.Conversation{ID: "conv-niltelem"},
		cfg:       &RunConfig{},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "NoSuchToolXYZ",
		ID:    "tc-nil",
		Input: map[string]interface{}{},
	}}
	if _, err := b.executeTools(context.Background(), run, blocks, t.TempDir()); err != nil {
		t.Fatal(err)
	}
}

// TestToolFailureExecutionError verifies the execution_error category fires when
// a real registered tool returns IsError=true with no Go-level error. This is
// the dominant real-failure path (Bash non-zero exit, Edit old_string-not-found,
// missing required args) — the tool reports failure by result flag, not by
// returning an error. Before the fix this path emitted tool.execute but never
// tool.failure, silently losing the failure signal. Bash with an empty command
// returns {IsError: true}, nil deterministically, so it is a clean trigger.
func TestToolFailureExecutionError(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "exec-err-req",
		conv:      &conversation.Conversation{ID: "conv-exec-err"},
		cfg:       &RunConfig{Telemetry: telem},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Bash",
		ID:    "tc-exec-err",
		Input: map[string]interface{}{"command": ""},
	}}
	if _, err := b.executeTools(context.Background(), run, blocks, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if !failureCategories(telem)["execution_error"] {
		t.Error("expected a tool.failure event with category execution_error")
	}
	// Exactly one tool.failure event fires — no double-emit with the fall-through
	// result-assembly block.
	fails := telem.eventsByName("tool.failure")
	if len(fails) != 1 {
		t.Errorf("expected exactly 1 tool.failure event, got %d", len(fails))
	}
	for _, e := range fails {
		if e.Payload["tool"] != "Bash" {
			t.Errorf("tool = %v, want Bash", e.Payload["tool"])
		}
		if e.Payload["tool_use_id"] != "tc-exec-err" {
			t.Errorf("tool_use_id = %v, want tc-exec-err", e.Payload["tool_use_id"])
		}
	}
}

// TestToolFailureSuccessNoEmit verifies a tool that SUCCEEDS (IsError=false)
// emits no tool.failure event — the guard must not fire on the happy path.
func TestToolFailureSuccessNoEmit(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "ok-req",
		conv:      &conversation.Conversation{ID: "conv-ok"},
		cfg:       &RunConfig{Telemetry: telem},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Bash",
		ID:    "tc-ok",
		Input: map[string]interface{}{"command": "true"},
	}}
	if _, err := b.executeTools(context.Background(), run, blocks, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if n := len(telem.eventsByName("tool.failure")); n != 0 {
		t.Errorf("expected no tool.failure on success, got %d", n)
	}
}
