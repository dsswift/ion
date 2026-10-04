package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// The staged policy carries this prompt's allowlists, and the source reads the
// session's plan state when it is called, not when it was built.
func TestCliPlanPolicySource_ReadsLiveSessionState(t *testing.T) {
	mgr := NewManager(backend.NewClaudeCodeBackend())
	s := &engineSession{config: types.EngineConfig{ToolGate: &types.ToolGateConfig{
		Enabled: true,
		ClientTools: []types.ClientToolDef{
			{Name: "client_safe", PlanModeSafe: true},
			{Name: "client_wait", HumanWait: true},
			{Name: "client_mutating"},
		},
	}}}
	mgr.mu.Lock()
	mgr.sessions["cli"] = s
	mgr.mu.Unlock()

	opts := types.RunOptions{
		PlanModeAllowedBashCommands:         []string{"gh"},
		BashAllowlistAdditionsForThisPrompt: []string{"git diff"},
	}
	mgr.stageCliPlanPolicy(s, "cli", &opts, nil)
	source := mgr.cliPlanPolicySource(s)

	if _, planning := source(); planning {
		t.Fatal("a session in auto mode must read as not planning")
	}

	mgr.mu.Lock()
	s.planMode = true
	s.planFilePath = "/plans/a.md"
	mgr.mu.Unlock()

	policy, planning := source()
	if !planning {
		t.Fatal("the source must see plan mode entered after it was built")
	}
	if policy.PlanFilePath != "/plans/a.md" {
		t.Errorf("plan file = %q, want the session's live path", policy.PlanFilePath)
	}
	if got := policy.BashAllowlist; len(got) != 2 || got[0] != "gh" || got[1] != "git diff" {
		t.Errorf("bash allowlist = %v, want the session list plus this prompt's additions", got)
	}
	for name, wantDenied := range map[string]bool{
		"client_safe":     false,
		"client_wait":     false,
		"client_mutating": true,
		"unknown_ext":     true,
	} {
		if got := policy.DecideBridged(name, nil).Denied(); got != wantDenied {
			t.Errorf("DecideBridged(%s) denied=%v, want %v", name, got, wantDenied)
		}
	}
}

// The API backend applies the policy in its own tool loop; nothing is staged
// for it.
func TestStageCliPlanPolicy_NoopForApiBackend(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	s := &engineSession{}
	opts := types.RunOptions{PlanModeAllowedBashCommands: []string{"gh"}}
	mgr.stageCliPlanPolicy(s, "api", &opts, nil)
	if len(s.cliPlanPolicy.BashAllowlist) != 0 || s.cliPlanPolicy.PlanSafe != nil {
		t.Fatal("api backend must not stage a cli plan policy")
	}
}
