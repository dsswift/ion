package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.Backend != "api" {
		t.Fatalf("expected backend=api, got %q", cfg.Backend)
	}
	if cfg.DefaultModel != "claude-sonnet-4-6" {
		t.Fatalf("expected defaultModel=claude-sonnet-4-6, got %q", cfg.DefaultModel)
	}
	if cfg.Limits.MaxTurns == nil || *cfg.Limits.MaxTurns != 50 {
		t.Fatalf("expected maxTurns=50, got %v", cfg.Limits.MaxTurns)
	}
	if cfg.Limits.MaxBudgetUsd == nil || *cfg.Limits.MaxBudgetUsd != 10.0 {
		t.Fatalf("expected maxBudgetUsd=10.0, got %v", cfg.Limits.MaxBudgetUsd)
	}
	if cfg.Limits.IdleTimeoutMs == nil || *cfg.Limits.IdleTimeoutMs != 300000 {
		t.Fatalf("expected idleTimeoutMs=300000, got %v", cfg.Limits.IdleTimeoutMs)
	}
}

func TestDefaultConfig_McpServersInitialized(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.McpServers == nil {
		t.Fatal("expected McpServers map to be initialized")
	}
	if len(cfg.McpServers) != 0 {
		t.Fatalf("expected empty McpServers map, got %d entries", len(cfg.McpServers))
	}
}

func TestDefaultConfig_ProvidersInitialized(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.Providers == nil {
		t.Fatal("expected Providers map to be initialized")
	}
	if len(cfg.Providers) != 0 {
		t.Fatalf("expected empty Providers map, got %d entries", len(cfg.Providers))
	}
}

func TestDefaultConfig_ProfilesNil(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.Profiles != nil {
		t.Fatal("expected Profiles to be nil by default")
	}
}

func TestDefaultConfig_OptionalFieldsNil(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.Permissions != nil {
		t.Fatal("expected Permissions to be nil")
	}
	if cfg.Auth != nil {
		t.Fatal("expected Auth to be nil")
	}
	if cfg.Network != nil {
		t.Fatal("expected Network to be nil")
	}
	if cfg.Telemetry != nil {
		t.Fatal("expected Telemetry to be nil")
	}
	if cfg.Compaction != nil {
		t.Fatal("expected Compaction to be nil")
	}
	if cfg.Enterprise != nil {
		t.Fatal("expected Enterprise to be nil")
	}
}

// ---------------------------------------------------------------------------
// ExpandTilde
// ---------------------------------------------------------------------------

func TestExpandTilde(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("cannot determine home dir")
	}

	tests := []struct {
		input string
		want  string
	}{
		{"~/foo/bar", home + "/foo/bar"},
		{"~", home},
		{"/absolute/path", "/absolute/path"},
		{"relative/path", "relative/path"},
		{"", ""},
	}

	for _, tt := range tests {
		got := ExpandTilde(tt.input)
		if got != tt.want {
			t.Errorf("ExpandTilde(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestExpandTilde_TildeInMiddle(t *testing.T) {
	// Tilde only expanded when it is the first character
	got := ExpandTilde("/some/~path")
	if got != "/some/~path" {
		t.Errorf("expected /some/~path unchanged, got %q", got)
	}
}

// ---------------------------------------------------------------------------
// FindProfile
// ---------------------------------------------------------------------------

func TestFindProfile(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Profiles: []types.EngineProfileConfig{
			{ID: "p1", Name: "default"},
			{ID: "p2", Name: "work"},
		},
	}

	tests := []struct {
		query string
		want  string
	}{
		{"default", "p1"},
		{"work", "p2"},
		{"p1", "p1"},
		{"p2", "p2"},
		{"missing", ""},
	}

	for _, tt := range tests {
		p := FindProfile(tt.query, cfg)
		if tt.want == "" {
			if p != nil {
				t.Errorf("FindProfile(%q) expected nil, got %v", tt.query, p)
			}
			continue
		}
		if p == nil {
			t.Errorf("FindProfile(%q) returned nil, expected ID=%q", tt.query, tt.want)
			continue
		}
		if p.ID != tt.want {
			t.Errorf("FindProfile(%q).ID = %q, want %q", tt.query, p.ID, tt.want)
		}
	}
}

func TestFindProfile_NilConfig(t *testing.T) {
	if p := FindProfile("test", nil); p != nil {
		t.Fatal("expected nil for nil config")
	}
}

func TestFindProfile_EmptyProfiles(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{Profiles: []types.EngineProfileConfig{}}
	if p := FindProfile("anything", cfg); p != nil {
		t.Fatal("expected nil for empty profiles slice")
	}
}

func TestFindProfile_EmptyQuery(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Profiles: []types.EngineProfileConfig{
			{ID: "p1", Name: "default"},
		},
	}
	if p := FindProfile("", cfg); p != nil {
		t.Fatal("expected nil for empty query string")
	}
}

// ---------------------------------------------------------------------------
// MergeConfigs
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
	// Non-overridden values should keep defaults
	if result.Limits.MaxBudgetUsd == nil || *result.Limits.MaxBudgetUsd != 10.0 {
		t.Fatalf("expected maxBudgetUsd=10.0, got %v", result.Limits.MaxBudgetUsd)
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
	if result.Limits.IdleTimeoutMs == nil || *result.Limits.IdleTimeoutMs != 300000 {
		t.Fatalf("expected idleTimeoutMs=300000, got %v", result.Limits.IdleTimeoutMs)
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
	// default idleTimeoutMs preserved
	if result.Limits.IdleTimeoutMs == nil || *result.Limits.IdleTimeoutMs != 300000 {
		t.Fatalf("expected idleTimeoutMs=300000, got %v", result.Limits.IdleTimeoutMs)
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
	if result.Limits.MaxTurns == nil || *result.Limits.MaxTurns != 50 {
		t.Fatalf("expected maxTurns=50, got %v", result.Limits.MaxTurns)
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

func TestEnforceEnterprise_AllowedModels(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DefaultModel = "gpt-4"

	enterprise := &types.EnterpriseConfig{
		AllowedModels: []string{"claude-sonnet-4-6", "claude-opus-4"},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if result.DefaultModel != "claude-sonnet-4-6" {
		t.Fatalf("expected fallback to claude-sonnet-4-6, got %q", result.DefaultModel)
	}
}

func TestEnforceEnterprise_AllowedModels_NoChange(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DefaultModel = "claude-opus-4"

	enterprise := &types.EnterpriseConfig{
		AllowedModels: []string{"claude-sonnet-4-6", "claude-opus-4"},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if result.DefaultModel != "claude-opus-4" {
		t.Fatalf("expected claude-opus-4 to remain, got %q", result.DefaultModel)
	}
}

func TestEnforceEnterprise_BlockedModels(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DefaultModel = "gpt-4"

	enterprise := &types.EnterpriseConfig{
		BlockedModels: []string{"gpt-4"},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if result.DefaultModel != "claude-sonnet-4-6" {
		t.Fatalf("expected fallback to claude-sonnet-4-6, got %q", result.DefaultModel)
	}
}

func TestEnforceEnterprise_BlockedWithAllowed(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DefaultModel = "gpt-4"

	enterprise := &types.EnterpriseConfig{
		AllowedModels: []string{"claude-opus-4"},
		BlockedModels: []string{"gpt-4"},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if result.DefaultModel != "claude-opus-4" {
		t.Fatalf("expected fallback to claude-opus-4, got %q", result.DefaultModel)
	}
}

func TestEnforceEnterprise_BlockedFallsBackToSonnetWhenNoAllowed(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DefaultModel = "bad-model"

	enterprise := &types.EnterpriseConfig{
		BlockedModels: []string{"bad-model"},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if result.DefaultModel != "claude-sonnet-4-6" {
		t.Fatalf("expected fallback to claude-sonnet-4-6, got %q", result.DefaultModel)
	}
}

func TestEnforceEnterprise_McpDenylist(t *testing.T) {
	cfg := DefaultConfig()
	cfg.McpServers = map[string]types.McpServerConfig{
		"allowed-server": {Type: "stdio"},
		"blocked-server": {Type: "stdio"},
	}

	enterprise := &types.EnterpriseConfig{
		McpDenylist: []string{"blocked-server"},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if _, ok := result.McpServers["blocked-server"]; ok {
		t.Fatal("blocked server should have been removed")
	}
	if _, ok := result.McpServers["allowed-server"]; !ok {
		t.Fatal("allowed server should remain")
	}
}

func TestEnforceEnterprise_McpAllowlist(t *testing.T) {
	cfg := DefaultConfig()
	cfg.McpServers = map[string]types.McpServerConfig{
		"allowed":   {Type: "stdio"},
		"notlisted": {Type: "stdio"},
	}

	enterprise := &types.EnterpriseConfig{
		McpAllowlist: []string{"allowed"},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if _, ok := result.McpServers["notlisted"]; ok {
		t.Fatal("non-allowlisted server should have been removed")
	}
	if _, ok := result.McpServers["allowed"]; !ok {
		t.Fatal("allowlisted server should remain")
	}
}

func TestEnforceEnterprise_TelemetryForced(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Telemetry = &types.TelemetryConfig{Enabled: false}

	enterprise := &types.EnterpriseConfig{
		Telemetry: &types.TelemetryConfig{
			Enabled:      true,
			Targets:      []string{"https://telemetry.corp"},
			PrivacyLevel: "full",
		},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if !result.Telemetry.Enabled {
		t.Fatal("telemetry should be forced enabled")
	}
	if len(result.Telemetry.Targets) != 1 || result.Telemetry.Targets[0] != "https://telemetry.corp" {
		t.Fatal("telemetry targets should be set from enterprise")
	}
	if result.Telemetry.PrivacyLevel != "full" {
		t.Fatalf("expected privacyLevel=full, got %q", result.Telemetry.PrivacyLevel)
	}
}

func TestEnforceEnterprise_TelemetryNilBecomesEnabled(t *testing.T) {
	cfg := DefaultConfig()
	// cfg.Telemetry is nil

	enterprise := &types.EnterpriseConfig{
		Telemetry: &types.TelemetryConfig{
			Enabled: true,
			Targets: []string{"https://corp.telemetry"},
		},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if result.Telemetry == nil {
		t.Fatal("expected telemetry to be created")
	}
	if !result.Telemetry.Enabled {
		t.Fatal("expected telemetry enabled")
	}
}

func TestEnforceEnterprise_TelemetryNotForcedWhenEnterpriseDisabled(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Telemetry = &types.TelemetryConfig{Enabled: true}

	enterprise := &types.EnterpriseConfig{
		Telemetry: &types.TelemetryConfig{Enabled: false},
	}

	result := EnforceEnterprise(cfg, enterprise)
	// Enterprise telemetry is not enabled, so user setting should remain
	if result.Telemetry == nil {
		t.Fatal("expected telemetry to exist")
	}
	// The enforcement only forces enabled=true; when enterprise says disabled,
	// the user telemetry is not overridden (enterprise block does not run).
	if !result.Telemetry.Enabled {
		t.Fatal("user telemetry should remain when enterprise telemetry is disabled")
	}
}

func TestEnforceEnterprise_NetworkEnforcement(t *testing.T) {
	cfg := DefaultConfig()

	enterprise := &types.EnterpriseConfig{
		Network: &types.NetworkConfig{
			Proxy: &types.ProxyConfig{
				HttpsProxy: "http://proxy.corp:8080",
			},
			CustomCaCerts: []string{"/etc/ssl/corp-ca.pem"},
		},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if result.Network == nil {
		t.Fatal("expected network config")
	}
	if result.Network.Proxy == nil || result.Network.Proxy.HttpsProxy != "http://proxy.corp:8080" {
		t.Fatal("expected proxy to be set from enterprise")
	}
	if len(result.Network.CustomCaCerts) != 1 {
		t.Fatalf("expected 1 CA cert, got %d", len(result.Network.CustomCaCerts))
	}
}

func TestEnforceEnterprise_NetworkProxyOnly(t *testing.T) {
	cfg := DefaultConfig()
	enterprise := &types.EnterpriseConfig{
		Network: &types.NetworkConfig{
			Proxy: &types.ProxyConfig{
				HttpProxy:  "http://proxy:80",
				HttpsProxy: "http://proxy:443",
				NoProxy:    "localhost,127.0.0.1",
			},
		},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if result.Network.Proxy.HttpProxy != "http://proxy:80" {
		t.Fatalf("expected httpProxy, got %q", result.Network.Proxy.HttpProxy)
	}
	if result.Network.Proxy.NoProxy != "localhost,127.0.0.1" {
		t.Fatalf("expected noProxy, got %q", result.Network.Proxy.NoProxy)
	}
}

func TestEnforceEnterprise_NetworkCaCertsOnly(t *testing.T) {
	cfg := DefaultConfig()
	enterprise := &types.EnterpriseConfig{
		Network: &types.NetworkConfig{
			CustomCaCerts: []string{"/ca1.pem", "/ca2.pem"},
		},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if result.Network == nil {
		t.Fatal("expected network config")
	}
	if result.Network.Proxy != nil {
		t.Fatal("expected no proxy when not set by enterprise")
	}
	if len(result.Network.CustomCaCerts) != 2 {
		t.Fatalf("expected 2 CA certs, got %d", len(result.Network.CustomCaCerts))
	}
}

func TestEnforceEnterprise_StoresEnterprise(t *testing.T) {
	cfg := DefaultConfig()
	enterprise := &types.EnterpriseConfig{
		AllowedModels: []string{"claude-sonnet-4-6"},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if result.Enterprise == nil {
		t.Fatal("expected enterprise config to be stored")
	}
	if len(result.Enterprise.AllowedModels) != 1 {
		t.Fatal("enterprise config not stored correctly")
	}
}

func TestEnforceEnterprise_DoesNotMutateInput(t *testing.T) {
	cfg := DefaultConfig()
	cfg.McpServers = map[string]types.McpServerConfig{
		"keep": {Type: "stdio"},
		"drop": {Type: "stdio"},
	}

	enterprise := &types.EnterpriseConfig{
		McpDenylist: []string{"drop"},
	}

	EnforceEnterprise(cfg, enterprise)

	// Original config should not be mutated
	if _, ok := cfg.McpServers["drop"]; !ok {
		t.Fatal("original config was mutated by EnforceEnterprise")
	}
}

func TestEnforceEnterprise_EmptyEnterprise(t *testing.T) {
	cfg := DefaultConfig()
	cfg.DefaultModel = "my-model"
	cfg.McpServers["srv"] = types.McpServerConfig{Type: "stdio"}

	enterprise := &types.EnterpriseConfig{}

	result := EnforceEnterprise(cfg, enterprise)
	// Nothing should change with empty enterprise
	if result.DefaultModel != "my-model" {
		t.Fatalf("expected my-model preserved, got %q", result.DefaultModel)
	}
	if _, ok := result.McpServers["srv"]; !ok {
		t.Fatal("expected MCP server preserved")
	}
}

func TestEnforceEnterprise_McpDenylistMultiple(t *testing.T) {
	cfg := DefaultConfig()
	cfg.McpServers = map[string]types.McpServerConfig{
		"a": {Type: "stdio"},
		"b": {Type: "stdio"},
		"c": {Type: "stdio"},
	}

	enterprise := &types.EnterpriseConfig{
		McpDenylist: []string{"a", "c"},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if len(result.McpServers) != 1 {
		t.Fatalf("expected 1 server, got %d", len(result.McpServers))
	}
	if _, ok := result.McpServers["b"]; !ok {
		t.Fatal("server 'b' should remain")
	}
}

func TestEnforceEnterprise_McpDenylistNonexistent(t *testing.T) {
	cfg := DefaultConfig()
	cfg.McpServers = map[string]types.McpServerConfig{
		"keep": {Type: "stdio"},
	}

	enterprise := &types.EnterpriseConfig{
		McpDenylist: []string{"nonexistent"},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if len(result.McpServers) != 1 {
		t.Fatalf("expected 1 server, got %d", len(result.McpServers))
	}
}

func TestEnforceEnterprise_McpAllowlistEmpty(t *testing.T) {
	cfg := DefaultConfig()
	cfg.McpServers = map[string]types.McpServerConfig{
		"srv": {Type: "stdio"},
	}

	enterprise := &types.EnterpriseConfig{
		McpAllowlist: []string{},
	}

	result := EnforceEnterprise(cfg, enterprise)
	// Empty allowlist means no filtering (len == 0 check)
	if _, ok := result.McpServers["srv"]; !ok {
		t.Fatal("empty allowlist should not filter servers")
	}
}

func TestEnforceEnterprise_SandboxEnforcement(t *testing.T) {
	cfg := DefaultConfig()
	enterprise := &types.EnterpriseConfig{
		Sandbox: &types.SandboxEnterpriseConfig{
			Required:     true,
			AllowDisable: false,
			AdditionalDenyPaths: []string{"/secret"},
		},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if result.Enterprise == nil || result.Enterprise.Sandbox == nil {
		t.Fatal("expected sandbox enterprise config stored")
	}
	if !result.Enterprise.Sandbox.Required {
		t.Fatal("expected sandbox required")
	}
	if result.Enterprise.Sandbox.AllowDisable {
		t.Fatal("expected AllowDisable=false")
	}
}

func TestEnforceEnterprise_ToolRestrictions(t *testing.T) {
	cfg := DefaultConfig()
	enterprise := &types.EnterpriseConfig{
		ToolRestrictions: &types.ToolRestrictions{
			Deny:  []string{"Bash"},
			Allow: []string{"Read", "Write"},
		},
	}

	result := EnforceEnterprise(cfg, enterprise)
	if result.Enterprise == nil || result.Enterprise.ToolRestrictions == nil {
		t.Fatal("expected tool restrictions stored")
	}
	if len(result.Enterprise.ToolRestrictions.Deny) != 1 {
		t.Fatal("expected 1 denied tool")
	}
}

// ---------------------------------------------------------------------------
// IsModelAllowed
// ---------------------------------------------------------------------------

func TestIsModelAllowed(t *testing.T) {
	tests := []struct {
		name       string
		model      string
		enterprise *types.EnterpriseConfig
		want       bool
	}{
		{"nil enterprise", "any-model", nil, true},
		{"allowed", "claude-sonnet-4-6", &types.EnterpriseConfig{AllowedModels: []string{"claude-sonnet-4-6"}}, true},
		{"not allowed", "gpt-4", &types.EnterpriseConfig{AllowedModels: []string{"claude-sonnet-4-6"}}, false},
		{"blocked", "gpt-4", &types.EnterpriseConfig{BlockedModels: []string{"gpt-4"}}, false},
		{"not blocked", "claude-sonnet-4-6", &types.EnterpriseConfig{BlockedModels: []string{"gpt-4"}}, true},
		{"empty lists", "any-model", &types.EnterpriseConfig{}, true},
		{"blocked takes priority over allowed", "bad", &types.EnterpriseConfig{AllowedModels: []string{"bad"}, BlockedModels: []string{"bad"}}, false},
		{"multiple allowed models", "model-b", &types.EnterpriseConfig{AllowedModels: []string{"model-a", "model-b", "model-c"}}, true},
		{"multiple blocked models", "model-b", &types.EnterpriseConfig{BlockedModels: []string{"model-a", "model-b", "model-c"}}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsModelAllowed(tt.model, tt.enterprise)
			if got != tt.want {
				t.Errorf("IsModelAllowed(%q) = %v, want %v", tt.model, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// IsToolAllowed
// ---------------------------------------------------------------------------

func TestIsToolAllowed(t *testing.T) {
	tests := []struct {
		name       string
		tool       string
		enterprise *types.EnterpriseConfig
		want       bool
	}{
		{"nil enterprise", "bash", nil, true},
		{"no restrictions", "bash", &types.EnterpriseConfig{}, true},
		{"denied", "bash", &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{Deny: []string{"bash"}}}, false},
		{"not denied", "read", &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{Deny: []string{"bash"}}}, true},
		{"allowed", "read", &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{Allow: []string{"read", "write"}}}, true},
		{"not in allow", "bash", &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{Allow: []string{"read", "write"}}}, false},
		{"empty allow list", "bash", &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{Allow: []string{}}}, true},
		{"empty deny list", "bash", &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{Deny: []string{}}}, true},
		{"deny takes priority", "bash", &types.EnterpriseConfig{ToolRestrictions: &types.ToolRestrictions{Allow: []string{"bash"}, Deny: []string{"bash"}}}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsToolAllowed(tt.tool, tt.enterprise)
			if got != tt.want {
				t.Errorf("IsToolAllowed(%q) = %v, want %v", tt.tool, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// IsMcpAllowed
// ---------------------------------------------------------------------------

func TestIsMcpAllowed(t *testing.T) {
	tests := []struct {
		name       string
		server     string
		enterprise *types.EnterpriseConfig
		want       bool
	}{
		{"nil enterprise", "any", nil, true},
		{"denied", "bad", &types.EnterpriseConfig{McpDenylist: []string{"bad"}}, false},
		{"not denied", "good", &types.EnterpriseConfig{McpDenylist: []string{"bad"}}, true},
		{"allowlisted", "good", &types.EnterpriseConfig{McpAllowlist: []string{"good"}}, true},
		{"not allowlisted", "other", &types.EnterpriseConfig{McpAllowlist: []string{"good"}}, false},
		{"empty enterprise", "any", &types.EnterpriseConfig{}, true},
		{"deny takes priority over allow", "srv", &types.EnterpriseConfig{McpAllowlist: []string{"srv"}, McpDenylist: []string{"srv"}}, false},
		{"multiple allowlisted", "b", &types.EnterpriseConfig{McpAllowlist: []string{"a", "b", "c"}}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsMcpAllowed(tt.server, tt.enterprise)
			if got != tt.want {
				t.Errorf("IsMcpAllowed(%q) = %v, want %v", tt.server, got, tt.want)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Config Loading (file-based)
// ---------------------------------------------------------------------------

func TestLoadConfig_WithFiles(t *testing.T) {
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}

	projectCfg := map[string]any{
		"defaultModel": "claude-opus-4",
		"limits": map[string]any{
			"maxTurns": 200,
		},
	}
	data, _ := json.Marshal(projectCfg)
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	if cfg.DefaultModel != "claude-opus-4" {
		t.Fatalf("expected defaultModel=claude-opus-4, got %q", cfg.DefaultModel)
	}
	if cfg.Limits.MaxTurns == nil || *cfg.Limits.MaxTurns != 200 {
		t.Fatalf("expected maxTurns=200, got %v", cfg.Limits.MaxTurns)
	}
	// Defaults should still apply for non-overridden fields
	if cfg.Backend != "api" {
		t.Fatalf("expected backend=api, got %q", cfg.Backend)
	}
}

func TestLoadConfig_NoProjectDir(t *testing.T) {
	cfg := LoadConfig("")
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.Backend != "api" {
		t.Fatalf("expected default backend=api, got %q", cfg.Backend)
	}
}

func TestLoadConfig_MissingProjectDir(t *testing.T) {
	cfg := LoadConfig("/nonexistent/path/that/does/not/exist")
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.Backend != "api" {
		t.Fatalf("expected default backend=api, got %q", cfg.Backend)
	}
}

func TestLoadConfig_MalformedJSON(t *testing.T) {
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), []byte("{not valid json!!!"), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	// Should return defaults when JSON is malformed
	if cfg.Backend != "api" {
		t.Fatalf("expected default backend=api, got %q", cfg.Backend)
	}
	if cfg.DefaultModel != "claude-sonnet-4-6" {
		t.Fatalf("expected default model, got %q", cfg.DefaultModel)
	}
	if cfg.Limits.MaxTurns == nil || *cfg.Limits.MaxTurns != 50 {
		t.Fatalf("expected default maxTurns=50, got %v", cfg.Limits.MaxTurns)
	}
}

func TestLoadConfig_PartialOverride(t *testing.T) {
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Only override maxTurns
	data, _ := json.Marshal(map[string]any{
		"limits": map[string]any{"maxTurns": 5},
	})
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	if cfg.Limits.MaxTurns == nil || *cfg.Limits.MaxTurns != 5 {
		t.Fatalf("expected maxTurns=5, got %v", cfg.Limits.MaxTurns)
	}
	if cfg.Limits.MaxBudgetUsd == nil || *cfg.Limits.MaxBudgetUsd != 10 {
		t.Fatalf("expected maxBudgetUsd=10, got %v", cfg.Limits.MaxBudgetUsd)
	}
	if cfg.Limits.IdleTimeoutMs == nil || *cfg.Limits.IdleTimeoutMs != 300000 {
		t.Fatalf("expected idleTimeoutMs=300000, got %v", cfg.Limits.IdleTimeoutMs)
	}
	if cfg.Backend != "api" {
		t.Fatalf("expected backend=api, got %q", cfg.Backend)
	}
}

func TestLoadConfig_WithBackendAndModel(t *testing.T) {
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{
		"backend":      "cli",
		"defaultModel": "claude-opus-4-6",
	})
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	if cfg.Backend != "cli" {
		t.Fatalf("expected backend=cli, got %q", cfg.Backend)
	}
	if cfg.DefaultModel != "claude-opus-4-6" {
		t.Fatalf("expected defaultModel=claude-opus-4-6, got %q", cfg.DefaultModel)
	}
}

func TestLoadConfig_EmptyJSON(t *testing.T) {
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	// Empty JSON should result in defaults
	if cfg.Backend != "api" {
		t.Fatalf("expected backend=api, got %q", cfg.Backend)
	}
	if cfg.DefaultModel != "claude-sonnet-4-6" {
		t.Fatalf("expected default model, got %q", cfg.DefaultModel)
	}
}

func TestLoadConfig_McpServers(t *testing.T) {
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			"test-server": map[string]any{
				"type":    "stdio",
				"command": "test-cmd",
				"args":    []string{"--flag"},
			},
		},
	})
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	srv, ok := cfg.McpServers["test-server"]
	if !ok {
		t.Fatal("expected test-server in MCP servers")
	}
	if srv.Type != "stdio" {
		t.Fatalf("expected type=stdio, got %q", srv.Type)
	}
	if srv.Command != "test-cmd" {
		t.Fatalf("expected command=test-cmd, got %q", srv.Command)
	}
	if len(srv.Args) != 1 || srv.Args[0] != "--flag" {
		t.Fatalf("expected args=[--flag], got %v", srv.Args)
	}
}

func TestLoadConfig_Providers(t *testing.T) {
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{
		"providers": map[string]any{
			"anthropic": map[string]any{
				"baseURL": "https://custom.api.com",
			},
		},
	})
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	if cfg.Providers["anthropic"].BaseURL != "https://custom.api.com" {
		t.Fatalf("expected custom baseURL, got %q", cfg.Providers["anthropic"].BaseURL)
	}
}

// ---------------------------------------------------------------------------
// Enterprise config loading
// ---------------------------------------------------------------------------

func TestLoadEnterpriseConfig_EnvVar(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "enterprise.json")

	enterprise := types.EnterpriseConfig{
		AllowedModels: []string{"claude-sonnet-4-6"},
		BlockedModels: []string{"gpt-4"},
	}
	data, _ := json.Marshal(enterprise)
	if err := os.WriteFile(cfgPath, data, 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("ION_ENTERPRISE_CONFIG", cfgPath)

	cfg := LoadEnterpriseConfig()
	if cfg == nil {
		t.Fatal("expected enterprise config from env var")
	}
	if len(cfg.AllowedModels) != 1 || cfg.AllowedModels[0] != "claude-sonnet-4-6" {
		t.Fatalf("unexpected allowedModels: %v", cfg.AllowedModels)
	}
}

func TestLoadEnterpriseConfig_MissingEnvVar(t *testing.T) {
	t.Setenv("ION_ENTERPRISE_CONFIG", "/nonexistent/path.json")

	cfg := loadEnterpriseConfig("unsupported")
	if cfg != nil {
		t.Fatal("expected nil for unsupported platform with missing env var")
	}
}

func TestLoadEnterpriseConfig_UnsupportedPlatform(t *testing.T) {
	// No env var set -- unset it to be sure
	t.Setenv("ION_ENTERPRISE_CONFIG", "")
	cfg := loadEnterpriseConfig("freebsd")
	if cfg != nil {
		t.Fatal("expected nil for unsupported platform")
	}
}

func TestLoadEnterpriseConfig_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(cfgPath, []byte("{not valid json"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", cfgPath)

	cfg := loadEnterpriseConfig("unsupported")
	if cfg != nil {
		t.Fatal("expected nil for invalid JSON enterprise config")
	}
}

func TestLoadEnterpriseConfig_EnvVarPriorityOverPlatform(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "env-priority.json")
	enterprise := types.EnterpriseConfig{
		AllowedModels: []string{"from-env"},
	}
	data, _ := json.Marshal(enterprise)
	if err := os.WriteFile(cfgPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", cfgPath)

	// Even on unsupported platform, env var should work
	cfg := loadEnterpriseConfig("unsupported")
	if cfg == nil {
		t.Fatal("expected config from env var")
	}
	if len(cfg.AllowedModels) != 1 || cfg.AllowedModels[0] != "from-env" {
		t.Fatalf("expected from-env, got %v", cfg.AllowedModels)
	}
}

func TestLoadEnterpriseConfig_FullConfig(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "full-enterprise.json")

	enterprise := types.EnterpriseConfig{
		AllowedModels:    []string{"claude-sonnet-4-6"},
		BlockedModels:    []string{"gpt-4"},
		AllowedProviders: []string{"anthropic"},
		McpAllowlist:     []string{"safe-server"},
		McpDenylist:      []string{"bad-server"},
		ToolRestrictions: &types.ToolRestrictions{
			Allow: []string{"Read", "Write"},
			Deny:  []string{"Bash"},
		},
		Telemetry: &types.TelemetryConfig{
			Enabled:      true,
			Targets:      []string{"https://telemetry.corp"},
			PrivacyLevel: "full",
		},
		Network: &types.NetworkConfig{
			Proxy: &types.ProxyConfig{
				HttpsProxy: "http://proxy:8080",
			},
			CustomCaCerts: []string{"/ca.pem"},
		},
	}
	data, _ := json.Marshal(enterprise)
	if err := os.WriteFile(cfgPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", cfgPath)

	cfg := LoadEnterpriseConfig()
	if cfg == nil {
		t.Fatal("expected full enterprise config")
	}
	if len(cfg.AllowedModels) != 1 {
		t.Fatal("expected 1 allowed model")
	}
	if len(cfg.BlockedModels) != 1 {
		t.Fatal("expected 1 blocked model")
	}
	if len(cfg.AllowedProviders) != 1 {
		t.Fatal("expected 1 allowed provider")
	}
	if cfg.ToolRestrictions == nil {
		t.Fatal("expected tool restrictions")
	}
	if cfg.Telemetry == nil || !cfg.Telemetry.Enabled {
		t.Fatal("expected telemetry enabled")
	}
	if cfg.Network == nil || cfg.Network.Proxy == nil {
		t.Fatal("expected network config with proxy")
	}
}

func TestLoadEnterpriseConfig_EmptyJSON(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "empty-enterprise.json")
	if err := os.WriteFile(cfgPath, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", cfgPath)

	cfg := LoadEnterpriseConfig()
	if cfg == nil {
		t.Fatal("expected non-nil config for empty JSON")
	}
	if len(cfg.AllowedModels) != 0 {
		t.Fatal("expected no allowed models")
	}
}

// ---------------------------------------------------------------------------
// Environment variable provider resolution
// ---------------------------------------------------------------------------

func TestResolveEnvProviders_AnthropicKey(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-test-key")

	cfg := make(map[string]any)
	resolveEnvProviders(cfg)

	providers, ok := cfg["providers"].(map[string]any)
	if !ok {
		t.Fatal("expected providers map")
	}
	anthropic, ok := providers["anthropic"].(map[string]any)
	if !ok {
		t.Fatal("expected anthropic provider")
	}
	if anthropic["apiKey"] != "sk-ant-test-key" {
		t.Fatalf("expected sk-ant-test-key, got %v", anthropic["apiKey"])
	}
}

func TestResolveEnvProviders_OpenAIKey(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "sk-oai-test-key")

	cfg := make(map[string]any)
	resolveEnvProviders(cfg)

	providers, ok := cfg["providers"].(map[string]any)
	if !ok {
		t.Fatal("expected providers map")
	}
	openai, ok := providers["openai"].(map[string]any)
	if !ok {
		t.Fatal("expected openai provider")
	}
	if openai["apiKey"] != "sk-oai-test-key" {
		t.Fatalf("expected sk-oai-test-key, got %v", openai["apiKey"])
	}
}

func TestResolveEnvProviders_DoesNotOverrideExistingKey(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "env-key")

	cfg := map[string]any{
		"providers": map[string]any{
			"anthropic": map[string]any{
				"apiKey": "config-key",
			},
		},
	}
	resolveEnvProviders(cfg)

	providers := cfg["providers"].(map[string]any)
	anthropic := providers["anthropic"].(map[string]any)
	if anthropic["apiKey"] != "config-key" {
		t.Fatalf("expected config-key to be preserved, got %v", anthropic["apiKey"])
	}
}

func TestResolveEnvProviders_NilConfig(t *testing.T) {
	// Should not panic
	resolveEnvProviders(nil)
}

func TestResolveEnvProviders_NoEnvVars(t *testing.T) {
	// Unset both
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	os.Unsetenv("ANTHROPIC_API_KEY")
	os.Unsetenv("OPENAI_API_KEY")

	cfg := make(map[string]any)
	resolveEnvProviders(cfg)

	providers, _ := cfg["providers"].(map[string]any)
	if providers == nil {
		t.Fatal("expected providers map to exist")
	}
	// No anthropic or openai should be added
	if _, ok := providers["anthropic"]; ok {
		t.Fatal("did not expect anthropic provider without env var")
	}
	if _, ok := providers["openai"]; ok {
		t.Fatal("did not expect openai provider without env var")
	}
}

// ---------------------------------------------------------------------------
// fromMap
// ---------------------------------------------------------------------------

func TestFromMap_NilInput(t *testing.T) {
	result := fromMap(nil)
	if result != nil {
		t.Fatal("expected nil for nil input")
	}
}

func TestFromMap_ValidInput(t *testing.T) {
	m := map[string]any{
		"backend":      "cli",
		"defaultModel": "test-model",
		"limits": map[string]any{
			"maxTurns": float64(100),
		},
	}
	result := fromMap(m)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.Backend != "cli" {
		t.Fatalf("expected backend=cli, got %q", result.Backend)
	}
	if result.DefaultModel != "test-model" {
		t.Fatalf("expected test-model, got %q", result.DefaultModel)
	}
	if result.Limits.MaxTurns == nil || *result.Limits.MaxTurns != 100 {
		t.Fatalf("expected maxTurns=100, got %v", result.Limits.MaxTurns)
	}
}

func TestFromMap_EmptyMap(t *testing.T) {
	result := fromMap(map[string]any{})
	if result == nil {
		t.Fatal("expected non-nil result for empty map")
	}
}

func TestFromMap_UnknownFieldsIgnored(t *testing.T) {
	m := map[string]any{
		"backend":      "api",
		"unknownField": "should be ignored",
	}
	result := fromMap(m)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.Backend != "api" {
		t.Fatalf("expected backend=api, got %q", result.Backend)
	}
}

// ---------------------------------------------------------------------------
// loadJSONConfig
// ---------------------------------------------------------------------------

func TestLoadJSONConfig_MissingFile(t *testing.T) {
	result := loadJSONConfig("/nonexistent/path/config.json")
	if result != nil {
		t.Fatal("expected nil for missing file")
	}
}

func TestLoadJSONConfig_ValidFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data, _ := json.Marshal(map[string]any{"key": "value"})
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}

	result := loadJSONConfig(path)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result["key"] != "value" {
		t.Fatalf("expected key=value, got %v", result["key"])
	}
}

func TestLoadJSONConfig_MalformedFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(path, []byte("{invalid json}"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := loadJSONConfig(path)
	if result != nil {
		t.Fatal("expected nil for malformed JSON")
	}
}

func TestLoadJSONConfig_EmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.json")
	if err := os.WriteFile(path, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}

	result := loadJSONConfig(path)
	if result != nil {
		t.Fatal("expected nil for empty file")
	}
}

// ---------------------------------------------------------------------------
// mergeEnterprisePartial
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

func TestReadJSONFile_Valid(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")
	enterprise := types.EnterpriseConfig{AllowedModels: []string{"test"}}
	data, _ := json.Marshal(enterprise)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}

	result := readJSONFile[types.EnterpriseConfig](path)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.AllowedModels) != 1 {
		t.Fatal("expected 1 allowed model")
	}
}

func TestReadJSONFile_MissingFile(t *testing.T) {
	result := readJSONFile[types.EnterpriseConfig]("/nonexistent.json")
	if result != nil {
		t.Fatal("expected nil for missing file")
	}
}

func TestReadJSONFile_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(path, []byte("{bad}"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := readJSONFile[types.EnterpriseConfig](path)
	if result != nil {
		t.Fatal("expected nil for invalid JSON")
	}
}

// ---------------------------------------------------------------------------
// contains helper
// ---------------------------------------------------------------------------

func TestContains(t *testing.T) {
	tests := []struct {
		name  string
		slice []string
		item  string
		want  bool
	}{
		{"found", []string{"a", "b", "c"}, "b", true},
		{"not found", []string{"a", "b", "c"}, "d", false},
		{"empty slice", []string{}, "a", false},
		{"nil slice", nil, "a", false},
		{"single match", []string{"x"}, "x", true},
		{"single no match", []string{"x"}, "y", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := contains(tt.slice, tt.item); got != tt.want {
				t.Errorf("contains(%v, %q) = %v, want %v", tt.slice, tt.item, got, tt.want)
			}
		})
	}
}
