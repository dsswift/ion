package config

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestEnforceEnterprise_RecordsPruneAndPinActions pins the feature 0010 audit
// clause at the load-time layer: EnforceEnterprise records each prune/pin
// action into the package recorder, and DrainEnforcementActions returns then
// clears them. Red on unfixed code (no recorder existed).
func TestEnforceEnterprise_RecordsPruneAndPinActions(t *testing.T) {
	// Clear any residue from other tests in this package.
	_ = DrainEnforcementActions()

	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://api.anthropic.com"},
			"rogue":     {BaseURL: "https://rogue.example"},
		},
		McpServers: map[string]types.McpServerConfig{
			"good": {Type: "http", URL: "https://ok.example/mcp"},
			"bad":  {Type: "http", URL: "https://evil.example/mcp"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		AllowedProviders: []string{"anthropic"},
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://gateway.corp.example"},
		},
		McpAllowlist: []string{"good"},
	}

	_ = EnforceEnterprise(cfg, enterprise)

	actions := DrainEnforcementActions()

	var pruned, pinned, mcp bool
	for _, a := range actions {
		switch a.Kind {
		case EnforcementProviderPruned:
			if a.Subject == "rogue" && a.Source == "allowlist" {
				pruned = true
			}
		case EnforcementProviderPinned:
			if a.Subject == "anthropic" && a.Source == "pin" {
				pinned = true
			}
		case EnforcementMcpPruned:
			if a.Subject == "bad" {
				mcp = true
			}
		}
	}
	if !pruned {
		t.Error("expected a provider_pruned action for 'rogue'")
	}
	if !pinned {
		t.Error("expected a provider_pinned action for 'anthropic'")
	}
	if !mcp {
		t.Error("expected an mcp_pruned action for 'bad'")
	}

	// Drain clears the recorder.
	if again := DrainEnforcementActions(); len(again) != 0 {
		t.Errorf("second drain must be empty, got %d actions", len(again))
	}
}

// TestEnforcementRecorder_Bounded pins that the recorder does not grow without
// limit when a drain is never wired (headless library consumers).
func TestEnforcementRecorder_Bounded(t *testing.T) {
	_ = DrainEnforcementActions()
	for i := 0; i < enforcementRecorderMaxActions+50; i++ {
		recordEnforcement(EnforcementProviderPruned, "p", "allowlist", nil)
	}
	actions := DrainEnforcementActions()
	if len(actions) > enforcementRecorderMaxActions {
		t.Errorf("recorder exceeded cap: got %d, cap %d", len(actions), enforcementRecorderMaxActions)
	}
}
