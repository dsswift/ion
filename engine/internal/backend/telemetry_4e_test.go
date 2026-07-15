package backend

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestExecuteTools_EmitsNoHookLatencyFromRunloop pins the § 3 decision: the
// mis-attributed aggregate extension.hook_latency emission has been removed from
// the backend runloop. The authoritative, per-extension-attributed
// extension.hook_latency now lives at the SDK/host callHook seam (see
// extension/host_hook_latency_test.go and session/hook_latency_attribution_test.go).
//
// Driving executeTools with an OnToolCall hook must emit NO extension.hook_latency
// from this layer. Keeping the aggregate alongside the per-handler events would
// double-count every tool_call latency (one aggregate at extension:"" + N
// per-handler) and perpetuate the unattributed null bucket in dashboards.
//
// RED on pre-fix code: the runloop aggregate DID emit exactly this event
// (extension:"", hook:"tool_call"), so this assertion (empty) fails until the
// aggregate block is removed. This locks the decision and prevents a future
// edit from re-introducing the double-counting emission.
func TestExecuteTools_EmitsNoHookLatencyFromRunloop(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "no-agg-req",
		conv:      &conversation.Conversation{ID: "conv-no-agg"},
		cfg: &RunConfig{
			Telemetry: telem,
			Hooks: RunHooks{
				// A real OnToolCall hook is wired: the pre-fix runloop timed this
				// closure and emitted the aggregate. Post-fix, timing/emission
				// moves to callHook and this seam emits nothing.
				OnToolCall: func(ToolCallInfo) (*ToolCallResult, error) {
					return nil, nil
				},
			},
		},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Read",
		ID:    "tc-no-agg",
		Input: map[string]interface{}{"path": "/tmp/x"},
	}}
	if _, err := b.executeTools(context.Background(), run, blocks, t.TempDir()); err != nil {
		t.Fatal(err)
	}

	if events := telem.eventsByName("extension.hook_latency"); len(events) != 0 {
		t.Fatalf("expected 0 extension.hook_latency from the backend runloop, got %d: %+v", len(events), events)
	}
}
