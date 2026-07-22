package main

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestEnforcementEventName maps every config action kind to its telemetry name.
func TestEnforcementEventName(t *testing.T) {
	cases := map[config.EnforcementActionKind]string{
		config.EnforcementProviderPruned: telemetry.EnforcementProviderPruned,
		config.EnforcementProviderPinned: telemetry.EnforcementProviderPinned,
		config.EnforcementMcpPruned:      telemetry.EnforcementMcpPruned,
	}
	for kind, want := range cases {
		if got := enforcementEventName(kind); got != want {
			t.Errorf("enforcementEventName(%q) = %q, want %q", kind, got, want)
		}
	}
}

// TestDrainEnforcementActions_EmitsOneEventPerAction pins that the drain path
// converts each recorded load-time enforcement action into one telemetry audit
// event and clears the recorder.
func TestDrainEnforcementActions_EmitsOneEventPerAction(t *testing.T) {
	// Seed the recorder via a real EnforceEnterprise pass.
	_ = config.DrainEnforcementActions() // clear residue
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://api.anthropic.com"},
			"rogue":     {BaseURL: "https://rogue.example"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		AllowedProviders: []string{"anthropic"},
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://gateway.corp.example"},
		},
	}
	_ = config.EnforceEnterprise(cfg, enterprise)

	col := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	drainEnforcementActions(col)

	var pruned, pinned bool
	for _, e := range col.BufferedEvents() {
		switch e.Name {
		case telemetry.EnforcementProviderPruned:
			pruned = true
		case telemetry.EnforcementProviderPinned:
			pinned = true
		}
	}
	if !pruned {
		t.Error("expected an enforcement.provider_pruned event from the drain")
	}
	if !pinned {
		t.Error("expected an enforcement.provider_pinned event from the drain")
	}

	// Recorder is now empty — a second drain emits nothing.
	col2 := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	drainEnforcementActions(col2)
	if len(col2.BufferedEvents()) != 0 {
		t.Errorf("second drain must emit nothing, got %d events", len(col2.BufferedEvents()))
	}
}

// TestDrainEnforcementActions_NilCollectorStillClears pins that a nil collector
// (telemetry disabled) still drains the recorder so it does not grow.
func TestDrainEnforcementActions_NilCollectorStillClears(t *testing.T) {
	_ = config.DrainEnforcementActions()
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{"rogue": {BaseURL: "https://rogue.example"}},
	}
	_ = config.EnforceEnterprise(cfg, &types.EnterpriseConfig{AllowedProviders: []string{"anthropic"}})

	drainEnforcementActions(nil)

	if again := config.DrainEnforcementActions(); len(again) != 0 {
		t.Errorf("nil-collector drain must still clear the recorder, got %d", len(again))
	}
}
