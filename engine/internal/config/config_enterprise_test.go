package config

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// Defaults
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
			Required:            true,
			AllowDisable:        false,
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
// NewConversationDefaults merge
// ---------------------------------------------------------------------------

// TestMergeEnterprisePartial_NewConversationDefaults verifies that the drop-in merge
// carries a non-nil NewConversationDefaults pointer from the overlay onto the result
// (whole-pointer replacement, matching the Sandbox/Network/Telemetry pattern).
func TestMergeEnterprisePartial_NewConversationDefaults(t *testing.T) {
	base := &types.EnterpriseConfig{
		AllowedModels: []string{"claude-sonnet-4-6"},
	}
	overlay := &types.EnterpriseConfig{
		NewConversationDefaults: &types.NewConversationDefaultsPolicy{
			BaseDirectory:   "/corp/projects",
			EngineProfileId: "profile-corp",
			Locked:          true,
		},
	}

	result := mergeEnterprisePartial(base, overlay)

	if result.NewConversationDefaults == nil {
		t.Fatal("expected NewConversationDefaults to be set from overlay")
	}
	if result.NewConversationDefaults.BaseDirectory != "/corp/projects" {
		t.Errorf("expected BaseDirectory=/corp/projects, got %q", result.NewConversationDefaults.BaseDirectory)
	}
	if result.NewConversationDefaults.EngineProfileId != "profile-corp" {
		t.Errorf("expected EngineProfileId=profile-corp, got %q", result.NewConversationDefaults.EngineProfileId)
	}
	if !result.NewConversationDefaults.Locked {
		t.Error("expected Locked=true")
	}
	// Base AllowedModels must be preserved (unrelated field)
	if len(result.AllowedModels) != 1 || result.AllowedModels[0] != "claude-sonnet-4-6" {
		t.Errorf("AllowedModels not preserved: %v", result.AllowedModels)
	}
}

// TestMergeEnterprisePartial_NewConversationDefaults_NilOverlayPreservesBase verifies
// that a nil NewConversationDefaults in the overlay does not wipe a non-nil base value
// (the "overlay wins only when set" semantics of every pointer field).
func TestMergeEnterprisePartial_NewConversationDefaults_NilOverlayPreservesBase(t *testing.T) {
	base := &types.EnterpriseConfig{
		NewConversationDefaults: &types.NewConversationDefaultsPolicy{
			BaseDirectory: "/base/dir",
			Locked:        false,
		},
	}
	// Overlay does not set NewConversationDefaults
	overlay := &types.EnterpriseConfig{
		AllowedModels: []string{"claude-opus-4"},
	}

	result := mergeEnterprisePartial(base, overlay)

	if result.NewConversationDefaults == nil {
		t.Fatal("expected NewConversationDefaults to be preserved from base when overlay is nil")
	}
	if result.NewConversationDefaults.BaseDirectory != "/base/dir" {
		t.Errorf("expected preserved BaseDirectory=/base/dir, got %q", result.NewConversationDefaults.BaseDirectory)
	}
}

// TestMergeEnterprisePartial_NewConversationDefaults_PlainConversation verifies that
// an empty EngineProfileId (the "plain conversation" sentinel) is round-tripped
// correctly through the merge (empty string is not omitted by omitempty when
// the struct pointer is non-nil).
func TestMergeEnterprisePartial_NewConversationDefaults_PlainConversation(t *testing.T) {
	base := &types.EnterpriseConfig{}
	overlay := &types.EnterpriseConfig{
		NewConversationDefaults: &types.NewConversationDefaultsPolicy{
			BaseDirectory:   "/work",
			EngineProfileId: "", // explicit plain conversation
		},
	}

	result := mergeEnterprisePartial(base, overlay)

	if result.NewConversationDefaults == nil {
		t.Fatal("expected NewConversationDefaults from overlay")
	}
	if result.NewConversationDefaults.EngineProfileId != "" {
		t.Errorf("expected empty EngineProfileId (plain conversation), got %q", result.NewConversationDefaults.EngineProfileId)
	}
	if result.NewConversationDefaults.BaseDirectory != "/work" {
		t.Errorf("expected BaseDirectory=/work, got %q", result.NewConversationDefaults.BaseDirectory)
	}
}

// ---------------------------------------------------------------------------
// Config Loading (file-based)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Logging egress enterprise seal (C2)
// ---------------------------------------------------------------------------

// TestEnforceEnterprise_LoggingEgressForced verifies that when enterprise
// config sets Logging.EgressTargets, the targets are forced onto the result
// (C2 enterprise-seal requirement).
func TestEnforceEnterprise_LoggingEgressForced(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Logging = &types.LoggingConfig{Format: "json"}

	enterprise := &types.EnterpriseConfig{
		Logging: &types.LoggingConfig{
			EgressTargets:  []string{"http"},
			EgressEndpoint: "https://logs.corp.example/ingest",
			EgressHeaders:  map[string]string{"Authorization": "Bearer corp-token"},
		},
	}

	result := EnforceEnterprise(cfg, enterprise)

	if result.Logging == nil {
		t.Fatal("expected Logging block on result")
	}
	if len(result.Logging.EgressTargets) != 1 || result.Logging.EgressTargets[0] != "http" {
		t.Errorf("EgressTargets = %v, want [http]", result.Logging.EgressTargets)
	}
	if result.Logging.EgressEndpoint != "https://logs.corp.example/ingest" {
		t.Errorf("EgressEndpoint = %q, want corp endpoint", result.Logging.EgressEndpoint)
	}
	if result.Logging.EgressHeaders["Authorization"] != "Bearer corp-token" {
		t.Errorf("EgressHeaders missing Authorization")
	}
	// Non-egress user field (Format) must be preserved.
	if result.Logging.Format != "json" {
		t.Errorf("user Format should be preserved, got %q", result.Logging.Format)
	}
}

// TestEnforceEnterprise_LoggingEgressForcedOnNilLogging verifies that when the
// user has no Logging block, EnforceEnterprise creates one.
func TestEnforceEnterprise_LoggingEgressForcedOnNilLogging(t *testing.T) {
	cfg := DefaultConfig()

	enterprise := &types.EnterpriseConfig{
		Logging: &types.LoggingConfig{
			EgressTargets:  []string{"otel"},
			EgressEndpoint: "https://otel.corp.example",
		},
	}

	result := EnforceEnterprise(cfg, enterprise)

	if result.Logging == nil {
		t.Fatal("expected Logging block to be created by enterprise enforcement")
	}
	if len(result.Logging.EgressTargets) != 1 || result.Logging.EgressTargets[0] != "otel" {
		t.Errorf("EgressTargets = %v, want [otel]", result.Logging.EgressTargets)
	}
}

// TestEnforceEnterprise_LoggingNoEnforcementWhenEnterpriseNil verifies that
// when enterprise.Logging is nil, user logging config is not modified.
func TestEnforceEnterprise_LoggingNoEnforcementWhenEnterpriseNil(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Logging = &types.LoggingConfig{Format: "json"}

	enterprise := &types.EnterpriseConfig{}

	result := EnforceEnterprise(cfg, enterprise)

	if result.Logging == nil {
		t.Fatal("expected Logging to be preserved")
	}
	if result.Logging.Format != "json" {
		t.Errorf("user Format changed unexpectedly: %q", result.Logging.Format)
	}
	if len(result.Logging.EgressTargets) != 0 {
		t.Errorf("unexpected EgressTargets: %v", result.Logging.EgressTargets)
	}
}

// TestEnforceEnterprise_ShipSourcesMatrix verifies the shipping-
// responsibility matrix sealing: enterprise MAY seal EgressShipSources and
// EgressTokenScope; when silent, an explicit lower-layer assignment stands
// (the don't-clobber principle shared with EgressManagedByClient).
func TestEnforceEnterprise_ShipSourcesMatrix(t *testing.T) {
	// Enterprise silent → lower-layer matrix preserved.
	cfg := DefaultConfig()
	cfg.Logging = &types.LoggingConfig{
		EgressShipSources: []string{"engine", "desktop"},
		EgressTokenScope:  "api://app/Telemetry.Write",
	}
	enterprise := &types.EnterpriseConfig{
		Logging: &types.LoggingConfig{
			EgressTargets:  []string{"http"},
			EgressEndpoint: "https://logs.corp.example/ingest",
		},
	}
	result := EnforceEnterprise(cfg, enterprise)
	if len(result.Logging.EgressShipSources) != 2 {
		t.Errorf("silent enterprise must preserve lower-layer matrix, got %v", result.Logging.EgressShipSources)
	}
	if result.Logging.EgressTokenScope != "api://app/Telemetry.Write" {
		t.Errorf("silent enterprise must preserve lower-layer token scope, got %q", result.Logging.EgressTokenScope)
	}

	// Enterprise explicit → matrix and scope sealed.
	cfg2 := DefaultConfig()
	cfg2.Logging = &types.LoggingConfig{EgressShipSources: []string{"engine"}}
	enterprise2 := &types.EnterpriseConfig{
		Logging: &types.LoggingConfig{
			EgressTargets:     []string{"http"},
			EgressEndpoint:    "https://logs.corp.example/ingest",
			EgressShipSources: []string{"engine", "desktop", "ios", "telemetry"},
			EgressTokenScope:  "api://corp/Telemetry.Write",
		},
	}
	result2 := EnforceEnterprise(cfg2, enterprise2)
	if len(result2.Logging.EgressShipSources) != 4 {
		t.Errorf("enterprise matrix must seal, got %v", result2.Logging.EgressShipSources)
	}
	if result2.Logging.EgressTokenScope != "api://corp/Telemetry.Write" {
		t.Errorf("enterprise token scope must seal, got %q", result2.Logging.EgressTokenScope)
	}
}

func TestEnforceEnterprise_PluginAllowlist(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Plugins = &types.PluginsConfig{
		Allowlist: []string{"user-allowed/*"},
		ForceInstalled: []string{"user-allowed/tool"},
	}
	enterprise := &types.EnterpriseConfig{
		PluginAllowlist: []string{"corp-approved/*"},
	}
	result := EnforceEnterprise(cfg, enterprise)
	if len(result.Plugins.Allowlist) != 1 || result.Plugins.Allowlist[0] != "corp-approved/*" {
		t.Errorf("enterprise allowlist should seal user allowlist, got %v", result.Plugins.Allowlist)
	}
}

func TestEnforceEnterprise_PluginDenylist_Additive(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Plugins = &types.PluginsConfig{
		Denylist: []string{"bad/plugin"},
	}
	enterprise := &types.EnterpriseConfig{
		PluginDenylist: []string{"evil/*"},
	}
	result := EnforceEnterprise(cfg, enterprise)
	if len(result.Plugins.Denylist) != 2 {
		t.Errorf("enterprise denylist should be additive with user denylist, got %v", result.Plugins.Denylist)
	}
}

func TestEnforceEnterprise_PluginForceInstalled_Union(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Plugins = &types.PluginsConfig{
		ForceInstalled: []string{"user/plugin-a"},
	}
	enterprise := &types.EnterpriseConfig{
		PluginForceInstalled: []string{"corp/plugin-b"},
	}
	result := EnforceEnterprise(cfg, enterprise)
	if len(result.Plugins.ForceInstalled) != 2 {
		t.Errorf("force-install lists should be unioned, got %v", result.Plugins.ForceInstalled)
	}
}

func TestEnforceEnterprise_PluginForceInstalled_NoDuplicates(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Plugins = &types.PluginsConfig{
		ForceInstalled: []string{"user/plugin-a", "user/plugin-b"},
	}
	enterprise := &types.EnterpriseConfig{
		PluginForceInstalled: []string{"user/plugin-a", "corp/plugin-c"},
	}
	result := EnforceEnterprise(cfg, enterprise)
	// "user/plugin-a" appears in both — should only be in the result once.
	if len(result.Plugins.ForceInstalled) != 3 {
		t.Errorf("duplicates should be de-duped in union, got %v", result.Plugins.ForceInstalled)
	}
}

func TestEnforceEnterprise_PluginNoEnterprise(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Plugins = &types.PluginsConfig{
		Allowlist: []string{"user-allowed/*"},
	}
	// No enterprise config — user settings must be preserved unchanged.
	enterprise := &types.EnterpriseConfig{}
	result := EnforceEnterprise(cfg, enterprise)
	if len(result.Plugins.Allowlist) != 1 || result.Plugins.Allowlist[0] != "user-allowed/*" {
		t.Errorf("empty enterprise should preserve user allowlist, got %v", result.Plugins.Allowlist)
	}
}
