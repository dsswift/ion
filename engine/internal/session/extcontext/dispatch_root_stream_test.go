package extcontext

import (
	"context"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestNestedDispatchTelemetryOnRootStream pins the load-bearing contract that
// dispatch telemetry at EVERY nesting depth is emitted on the conversation's
// ROOT session stream.
//
// The chain under test is the real production wiring: a depth-1 child's
// AgentSpawner is built by BuildChildAgentSpawner from the SAME
// SessionAccessor as the root dispatch function, so when the child spawns a
// grandchild, beginDispatch emits engine_dispatch_start through the root
// accessor — landing on the root session key that wire consumers subscribe
// to. External consumers (custom clients on the NDJSON socket, the desktop's
// visualization surfaces) reconstruct the full dispatch tree from this one
// stream; if nesting ever switched to a child-session accessor, every
// depth>=2 dispatch would become invisible to them with no schema change to
// catch it. This test goes red in that case.
func TestNestedDispatchTelemetryOnRootStream(t *testing.T) {
	acc := &depthTestAccessor{
		config: &types.EngineRuntimeConfig{MaxDispatchDepth: 5},
	}

	// The production chain: the depth-1 child ("dispatch-lead-1") gets its
	// grandchild spawner from BuildChildAgentSpawner over the root accessor.
	spawner := BuildChildAgentSpawner(acc, nil, 1, "dispatch-lead-1")

	// The child invokes the Agent tool → grandchild dispatch at depth 2.
	// The child backend fails fast (no provider); telemetry emits first.
	_, _ = spawner(context.Background(), "grandchild-agent", "deep work", "", "/tmp", "no-such-model")

	events := acc.emittedEvents()
	var start, end *types.EngineEvent
	for i := range events {
		switch events[i].Type {
		case "engine_dispatch_start":
			if start == nil {
				start = &events[i]
			}
		case "engine_dispatch_end":
			if end == nil {
				end = &events[i]
			}
		}
	}

	if start == nil {
		t.Fatal("expected engine_dispatch_start on the ROOT accessor stream for a nested dispatch")
	}
	if start.DispatchAgent != "grandchild-agent" {
		t.Errorf("dispatch_start agent: got %q, want grandchild-agent", start.DispatchAgent)
	}
	if start.DispatchDepth != 2 {
		t.Errorf("dispatch_start depth: got %d, want 2", start.DispatchDepth)
	}
	if start.DispatchParentId != "dispatch-lead-1" {
		t.Errorf("dispatch_start parentId: got %q, want dispatch-lead-1", start.DispatchParentId)
	}
	if start.DispatchId == "" {
		t.Error("dispatch_start id: empty (consumers address dispatches by id)")
	}

	// The terminal event pairs on the same stream with the same id, so a
	// consumer's start/end correlation never dangles.
	if end == nil {
		t.Fatal("expected engine_dispatch_end on the ROOT accessor stream for a nested dispatch")
	}
	if end.DispatchId != start.DispatchId {
		t.Errorf("dispatch_end id %q != dispatch_start id %q", end.DispatchId, start.DispatchId)
	}
	if end.DispatchDepth != 2 || end.DispatchParentId != "dispatch-lead-1" {
		t.Errorf("dispatch_end attribution: depth=%d parent=%q, want 2/dispatch-lead-1", end.DispatchDepth, end.DispatchParentId)
	}
}
