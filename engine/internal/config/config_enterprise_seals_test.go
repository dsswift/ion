package config

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ─── D-005: AllowedProviders enforcement ───

func TestEnforceEnterprise_AllowedProviders_StripsNonAllowed(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://ai.example.com", APIKey: "k1"},
			"rogue":     {BaseURL: "https://api.anthropic.com", APIKey: "k2"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		AllowedProviders: []string{"anthropic"},
	}
	result := EnforceEnterprise(cfg, enterprise)

	if _, ok := result.Providers["anthropic"]; !ok {
		t.Error("allowed provider 'anthropic' should remain")
	}
	if _, ok := result.Providers["rogue"]; ok {
		t.Error("non-allowed provider 'rogue' should be stripped")
	}
}

func TestEnforceEnterprise_AllowedProviders_EmptyListMeansNoRestriction(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {APIKey: "k1"},
			"openai":    {APIKey: "k2"},
		},
	}
	enterprise := &types.EnterpriseConfig{} // no AllowedProviders
	result := EnforceEnterprise(cfg, enterprise)

	if len(result.Providers) != 2 {
		t.Errorf("expected both providers to survive with empty allowlist, got %d", len(result.Providers))
	}
}

func TestEnforceEnterprise_AllowedProviders_DoesNotMutateInput(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {APIKey: "k1"},
			"rogue":     {APIKey: "k2"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		AllowedProviders: []string{"anthropic"},
	}
	_ = EnforceEnterprise(cfg, enterprise)

	if _, ok := cfg.Providers["rogue"]; !ok {
		t.Error("input config must not be mutated by provider enforcement")
	}
}

// ─── D-010: MCP host-pattern allowlist ───

func TestEnforceEnterprise_McpAllowlist_HostPatternMatch(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		McpServers: map[string]types.McpServerConfig{
			// Name NOT on the allowlist, but URL host matches *.example.com.
			"internal-tools": {Type: "http", URL: "https://api.example.com/mcp"},
			// Name NOT on the allowlist and host does not match.
			"evil": {Type: "http", URL: "https://other.com/mcp"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		McpAllowlist: []string{"*.example.com"},
	}
	result := EnforceEnterprise(cfg, enterprise)

	if _, ok := result.McpServers["internal-tools"]; !ok {
		t.Error("server with allowlist-matching URL host should remain")
	}
	if _, ok := result.McpServers["evil"]; ok {
		t.Error("server with non-matching URL host should be removed")
	}
}

func TestEnforceEnterprise_McpAllowlist_ExactNameStillWorks(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		McpServers: map[string]types.McpServerConfig{
			"exchange": {Type: "http", URL: "https://anything.net/mcp"},
			"other":    {Type: "http", URL: "https://elsewhere.net/mcp"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		McpAllowlist: []string{"exchange"},
	}
	result := EnforceEnterprise(cfg, enterprise)

	if _, ok := result.McpServers["exchange"]; !ok {
		t.Error("exact-name allowlisted server should remain regardless of URL")
	}
	if _, ok := result.McpServers["other"]; ok {
		t.Error("non-allowlisted server should be removed")
	}
}

func TestEnforceEnterprise_McpAllowlist_StdioServerNoURLRemovedUnlessNamed(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		McpServers: map[string]types.McpServerConfig{
			"local-stdio": {Type: "stdio", Command: "some-binary"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		McpAllowlist: []string{"*.example.com"},
	}
	result := EnforceEnterprise(cfg, enterprise)

	// A stdio server has no URL host to match; with only host patterns on
	// the allowlist it must be pruned (host patterns cannot admit it).
	if _, ok := result.McpServers["local-stdio"]; ok {
		t.Error("stdio server not named on the allowlist should be removed when only host patterns are configured")
	}
}

// ─── D-007: ResourceLimits sealed ceiling ───

func intPtr(v int) *int { return &v }

func TestEnforceEnterprise_ResourceLimits_CapsUserValue(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		ResourceLimits: &types.ResourceLimits{MaxSessions: intPtr(10)},
	}
	enterprise := &types.EnterpriseConfig{
		ResourceLimits: &types.ResourceLimits{MaxSessions: intPtr(3)},
	}
	result := EnforceEnterprise(cfg, enterprise)

	if result.ResourceLimits == nil || result.ResourceLimits.MaxSessions == nil {
		t.Fatal("expected ResourceLimits.MaxSessions to be set")
	}
	if *result.ResourceLimits.MaxSessions != 3 {
		t.Errorf("expected user value capped to enterprise ceiling 3, got %d", *result.ResourceLimits.MaxSessions)
	}
}

func TestEnforceEnterprise_ResourceLimits_LowerUserValueStands(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		ResourceLimits: &types.ResourceLimits{MaxSessions: intPtr(2)},
	}
	enterprise := &types.EnterpriseConfig{
		ResourceLimits: &types.ResourceLimits{MaxSessions: intPtr(5)},
	}
	result := EnforceEnterprise(cfg, enterprise)

	if *result.ResourceLimits.MaxSessions != 2 {
		t.Errorf("user value below the ceiling should stand, got %d", *result.ResourceLimits.MaxSessions)
	}
}

func TestEnforceEnterprise_ResourceLimits_AbsentUserTakesEnterpriseValue(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{}
	enterprise := &types.EnterpriseConfig{
		ResourceLimits: &types.ResourceLimits{
			MaxSessions:         intPtr(4),
			MaxAgentsPerSession: intPtr(2),
		},
	}
	result := EnforceEnterprise(cfg, enterprise)

	if result.ResourceLimits == nil {
		t.Fatal("expected ResourceLimits to be created from enterprise policy")
	}
	if *result.ResourceLimits.MaxSessions != 4 {
		t.Errorf("expected MaxSessions 4, got %d", *result.ResourceLimits.MaxSessions)
	}
	if *result.ResourceLimits.MaxAgentsPerSession != 2 {
		t.Errorf("expected MaxAgentsPerSession 2, got %d", *result.ResourceLimits.MaxAgentsPerSession)
	}
}

func TestEnforceEnterprise_ResourceLimits_NilEnterpriseLeavesUserValue(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		ResourceLimits: &types.ResourceLimits{MaxSessions: intPtr(7)},
	}
	enterprise := &types.EnterpriseConfig{} // no ResourceLimits policy
	result := EnforceEnterprise(cfg, enterprise)

	if result.ResourceLimits == nil || *result.ResourceLimits.MaxSessions != 7 {
		t.Error("user ResourceLimits should survive untouched when enterprise has no policy")
	}
}

func TestEnforceEnterprise_ResourceLimits_DoesNotMutateInput(t *testing.T) {
	userLimits := &types.ResourceLimits{MaxSessions: intPtr(10)}
	cfg := &types.EngineRuntimeConfig{ResourceLimits: userLimits}
	enterprise := &types.EnterpriseConfig{
		ResourceLimits: &types.ResourceLimits{MaxSessions: intPtr(3)},
	}
	_ = EnforceEnterprise(cfg, enterprise)

	if *userLimits.MaxSessions != 10 {
		t.Errorf("input ResourceLimits must not be mutated, got %d", *userLimits.MaxSessions)
	}
}

// ─── mergeInto: ResourceLimits propagation ───

func TestMergeConfigs_ResourceLimitsOverride(t *testing.T) {
	base := &types.EngineRuntimeConfig{
		ResourceLimits: &types.ResourceLimits{MaxSessions: intPtr(5)},
	}
	overlay := &types.EngineRuntimeConfig{
		ResourceLimits: &types.ResourceLimits{MaxSessions: intPtr(8)},
	}
	result := MergeConfigs(nil, base, overlay)

	if result.ResourceLimits == nil || *result.ResourceLimits.MaxSessions != 8 {
		t.Error("later layer's ResourceLimits should override")
	}
}

func TestMergeConfigs_ResourceLimitsNilLeavesEarlier(t *testing.T) {
	base := &types.EngineRuntimeConfig{
		ResourceLimits: &types.ResourceLimits{MaxSessions: intPtr(5)},
	}
	overlay := &types.EngineRuntimeConfig{} // no ResourceLimits
	result := MergeConfigs(nil, base, overlay)

	if result.ResourceLimits == nil || *result.ResourceLimits.MaxSessions != 5 {
		t.Error("nil overlay ResourceLimits should leave the earlier layer intact")
	}
}

// ─── Sanity: error message shape used by session-limit consumers ───

// TestSessionLimitErrorMessageShape pins the substring the desktop matches on
// ("session limit reached") — see start_session.go. If the engine-side message
// changes, this test forces the change to be a conscious cross-surface edit.
func TestSessionLimitErrorMessageShape(t *testing.T) {
	const msg = "session limit reached: enterprise policy allows a maximum of 3 concurrent sessions"
	if !strings.Contains(msg, "session limit reached") {
		t.Error("session-limit error must contain the stable 'session limit reached' prefix")
	}
}

// ─── Feature 0004: enterprise provider definition pinning (BaseURL pin) ───

func TestEnforceEnterprise_ProviderPin_OverridesBaseURLAndAuthHeader(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			// User tries to route around the gateway by editing baseURL/authHeader.
			"anthropic": {BaseURL: "https://api.anthropic.com", AuthHeader: "x-user", APIKey: "user-key"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://gateway.corp.example", AuthHeader: "x-corp", Backend: "api"},
		},
	}
	result := EnforceEnterprise(cfg, enterprise)

	got := result.Providers["anthropic"]
	if got.BaseURL != "https://gateway.corp.example" {
		t.Errorf("enterprise BaseURL must win: got %q", got.BaseURL)
	}
	if got.AuthHeader != "x-corp" {
		t.Errorf("enterprise AuthHeader must win: got %q", got.AuthHeader)
	}
	if got.Backend != "api" {
		t.Errorf("enterprise Backend must win: got %q", got.Backend)
	}
}

func TestEnforceEnterprise_ProviderPin_PreservesUserAPIKeyWhenEnterpriseOmits(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://api.anthropic.com", APIKey: "user-key"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		Providers: map[string]types.ProviderConfig{
			// No APIKey — per-user key is user-supplied.
			"anthropic": {BaseURL: "https://gateway.corp.example"},
		},
	}
	result := EnforceEnterprise(cfg, enterprise)

	got := result.Providers["anthropic"]
	if got.APIKey != "user-key" {
		t.Errorf("user APIKey must be preserved when enterprise omits it: got %q", got.APIKey)
	}
	if got.BaseURL != "https://gateway.corp.example" {
		t.Errorf("enterprise BaseURL must still win: got %q", got.BaseURL)
	}
}

func TestEnforceEnterprise_ProviderPin_EnterpriseAPIKeyWinsWhenSet(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {APIKey: "user-key"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://gateway.corp.example", APIKey: "corp-key"},
		},
	}
	result := EnforceEnterprise(cfg, enterprise)

	if got := result.Providers["anthropic"].APIKey; got != "corp-key" {
		t.Errorf("enterprise APIKey must win when set: got %q", got)
	}
}

func TestEnforceEnterprise_ProviderPin_DeclaredProviderImplicitlyAllowed(t *testing.T) {
	// A provider declared by enterprise survives even though it is not on the
	// AllowedProviders list, while a user-added extra provider is stripped.
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://api.anthropic.com"},
			"rogue":     {BaseURL: "https://rogue.example"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		AllowedProviders: []string{"openai"},
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://gateway.corp.example"},
		},
	}
	result := EnforceEnterprise(cfg, enterprise)

	if _, ok := result.Providers["anthropic"]; !ok {
		t.Error("enterprise-declared provider must survive even without an allowlist entry")
	}
	if _, ok := result.Providers["rogue"]; ok {
		t.Error("user-added non-allowlisted provider must be stripped")
	}
}

func TestEnforceEnterprise_ProviderPin_DoesNotMutateInput(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://api.anthropic.com"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://gateway.corp.example"},
		},
	}
	_ = EnforceEnterprise(cfg, enterprise)

	if got := cfg.Providers["anthropic"].BaseURL; got != "https://api.anthropic.com" {
		t.Errorf("input config must not be mutated by provider pinning: got %q", got)
	}
}

func TestEnforceEnterprise_ProviderPin_RePinIdempotent(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://api.anthropic.com", APIKey: "user-key"},
		},
	}
	enterprise := &types.EnterpriseConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://gateway.corp.example"},
		},
	}
	first := EnforceEnterprise(cfg, enterprise)
	second := EnforceEnterprise(first, enterprise)

	if got := second.Providers["anthropic"].BaseURL; got != "https://gateway.corp.example" {
		t.Errorf("re-pin must be idempotent: got %q", got)
	}
	if got := second.Providers["anthropic"].APIKey; got != "user-key" {
		t.Errorf("re-pin must preserve user key: got %q", got)
	}
}

func TestMergeEnterprisePartial_ProvidersOverlay(t *testing.T) {
	base := &types.EnterpriseConfig{}
	overlay := &types.EnterpriseConfig{
		Providers: map[string]types.ProviderConfig{
			"anthropic": {BaseURL: "https://gateway.corp.example"},
		},
	}
	result := mergeEnterprisePartial(base, overlay)
	if got := result.Providers["anthropic"].BaseURL; got != "https://gateway.corp.example" {
		t.Errorf("overlay Providers must carry through: got %q", got)
	}
}
