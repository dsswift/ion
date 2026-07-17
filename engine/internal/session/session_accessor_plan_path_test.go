package session

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestSessionAccessor_AllocatePlanFilePath verifies the production
// sessionAccessor.AllocatePlanFilePath — the seam the plan-mode dispatch path
// (extcontext.BuildDispatchAgentFunc) uses to fill an empty PlanFilePath —
// mints a non-empty, plan-shaped path exactly as the root paths
// (RequestPlanModeEnter, SendPrompt) do. This is the allocated value the child
// run's plan-mode write guard accepts (it compares a Write target against
// run.planFilePath, populated from RunOptions.PlanFilePath). Before the Defect
// 1 fix the dispatch path never called an allocator, so the child ran with
// PlanFilePath="" and the guard rejected every write.
func TestSessionAccessor_AllocatePlanFilePath(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("alloc-plan", defaultConfig())

	mgr.mu.RLock()
	s := mgr.sessions["alloc-plan"]
	mgr.mu.RUnlock()
	if s == nil {
		t.Fatal("session not found after StartSession")
	}

	acc := &sessionAccessor{m: mgr, s: s, key: "alloc-plan"}

	path := acc.AllocatePlanFilePath()

	if path == "" {
		t.Fatal("AllocatePlanFilePath returned empty path")
	}
	// mockBackend is neither CLI nor Hybrid, so the allocator uses the
	// API-backend default branch: ~/.ion/plans/<slug>.md.
	if !strings.HasSuffix(path, ".md") {
		t.Errorf("allocated path %q does not end in .md", path)
	}
	if filepath.Base(filepath.Dir(path)) != "plans" {
		t.Errorf("allocated path %q is not inside a plans/ directory", path)
	}

	// A second allocation must not collide with the first (fresh slug each
	// call), matching the root-path allocator's uniqueness guarantee.
	path2 := acc.AllocatePlanFilePath()
	if path2 == path {
		t.Errorf("two allocations returned the same path %q; expected distinct slugs", path)
	}
}
