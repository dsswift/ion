package extcontext

import (
	"testing"
)

// TestNewExtContext_DispatchIdentity pins that NewExtContext copies the
// dispatch identity from ExtContextOpts onto the extension.Context data
// fields. This is what lets every hook fired in a child session — including
// session_start, whose payload is nil — discriminate root (Depth 0) from
// dispatched children (Depth > 0). loadChildExtension builds its
// session_start / before_agent_start contexts through this exact path with
// childDepth >= 1, so a regression here silently reverts child sessions to
// the root shape.
func TestNewExtContext_DispatchIdentity(t *testing.T) {
	acc := &steerSelfAccessor{}

	// Root shape: no opts (backward-compat variadic path).
	root := NewExtContext(acc)
	if root.Depth != 0 {
		t.Errorf("root Depth = %d, want 0", root.Depth)
	}
	if root.DispatchId != "" {
		t.Errorf("root DispatchId = %q, want empty", root.DispatchId)
	}

	// Child shape: opts carry the dispatch ancestry.
	child := NewExtContext(acc, ExtContextOpts{Depth: 1, DispatchId: "dispatch-xyz"})
	if child.Depth != 1 {
		t.Errorf("child Depth = %d, want 1", child.Depth)
	}
	if child.DispatchId != "dispatch-xyz" {
		t.Errorf("child DispatchId = %q, want dispatch-xyz", child.DispatchId)
	}
}
