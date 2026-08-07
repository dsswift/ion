package types

import "testing"

// TestToolGateConfig_Applies pins the gating predicate: nil-safe, disabled
// gates nothing, empty Tools gates everything, a narrow list gates only its
// members.
func TestToolGateConfig_Applies(t *testing.T) {
	var nilCfg *ToolGateConfig
	if nilCfg.Applies("Write") {
		t.Error("nil config must gate nothing")
	}
	if (&ToolGateConfig{Enabled: false}).Applies("Write") {
		t.Error("disabled config must gate nothing")
	}
	all := &ToolGateConfig{Enabled: true}
	if !all.Applies("Write") || !all.Applies("Bash") {
		t.Error("empty Tools must gate every tool")
	}
	narrow := &ToolGateConfig{Enabled: true, Tools: []string{"Write", "Edit"}}
	if !narrow.Applies("Write") || narrow.Applies("Read") {
		t.Error("narrow Tools must gate exactly its members")
	}
}

// TestToolGateConfig_ResolveTimeoutMs pins the default and the declared bound.
func TestToolGateConfig_ResolveTimeoutMs(t *testing.T) {
	var nilCfg *ToolGateConfig
	if got := nilCfg.ResolveTimeoutMs(); got != ToolGateTimeoutMsDefault {
		t.Errorf("nil: want default %d, got %d", ToolGateTimeoutMsDefault, got)
	}
	if got := (&ToolGateConfig{TimeoutMs: -5}).ResolveTimeoutMs(); got != ToolGateTimeoutMsDefault {
		t.Errorf("negative: want default, got %d", got)
	}
	if got := (&ToolGateConfig{TimeoutMs: 500}).ResolveTimeoutMs(); got != 500 {
		t.Errorf("declared: want 500, got %d", got)
	}
}

// TestToolGateConfig_ResolveTimeoutDecision pins the fail-open default: only
// an explicit "deny" declaration produces deny; everything else — absent,
// empty, or unrecognized — resolves to allow.
func TestToolGateConfig_ResolveTimeoutDecision(t *testing.T) {
	var nilCfg *ToolGateConfig
	if got := nilCfg.ResolveTimeoutDecision(); got != GateDecisionAllow {
		t.Errorf("nil: want allow, got %q", got)
	}
	if got := (&ToolGateConfig{TimeoutDecision: "refuse"}).ResolveTimeoutDecision(); got != GateDecisionAllow {
		t.Errorf("unrecognized: want allow, got %q", got)
	}
	if got := (&ToolGateConfig{TimeoutDecision: GateDecisionDeny}).ResolveTimeoutDecision(); got != GateDecisionDeny {
		t.Errorf("deny: want deny, got %q", got)
	}
}
