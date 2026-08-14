package extcontext

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/workspaces"
)

// configCapturingChildBackend accepts RunConfig and records it before using the
// normal deterministic child completion from runOptsCapturingChildBackend.
type configCapturingChildBackend struct {
	runOptsCapturingChildBackend
	cfg *backend.RunConfig
}

func (c *configCapturingChildBackend) StartRunWithConfig(requestID string, opts types.RunOptions, cfg *backend.RunConfig) {
	c.mu.Lock()
	c.cfg = cfg
	c.mu.Unlock()
	c.StartRun(requestID, opts)
}

func (c *configCapturingChildBackend) capturedConfig() *backend.RunConfig {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cfg
}

// TestDispatchAgent_PropagatesParentWorkspaceChecker pins containment across
// dispatch boundary. Without this handoff, child tool loops receive a fresh
// RunConfig with nil WorkspaceChecker and sealed worktrees can write.
func TestDispatchAgent_PropagatesParentWorkspaceChecker(t *testing.T) {
	checker := workspaces.NewCheckerAt(t.TempDir())
	child := &configCapturingChildBackend{}
	accessor := &bumpCountingAccessor{child: child, workspaceChecker: checker}

	dispatch := BuildDispatchAgentFunc(accessor, nil, 0, "", checker)
	if _, err := dispatch(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "contained-child",
		Task:              "attempt sealed write",
	}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	cfg := child.capturedConfig()
	if cfg == nil {
		t.Fatal("child must receive RunConfig")
	}
	if cfg.WorkspaceChecker != checker {
		t.Fatalf("child WorkspaceChecker = %p, want parent checker %p", cfg.WorkspaceChecker, checker)
	}
}
