package extcontext

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// attributionAccessor embeds depthTestAccessor and records the AgentStateUpdate
// passed to AppendOrUpdateAgentState so a test can assert the dispatch
// attribution (dispatchDepth / dispatchParentId) stamped at dispatch time.
type attributionAccessor struct {
	*depthTestAccessor
	noopPluginMethods
	mu       sync.Mutex
	appended []types.AgentStateUpdate
}

func (a *attributionAccessor) AppendOrUpdateAgentState(state types.AgentStateUpdate) string {
	a.mu.Lock()
	a.appended = append(a.appended, state)
	a.mu.Unlock()
	return state.ID
}

func (a *attributionAccessor) firstAppended() (types.AgentStateUpdate, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.appended) == 0 {
		return types.AgentStateUpdate{}, false
	}
	return a.appended[0], true
}

// TestDispatchAgentStampsNestingAttribution verifies that the agent-state pill
// created at dispatch time carries the dispatch's own depth and parent-dispatch
// id in metadata. The desktop/iOS main panels filter to root-level agents
// (depth<=1) using exactly these fields, so a nested specialist appears only
// inside its dispatcher's preview, not the main conversation row.
//
// This pins the fix for the leak where a depth-2 dispatch (e.g. engine-dev
// dispatched by dev-lead) surfaced in the main conversation's flat agent
// snapshot. Reverting the metadata stamp makes both subtests fail (the keys are
// absent).
func TestDispatchAgentStampsNestingAttribution(t *testing.T) {
	cases := []struct {
		name           string
		currentDepth   int
		parentDispatch string
		wantDepth      int
		wantParent     string
	}{
		{
			name:           "orchestrator_direct_dispatch_is_depth1_no_parent",
			currentDepth:   0,
			parentDispatch: "",
			wantDepth:      1,
			wantParent:     "",
		},
		{
			name:           "nested_dispatch_is_depth2_with_parent",
			currentDepth:   1,
			parentDispatch: "dispatch-dev-lead-1782781317940-ec68b2477b56",
			wantDepth:      2,
			wantParent:     "dispatch-dev-lead-1782781317940-ec68b2477b56",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			acc := &attributionAccessor{
				depthTestAccessor: &depthTestAccessor{
					config: &types.EngineRuntimeConfig{MaxDispatchDepth: 5},
				},
			}

			dispatchFn := BuildDispatchAgentFunc(acc, nil, tc.currentDepth, tc.parentDispatch)

			// The child backend has no provider, so the dispatch fails after the
			// agent-state append. The append is what we assert; the run outcome is
			// irrelevant here.
			_, _ = dispatchFn(extension.DispatchAgentOpts{
				Name: "engine-dev",
				Task: "implement the thing",
			})

			state, ok := acc.firstAppended()
			if !ok {
				t.Fatal("expected AppendOrUpdateAgentState to be called with the dispatch pill")
			}
			if state.Metadata == nil {
				t.Fatal("expected agent-state metadata to be non-nil")
			}

			gotDepth, ok := state.Metadata["dispatchDepth"].(int)
			if !ok {
				t.Fatalf("expected metadata[\"dispatchDepth\"] to be an int, got %T (%v)",
					state.Metadata["dispatchDepth"], state.Metadata["dispatchDepth"])
			}
			if gotDepth != tc.wantDepth {
				t.Errorf("dispatchDepth = %d, want %d", gotDepth, tc.wantDepth)
			}

			gotParent, ok := state.Metadata["dispatchParentId"].(string)
			if !ok {
				t.Fatalf("expected metadata[\"dispatchParentId\"] to be a string, got %T (%v)",
					state.Metadata["dispatchParentId"], state.Metadata["dispatchParentId"])
			}
			if gotParent != tc.wantParent {
				t.Errorf("dispatchParentId = %q, want %q", gotParent, tc.wantParent)
			}
		})
	}
}
