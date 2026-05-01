package config

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

func TestMergeConfigs_BasicOverride(t *testing.T) {
	base := DefaultConfig()
	maxTurns := 100
	override := &types.EngineRuntimeConfig{
		Backend:      "cli",
		DefaultModel: "gpt-4",
		Limits: types.LimitsConfig{
			MaxTurns: &maxTurns,
		},
	}

	result := MergeConfigs(nil, base, override)
	if result.Backend != "cli" {
		t.Fatalf("expected backend=cli, got %q", result.Backend)
	}
	if result.DefaultModel != "gpt-4" {
		t.Fatalf("expected defaultModel=gpt-4, got %q", result.DefaultModel)
	}
	if result.Limits.MaxTurns == nil || *result.Limits.MaxTurns != 100 {
		t.Fatalf("expected maxTurns=100, got %v", result.Limits.MaxTurns)
	}
	// Non-overridden values stay at the unopinionated default (nil).
	if result.Limits.MaxBudgetUsd != nil {
		t.Fatalf("expected MaxBudgetUsd=nil, got %v", *result.Limits.MaxBudgetUsd)
	}
}

func TestMergeConfigs_McpServersMerge(t *testing.T) {
	base := &types.EngineRuntimeConfig{
		McpServers: map[string]types.McpServerConfig{
			"server1": {Type: "stdio", Command: "cmd1"},
		},
	}
	overlay := &types.EngineRuntimeConfig{
		McpServers: map[string]types.McpServerConfig{
			"server2": {Type: "sse", URL: "http://localhost"},
		},
	}

	result := MergeConfigs(nil, base, overlay)
	if len(result.McpServers) != 2 {
		t.Fatalf("expected 2 MCP servers, got %d", len(result.McpServers))
	}
	if _, ok := result.McpServers["server1"]; !ok {
		t.Fatal("server1 missing after merge")
	}
	if _, ok := result.McpServers["server2"]; !ok {
		t.Fatal("server2 missing after merge")
	}
}

func TestMergeConfigs_NilInputs(t *testing.T) {
	result := MergeConfigs(nil, nil, nil)
	if result == nil {
		t.Fatal("expected non-nil default config")
	}
	if result.Backend != "api" {
		t.Fatalf("expected default backend=api, got %q", result.Backend)
	}
}

func TestMergeConfigs_DoesNotMutateBase(t *testing.T) {
	base := DefaultConfig()
	base.McpServers["original"] = types.McpServerConfig{Type: "stdio"}

	overlay := &types.EngineRuntimeConfig{
		McpServers: map[string]types.McpServerConfig{
			"added": {Type: "sse"},
		},
	}

	MergeConfigs(nil, base, overlay)

	// Base should not be mutated
	if _, ok := base.McpServers["added"]; ok {
		t.Fatal("base was mutated by merge")
	}
}

func TestMergeConfigs_LaterLayerWins(t *testing.T) {
	base := DefaultConfig()
	layer1 := &types.EngineRuntimeConfig{
		DefaultModel: "model-from-layer1",
	}
	layer2 := &types.EngineRuntimeConfig{
		DefaultModel: "model-from-layer2",
	}
	result := MergeConfigs(nil, base, layer1, layer2)
	if result.DefaultModel != "model-from-layer2" {
		t.Fatalf("expected last layer to win, got %q", result.DefaultModel)
	}
}

func TestMergeConfigs_SkipsNilLayers(t *testing.T) {
	base := DefaultConfig()
	result := MergeConfigs(nil, base, nil, &types.EngineRuntimeConfig{DefaultModel: "override"}, nil)
	if result.DefaultModel != "override" {
		t.Fatalf("expected override, got %q", result.DefaultModel)
	}
	if result.Backend != "api" {
		t.Fatalf("expected backend preserved, got %q", result.Backend)
	}
}

func TestMergeConfigs_DeepMergeLimits(t *testing.T) {
	base := DefaultConfig()
	maxTurns1 := 20
	maxBudget2 := 5.0
	layer1 := &types.EngineRuntimeConfig{
		Limits: types.LimitsConfig{MaxTurns: &maxTurns1},
	}
	layer2 := &types.EngineRuntimeConfig{
		Limits: types.LimitsConfig{MaxBudgetUsd: &maxBudget2},
	}
	result := MergeConfigs(nil, base, layer1, layer2)
	if result.Limits.MaxTurns == nil || *result.Limits.MaxTurns != 20 {
		t.Fatalf("expected maxTurns=20, got %v", result.Limits.MaxTurns)
	}
	if result.Limits.MaxBudgetUsd == nil || *result.Limits.MaxBudgetUsd != 5 {
		t.Fatalf("expected maxBudgetUsd=5, got %v", result.Limits.MaxBudgetUsd)
	}
}

func TestMergeConfigs_ProfilesReplace(t *testing.T) {
	base := DefaultConfig()
	base.Profiles = []types.EngineProfileConfig{
		{ID: "1", Name: "a", ExtensionDir: "/a"},
	}
	overlay := &types.EngineRuntimeConfig{
		Profiles: []types.EngineProfileConfig{
			{ID: "2", Name: "b", ExtensionDir: "/b"},
		},
	}
	result := MergeConfigs(nil, base, overlay)
	if len(result.Profiles) != 1 {
		t.Fatalf("expected 1 profile, got %d", len(result.Profiles))
	}
	if result.Profiles[0].ID != "2" {
		t.Fatalf("expected profile ID=2, got %q", result.Profiles[0].ID)
	}
}

func TestMergeConfigs_ProvidersMerge(t *testing.T) {
	base := DefaultConfig()
	base.Providers["anthropic"] = types.ProviderConfig{APIKey: "key1"}
	overlay := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"openai": {APIKey: "key2"},
		},
	}
	result := MergeConfigs(nil, base, overlay)
	if len(result.Providers) != 2 {
		t.Fatalf("expected 2 providers, got %d", len(result.Providers))
	}
	if result.Providers["anthropic"].APIKey != "key1" {
		t.Fatal("anthropic provider lost during merge")
	}
	if result.Providers["openai"].APIKey != "key2" {
		t.Fatal("openai provider not added during merge")
	}
}

func TestMergeConfigs_ProvidersOverride(t *testing.T) {
	base := DefaultConfig()
	base.Providers["anthropic"] = types.ProviderConfig{APIKey: "old-key"}
	overlay := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {APIKey: "new-key", BaseURL: "https://custom.api"},
		},
	}
	result := MergeConfigs(nil, base, overlay)
	if result.Providers["anthropic"].APIKey != "new-key" {
		t.Fatalf("expected new-key, got %q", result.Providers["anthropic"].APIKey)
	}
	if result.Providers["anthropic"].BaseURL != "https://custom.api" {
		t.Fatalf("expected custom baseURL, got %q", result.Providers["anthropic"].BaseURL)
	}
}

func TestMergeConfigs_McpServerOverride(t *testing.T) {
	base := DefaultConfig()
	base.McpServers["srv"] = types.McpServerConfig{Type: "stdio", Command: "old-cmd"}
	overlay := &types.EngineRuntimeConfig{
		McpServers: map[string]types.McpServerConfig{
			"srv": {Type: "sse", URL: "http://new"},
		},
	}
	result := MergeConfigs(nil, base, overlay)
	if result.McpServers["srv"].Type != "sse" {
		t.Fatalf("expected type=sse, got %q", result.McpServers["srv"].Type)
	}
	if result.McpServers["srv"].URL != "http://new" {
		t.Fatalf("expected url override, got %q", result.McpServers["srv"].URL)
	}
}

func TestMergeConfigs_PermissionsOverride(t *testing.T) {
	base := DefaultConfig()
	overlay := &types.EngineRuntimeConfig{
		Permissions: &types.PermissionPolicy{Mode: "strict"},
	}
	result := MergeConfigs(nil, base, overlay)
	if result.Permissions == nil {
		t.Fatal("expected permissions to be set")
	}
	if result.Permissions.Mode != "strict" {
		t.Fatalf("expected mode=strict, got %q", result.Permissions.Mode)
	}
}

func TestMergeConfigs_TelemetryOverride(t *testing.T) {
	base := DefaultConfig()
	overlay := &types.EngineRuntimeConfig{
		Telemetry: &types.TelemetryConfig{Enabled: true, PrivacyLevel: "minimal"},
	}
	result := MergeConfigs(nil, base, overlay)
	if result.Telemetry == nil || !result.Telemetry.Enabled {
		t.Fatal("expected telemetry to be set and enabled")
	}
	if result.Telemetry.PrivacyLevel != "minimal" {
		t.Fatalf("expected privacyLevel=minimal, got %q", result.Telemetry.PrivacyLevel)
	}
}

func TestMergeConfigs_NetworkOverride(t *testing.T) {
	base := DefaultConfig()
	overlay := &types.EngineRuntimeConfig{
		Network: &types.NetworkConfig{
			Proxy: &types.ProxyConfig{HttpsProxy: "http://proxy:3128"},
		},
	}
	result := MergeConfigs(nil, base, overlay)
	if result.Network == nil || result.Network.Proxy == nil {
		t.Fatal("expected network with proxy")
	}
	if result.Network.Proxy.HttpsProxy != "http://proxy:3128" {
		t.Fatalf("expected proxy, got %q", result.Network.Proxy.HttpsProxy)
	}
}

func TestMergeConfigs_CompactionOverride(t *testing.T) {
	base := DefaultConfig()
	overlay := &types.EngineRuntimeConfig{
		Compaction: &types.CompactionConfig{Strategy: "summary", KeepTurns: 5},
	}
	result := MergeConfigs(nil, base, overlay)
	if result.Compaction == nil {
		t.Fatal("expected compaction to be set")
	}
	if result.Compaction.Strategy != "summary" {
		t.Fatalf("expected strategy=summary, got %q", result.Compaction.Strategy)
	}
}

func TestMergeConfigs_DoesNotMutateProviders(t *testing.T) {
	base := DefaultConfig()
	base.Providers["anthropic"] = types.ProviderConfig{APIKey: "base-key"}
	overlay := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"openai": {APIKey: "new"},
		},
	}
	MergeConfigs(nil, base, overlay)
	if _, ok := base.Providers["openai"]; ok {
		t.Fatal("base providers mutated by merge")
	}
}

func TestMergeConfigs_DoesNotMutateProfiles(t *testing.T) {
	base := DefaultConfig()
	base.Profiles = []types.EngineProfileConfig{{ID: "1", Name: "orig"}}
	overlay := &types.EngineRuntimeConfig{
		Profiles: []types.EngineProfileConfig{{ID: "2", Name: "new"}},
	}
	MergeConfigs(nil, base, overlay)
	if len(base.Profiles) != 1 || base.Profiles[0].ID != "1" {
		t.Fatal("base profiles mutated by merge")
	}
}

func TestMergeConfigs_AllLayersPresent(t *testing.T) {
	base := DefaultConfig()
	globalMaxTurns := 75
	projectMaxBudget := 25.0
	global := &types.EngineRuntimeConfig{
		Backend:      "cli",
		DefaultModel: "global-model",
		Limits:       types.LimitsConfig{MaxTurns: &globalMaxTurns},
	}
	project := &types.EngineRuntimeConfig{
		DefaultModel: "project-model",
		Limits:       types.LimitsConfig{MaxBudgetUsd: &projectMaxBudget},
	}
	result := MergeConfigs(nil, base, global, project)
	// project overrides global for defaultModel
	if result.DefaultModel != "project-model" {
		t.Fatalf("expected project-model, got %q", result.DefaultModel)
	}
	// global overrides base for backend
	if result.Backend != "cli" {
		t.Fatalf("expected cli, got %q", result.Backend)
	}
	// global overrides base maxTurns
	if result.Limits.MaxTurns == nil || *result.Limits.MaxTurns != 75 {
		t.Fatalf("expected maxTurns=75, got %v", result.Limits.MaxTurns)
	}
	// project overrides base maxBudgetUsd
	if result.Limits.MaxBudgetUsd == nil || *result.Limits.MaxBudgetUsd != 25 {
		t.Fatalf("expected maxBudgetUsd=25, got %v", result.Limits.MaxBudgetUsd)
	}
}

func TestMergeConfigs_EmptyConfig(t *testing.T) {
	base := DefaultConfig()
	empty := &types.EngineRuntimeConfig{}
	result := MergeConfigs(nil, base, empty)
	// Empty overlay should not change anything
	if result.Backend != "api" {
		t.Fatalf("expected backend=api, got %q", result.Backend)
	}
	if result.DefaultModel != "claude-sonnet-4-6" {
		t.Fatalf("expected default model, got %q", result.DefaultModel)
	}
	// Defaults ship unopinionated -- limits remain unset.
	if result.Limits.MaxTurns != nil {
		t.Fatalf("expected MaxTurns=nil, got %v", *result.Limits.MaxTurns)
	}
}

func TestMergeConfigs_SingleConfig(t *testing.T) {
	single := &types.EngineRuntimeConfig{
		Backend:      "cli",
		DefaultModel: "test-model",
	}
	result := MergeConfigs(nil, single)
	if result.Backend != "cli" {
		t.Fatalf("expected backend=cli, got %q", result.Backend)
	}
	if result.DefaultModel != "test-model" {
		t.Fatalf("expected test-model, got %q", result.DefaultModel)
	}
}

// ---------------------------------------------------------------------------
// EnforceEnterprise
// ---------------------------------------------------------------------------

func TestMergeEnterprisePartial_OverlayWins(t *testing.T) {
	base := &types.EnterpriseConfig{
		AllowedModels: []string{"model-a"},
		BlockedModels: []string{"model-x"},
	}
	overlay := &types.EnterpriseConfig{
		AllowedModels: []string{"model-b", "model-c"},
	}

	result := mergeEnterprisePartial(base, overlay)
	if len(result.AllowedModels) != 2 {
		t.Fatalf("expected 2 allowed models, got %d", len(result.AllowedModels))
	}
	// Base blocked models should be preserved (overlay has none)
	if len(result.BlockedModels) != 1 {
		t.Fatalf("expected 1 blocked model, got %d", len(result.BlockedModels))
	}
}

func TestMergeEnterprisePartial_AllFieldsOverride(t *testing.T) {
	base := &types.EnterpriseConfig{
		AllowedModels:    []string{"a"},
		BlockedModels:    []string{"b"},
		AllowedProviders: []string{"c"},
		McpAllowlist:     []string{"d"},
		McpDenylist:      []string{"e"},
		ToolRestrictions: &types.ToolRestrictions{Deny: []string{"f"}},
		Telemetry:        &types.TelemetryConfig{Enabled: false},
		Network:          &types.NetworkConfig{CustomCaCerts: []string{"g"}},
	}
	overlay := &types.EnterpriseConfig{
		AllowedModels:    []string{"a2"},
		BlockedModels:    []string{"b2"},
		AllowedProviders: []string{"c2"},
		McpAllowlist:     []string{"d2"},
		McpDenylist:      []string{"e2"},
		ToolRestrictions: &types.ToolRestrictions{Deny: []string{"f2"}},
		Telemetry:        &types.TelemetryConfig{Enabled: true},
		Network:          &types.NetworkConfig{CustomCaCerts: []string{"g2"}},
	}

	result := mergeEnterprisePartial(base, overlay)
	if result.AllowedModels[0] != "a2" {
		t.Fatal("AllowedModels not overridden")
	}
	if result.BlockedModels[0] != "b2" {
		t.Fatal("BlockedModels not overridden")
	}
	if result.AllowedProviders[0] != "c2" {
		t.Fatal("AllowedProviders not overridden")
	}
	if result.McpAllowlist[0] != "d2" {
		t.Fatal("McpAllowlist not overridden")
	}
	if result.McpDenylist[0] != "e2" {
		t.Fatal("McpDenylist not overridden")
	}
	if result.ToolRestrictions.Deny[0] != "f2" {
		t.Fatal("ToolRestrictions not overridden")
	}
	if !result.Telemetry.Enabled {
		t.Fatal("Telemetry not overridden")
	}
	if result.Network.CustomCaCerts[0] != "g2" {
		t.Fatal("Network not overridden")
	}
}

func TestMergeEnterprisePartial_EmptyOverlay(t *testing.T) {
	base := &types.EnterpriseConfig{
		AllowedModels: []string{"keep-me"},
	}
	overlay := &types.EnterpriseConfig{}

	result := mergeEnterprisePartial(base, overlay)
	if len(result.AllowedModels) != 1 || result.AllowedModels[0] != "keep-me" {
		t.Fatal("base values should be preserved with empty overlay")
	}
}

func TestMergeEnterprisePartial_DoesNotMutateBase(t *testing.T) {
	base := &types.EnterpriseConfig{
		AllowedModels: []string{"original"},
	}
	overlay := &types.EnterpriseConfig{
		AllowedModels: []string{"override"},
	}

	mergeEnterprisePartial(base, overlay)
	if base.AllowedModels[0] != "original" {
		t.Fatal("base was mutated")
	}
}

func TestMergeEnterprisePartial_SandboxOverride(t *testing.T) {
	base := &types.EnterpriseConfig{
		Sandbox: &types.SandboxEnterpriseConfig{Required: false},
	}
	overlay := &types.EnterpriseConfig{
		Sandbox: &types.SandboxEnterpriseConfig{Required: true, AllowDisable: false},
	}

	result := mergeEnterprisePartial(base, overlay)
	if !result.Sandbox.Required {
		t.Fatal("expected sandbox required")
	}
}

func TestMergeEnterprisePartial_CustomFieldsOverride(t *testing.T) {
	base := &types.EnterpriseConfig{
		CustomFields: map[string]any{"key1": "val1"},
	}
	overlay := &types.EnterpriseConfig{
		CustomFields: map[string]any{"key2": "val2"},
	}

	result := mergeEnterprisePartial(base, overlay)
	// CustomFields should be replaced entirely
	if _, ok := result.CustomFields["key1"]; ok {
		t.Fatal("expected key1 to be replaced, not merged")
	}
	if result.CustomFields["key2"] != "val2" {
		t.Fatal("expected key2=val2")
	}
}

// ---------------------------------------------------------------------------
// readJSONFile
// ---------------------------------------------------------------------------
