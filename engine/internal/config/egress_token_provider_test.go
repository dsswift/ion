package config

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestEgressTokenProviderDecodesFromEngineJSON(t *testing.T) {
	var cfg types.EngineRuntimeConfig
	raw := `{"logging":{"egressTokenScope":"api://app/.default","egressTokenProvider":"telemetry-ship"}}`
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Logging == nil || cfg.Logging.EgressTokenProvider != "telemetry-ship" {
		t.Fatalf("egressTokenProvider did not decode: %+v", cfg.Logging)
	}
	out, err := json.Marshal(types.LoggingConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != "{}" {
		t.Fatalf("unset egressTokenProvider must be omitted, got %s", out)
	}
}

// A later layer's logging block replaces the earlier one whole, carrying its
// egressTokenProvider with it.
func TestEgressTokenProviderLayerMerge(t *testing.T) {
	dst := DefaultConfig()
	mergeInto(dst, &types.EngineRuntimeConfig{Logging: &types.LoggingConfig{EgressTokenProvider: "global-entry"}})
	if dst.Logging.EgressTokenProvider != "global-entry" {
		t.Fatalf("global layer: got %q", dst.Logging.EgressTokenProvider)
	}
	mergeInto(dst, &types.EngineRuntimeConfig{Logging: &types.LoggingConfig{EgressTokenProvider: "project-entry"}})
	if dst.Logging.EgressTokenProvider != "project-entry" {
		t.Fatalf("project layer: got %q", dst.Logging.EgressTokenProvider)
	}
}

func TestEnforceEnterprise_EgressTokenProvider(t *testing.T) {
	sealed := func(logging *types.LoggingConfig) *types.EnterpriseConfig {
		logging.EgressTargets = []string{"otel"}
		return &types.EnterpriseConfig{Logging: logging}
	}

	// Enterprise silent: the lower layer's provider and audience stand.
	cfg := DefaultConfig()
	cfg.Logging = &types.LoggingConfig{EgressTokenProvider: "user-entry", EgressTokenAudience: "user-aud"}
	result := EnforceEnterprise(cfg, sealed(&types.LoggingConfig{}))
	if result.Logging.EgressTokenProvider != "user-entry" || result.Logging.EgressTokenAudience != "user-aud" {
		t.Fatalf("silent enterprise must preserve lower layer, got provider=%q audience=%q",
			result.Logging.EgressTokenProvider, result.Logging.EgressTokenAudience)
	}

	// Enterprise explicit: provider and audience are sealed.
	cfg2 := DefaultConfig()
	cfg2.Logging = &types.LoggingConfig{EgressTokenProvider: "user-entry", EgressTokenAudience: "user-aud"}
	result2 := EnforceEnterprise(cfg2, sealed(&types.LoggingConfig{
		EgressTokenScope:    "api://corp/.default",
		EgressTokenProvider: "corp-machine",
		EgressTokenAudience: "corp-aud",
	}))
	if result2.Logging.EgressTokenProvider != "corp-machine" {
		t.Errorf("enterprise provider must seal, got %q", result2.Logging.EgressTokenProvider)
	}
	if result2.Logging.EgressTokenAudience != "corp-aud" {
		t.Errorf("enterprise audience must seal, got %q", result2.Logging.EgressTokenAudience)
	}
	if result2.Logging.EgressTokenScope != "api://corp/.default" {
		t.Errorf("enterprise scope must seal, got %q", result2.Logging.EgressTokenScope)
	}
}
