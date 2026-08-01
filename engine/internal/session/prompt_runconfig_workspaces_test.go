package session

// Tests for the workspace-containment threading seam in buildRunConfig.
//
// The containment policy itself is pinned in internal/workspaces, and the
// run-loop enforcement in internal/backend. What neither pins is the wiring
// decision made HERE: containment is on by default (a config with no security
// section threads the checker) and only an explicit
// security.workspaceContainment=false omits it. A regression flipping the
// default to opt-in would pass every other containment test — they construct
// their checkers directly — so the seam gets its own pins.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

func workspaceRunCfg(t *testing.T, cfg *types.EngineRuntimeConfig) *backend.RunConfig {
	t.Helper()
	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	defer mgr.Shutdown()
	if cfg != nil {
		mgr.SetConfig(cfg)
	}

	s := newPlainTestSession("ws-thread")
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"ws-thread": s}
	mgr.mu.Unlock()

	return mgr.buildRunConfig(s, "ws-thread", "req-ws", apiBackend, nil, false, nil, nil, nil, "")
}

func TestBuildRunConfig_WorkspaceCheckerOnByDefault(t *testing.T) {
	// No config at all: the safety baseline must be present without opt-in.
	if runCfg := workspaceRunCfg(t, nil); runCfg.WorkspaceChecker == nil {
		t.Fatal("nil manager config must thread the workspace checker (containment is default-enabled)")
	}

	// A config with no security section: same.
	if runCfg := workspaceRunCfg(t, &types.EngineRuntimeConfig{}); runCfg.WorkspaceChecker == nil {
		t.Fatal("config without a security section must thread the workspace checker")
	}

	// A security section that only sets other fields: same.
	cfg := &types.EngineRuntimeConfig{Security: &types.SecurityConfig{RedactSecrets: true}}
	if runCfg := workspaceRunCfg(t, cfg); runCfg.WorkspaceChecker == nil {
		t.Fatal("security section without workspaceContainment must thread the checker")
	}
}

func TestBuildRunConfig_WorkspaceCheckerDisabledByExplicitFalse(t *testing.T) {
	off := false
	cfg := &types.EngineRuntimeConfig{Security: &types.SecurityConfig{WorkspaceContainment: &off}}
	if runCfg := workspaceRunCfg(t, cfg); runCfg.WorkspaceChecker != nil {
		t.Fatal("explicit workspaceContainment=false must omit the checker (the one supported off-switch)")
	}
}
