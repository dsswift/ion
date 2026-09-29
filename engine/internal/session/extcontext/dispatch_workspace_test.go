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

// principalWiringAccessor records the RunConfig the dispatch path asks the
// parent session to stamp with its principal's wiring.
type principalWiringAccessor struct {
	*bumpCountingAccessor
	wired *backend.RunConfig
}

func (a *principalWiringAccessor) WirePrincipalRunConfig(cfg *backend.RunConfig) {
	a.wired = cfg
	cfg.ToolEnv = map[string]string{"PARENT_PRINCIPAL": "wired"}
}

// TestDispatchAgent_ChildActsAsParentPrincipal pins that a dispatched child's
// RunConfig carries the parent session's principal wiring. Without it the
// child runs as nobody: on a partitioned instance its provider credential is
// refused and the gateway answers 401 (a scheduled briefing agent, fired with
// no human in the loop, was the reported case).
func TestDispatchAgent_ChildActsAsParentPrincipal(t *testing.T) {
	child := &configCapturingChildBackend{}
	accessor := &principalWiringAccessor{bumpCountingAccessor: &bumpCountingAccessor{child: child}}

	dispatch := BuildDispatchAgentFunc(accessor, nil, 0, "", nil)
	if _, err := dispatch(extension.DispatchAgentOpts{WaitForCompletion: true, Name: "briefing-writer", Task: "brief"}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	cfg := child.capturedConfig()
	if cfg == nil || accessor.wired != cfg {
		t.Fatalf("the child's own RunConfig was not wired to the parent principal (wired=%p, child=%p)", accessor.wired, cfg)
	}
	if cfg.ToolEnv["PARENT_PRINCIPAL"] != "wired" {
		t.Fatalf("child RunConfig lost the principal wiring: ToolEnv=%v", cfg.ToolEnv)
	}
}
