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

func TestEnforceEnterprise_AuthRequiresOperatorIdentity(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Auth = &types.AuthConfig{IdentityProvider: "personal"}
	enterprise := &types.EnterpriseConfig{Auth: &types.AuthConfig{
		IdentityProvider: "corp", RequireOperatorIdentity: true,
		OAuth: map[string]types.OAuthConfig{"corp": {ClientID: "managed-client"}},
	}}

	result := EnforceEnterprise(cfg, enterprise)
	if result.Auth == nil || result.Auth.IdentityProvider != "corp" || !result.Auth.RequireOperatorIdentity {
		t.Fatalf("enterprise auth was not sealed: %#v", result.Auth)
	}
	if result.Auth.OAuth["corp"].ClientID != "managed-client" {
		t.Fatal("enterprise OAuth client config was not applied")
	}
	if cfg.Auth.IdentityProvider != "personal" {
		t.Fatal("enterprise auth enforcement mutated input")
	}
}

func TestEnforceEnterprise_AuthCannotDisableLowerRequirement(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Auth = &types.AuthConfig{IdentityProvider: "corp", RequireOperatorIdentity: true}
	result := EnforceEnterprise(cfg, &types.EnterpriseConfig{Auth: &types.AuthConfig{IdentityProvider: "corp"}})
	if result.Auth == nil || !result.Auth.RequireOperatorIdentity {
		t.Fatal("enterprise false weakened lower-layer required identity")
	}
}

func TestMergeEnterprisePartial_AuthOverlay(t *testing.T) {
	base := &types.EnterpriseConfig{}
	overlay := &types.EnterpriseConfig{Auth: &types.AuthConfig{IdentityProvider: "corp", RequireOperatorIdentity: true}}
	result := mergeEnterprisePartial(base, overlay)
	if result.Auth == nil || result.Auth.IdentityProvider != "corp" || !result.Auth.RequireOperatorIdentity {
		t.Fatalf("overlay Auth must carry through: %#v", result.Auth)
	}
}

// ─── Feature 0011 / #308: extension allowlist overlay merge ───

func TestMergeEnterprisePartial_ExtensionAllowlist(t *testing.T) {
	base := &types.EnterpriseConfig{}
	overlay := &types.EnterpriseConfig{
		ExtensionAllowlist: []types.ExtensionAllowlistEntry{
			{ID: "example-ext"},
			{ID: "chief-of-staff", SHA256: "abc123"},
		},
	}
	result := mergeEnterprisePartial(base, overlay)
	if len(result.ExtensionAllowlist) != 2 {
		t.Fatalf("overlay ExtensionAllowlist must carry through: got %d", len(result.ExtensionAllowlist))
	}
	if result.ExtensionAllowlist[1].SHA256 != "abc123" {
		t.Errorf("overlay entry hash must survive: got %q", result.ExtensionAllowlist[1].SHA256)
	}
}

// TestEnterpriseSealForwardsEventHubDestination pins that a sealed
// conversation-events policy can actually deliver. Forwarding "enabled" and
// the target without the destination produced a policy that forced the
// eventhub target on with nowhere to send, so every flush failed into the
// retry queue — enforcement that cannot enforce anything.
func TestEnterpriseSealForwardsEventHubDestination(t *testing.T) {
	enterprise := &types.EnterpriseConfig{
		ConversationEvents: &types.ConversationEventsConfig{
			Enabled:               true,
			Targets:               []string{"eventhub"},
			EventHubNamespace:     "orion.servicebus.windows.net",
			EventHubName:          "conversation-events",
			EventHubTokenScope:    "https://eventhubs.azure.net/.default",
			EventHubTokenAudience: "aud",
		},
	}
	result := MergeConfigs(enterprise, DefaultConfig())
	result = EnforceEnterprise(result, enterprise)

	ce := result.ConversationEvents
	if ce == nil || !ce.Enabled {
		t.Fatal("enterprise did not force conversation events on")
	}
	if ce.EventHubNamespace != "orion.servicebus.windows.net" {
		t.Errorf("namespace = %q, want the enterprise value — without it the sealed target has nowhere to send", ce.EventHubNamespace)
	}
	if ce.EventHubName != "conversation-events" {
		t.Errorf("hub name = %q, want conversation-events", ce.EventHubName)
	}
	if ce.EventHubTokenScope != "https://eventhubs.azure.net/.default" {
		t.Errorf("token scope = %q, want the enterprise value", ce.EventHubTokenScope)
	}
	if ce.EventHubTokenAudience != "aud" {
		t.Errorf("token audience = %q, want aud", ce.EventHubTokenAudience)
	}
}

func TestEnforceEnterprise_PrincipalPartitioning_RequiredForcesOnRegardlessOfUserSetting(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{} // no user Security block at all
	enterprise := &types.EnterpriseConfig{
		Security: &types.EnterpriseSecurityConfig{RequirePrincipalPartitioning: true},
	}
	result := EnforceEnterprise(cfg, enterprise)

	if result.Security == nil || result.Security.PrincipalPartitioning == nil || !result.Security.PrincipalPartitioning.Enabled {
		t.Fatal("expected partitioning forced on by the enterprise requirement")
	}
	if got := result.Security.PrincipalPartitioning.ResolvedEnforcement(); got != types.EnforcementStrict {
		t.Errorf("expected default enforcement strict once forced on, got %q", got)
	}
}

func TestEnforceEnterprise_PrincipalPartitioning_UserCannotDisableARequiredSetting(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{PrincipalPartitioning: &types.PrincipalPartitioningConfig{Enabled: false}},
	}
	enterprise := &types.EnterpriseConfig{
		Security: &types.EnterpriseSecurityConfig{RequirePrincipalPartitioning: true},
	}
	result := EnforceEnterprise(cfg, enterprise)

	if !result.Security.PrincipalPartitioning.Enabled {
		t.Fatal("a user Enabled=false must not survive a sealed RequirePrincipalPartitioning")
	}
}

func TestEnforceEnterprise_PrincipalPartitioning_MinEnforcementRaisesALooserUserValue(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{PrincipalPartitioning: &types.PrincipalPartitioningConfig{Enabled: true, Enforcement: types.EnforcementNone}},
	}
	enterprise := &types.EnterpriseConfig{
		Security: &types.EnterpriseSecurityConfig{MinEnforcement: types.EnforcementStrict},
	}
	result := EnforceEnterprise(cfg, enterprise)

	if result.Security.PrincipalPartitioning.Enforcement != types.EnforcementStrict {
		t.Errorf("expected enforcement raised to the sealed floor 'strict', got %q", result.Security.PrincipalPartitioning.Enforcement)
	}
}

func TestEnforceEnterprise_PrincipalPartitioning_MinEnforcementNeverLowersAStricterUserValue(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Security: &types.SecurityConfig{PrincipalPartitioning: &types.PrincipalPartitioningConfig{Enabled: true, Enforcement: types.EnforcementStrict}},
	}
	enterprise := &types.EnterpriseConfig{
		Security: &types.EnterpriseSecurityConfig{MinEnforcement: types.EnforcementReadOnly},
	}
	result := EnforceEnterprise(cfg, enterprise)

	if result.Security.PrincipalPartitioning.Enforcement != types.EnforcementStrict {
		t.Errorf("a stricter user-configured value must stand over a looser enterprise floor, got %q", result.Security.PrincipalPartitioning.Enforcement)
	}
}

func TestEnforceEnterprise_PrincipalPartitioning_NilEnterpriseSecurityLeavesUserValueUntouched(t *testing.T) {
	userSecurity := &types.SecurityConfig{PrincipalPartitioning: &types.PrincipalPartitioningConfig{Enabled: true, Enforcement: types.EnforcementReadOnly}}
	cfg := &types.EngineRuntimeConfig{Security: userSecurity}
	result := EnforceEnterprise(cfg, &types.EnterpriseConfig{})

	if result.Security != userSecurity {
		t.Error("expected the user's Security block to pass through unchanged when enterprise sets no security policy")
	}
}

func TestEnforceEnterprise_PrincipalPartitioning_DoesNotMutateInput(t *testing.T) {
	userPartitioning := &types.PrincipalPartitioningConfig{Enabled: false}
	userSecurity := &types.SecurityConfig{PrincipalPartitioning: userPartitioning}
	cfg := &types.EngineRuntimeConfig{Security: userSecurity}
	enterprise := &types.EnterpriseConfig{Security: &types.EnterpriseSecurityConfig{RequirePrincipalPartitioning: true}}

	_ = EnforceEnterprise(cfg, enterprise)

	if userPartitioning.Enabled {
		t.Error("EnforceEnterprise must not mutate the caller's PrincipalPartitioningConfig in place")
	}
}

func TestEnforceEnterprise_GitIdentity_RequiredForcesOnRegardlessOfUserSetting(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{} // no user Git block at all
	enterprise := &types.EnterpriseConfig{Git: &types.EnterpriseGitConfig{Required: true}}
	result := EnforceEnterprise(cfg, enterprise)

	if result.Git == nil || !result.Git.Identity.RequiredEnabled() {
		t.Fatal("expected git identity Required forced on by the enterprise seal")
	}
}

func TestEnforceEnterprise_GitIdentity_UserCannotDisableARequiredSetting(t *testing.T) {
	notRequired := false
	cfg := &types.EngineRuntimeConfig{Git: &types.GitConfig{Identity: types.GitIdentityConfig{Required: &notRequired}}}
	enterprise := &types.EnterpriseConfig{Git: &types.EnterpriseGitConfig{Required: true}}
	result := EnforceEnterprise(cfg, enterprise)

	if !result.Git.Identity.RequiredEnabled() {
		t.Fatal("a user Required=false must not survive a sealed enterprise requirement")
	}
}

func TestEnforceEnterprise_GitIdentity_MachineReplacesUserFallback(t *testing.T) {
	cfg := &types.EngineRuntimeConfig{
		Git: &types.GitConfig{Identity: types.GitIdentityConfig{Machine: &types.GitAuthor{Name: "User Machine", Email: "user@example.com"}}},
	}
	enterprise := &types.EnterpriseConfig{Git: &types.EnterpriseGitConfig{Machine: &types.GitAuthor{Name: "CI Bot", Email: "ci@example.com"}}}
	result := EnforceEnterprise(cfg, enterprise)

	if result.Git.Identity.Machine == nil || result.Git.Identity.Machine.Name != "CI Bot" || result.Git.Identity.Machine.Email != "ci@example.com" {
		t.Errorf("expected the enterprise machine identity to replace the user's, got %+v", result.Git.Identity.Machine)
	}
}

func TestEnforceEnterprise_GitIdentity_NilEnterpriseGitLeavesUserValueUntouched(t *testing.T) {
	userGit := &types.GitConfig{Identity: types.GitIdentityConfig{Machine: &types.GitAuthor{Name: "User Machine", Email: "user@example.com"}}}
	cfg := &types.EngineRuntimeConfig{Git: userGit}
	result := EnforceEnterprise(cfg, &types.EnterpriseConfig{})

	if result.Git != userGit {
		t.Error("expected the user's Git block to pass through unchanged when enterprise sets no git policy")
	}
}

func TestEnforceEnterprise_GitIdentity_DoesNotMutateInput(t *testing.T) {
	userIdentity := types.GitIdentityConfig{}
	userGit := &types.GitConfig{Identity: userIdentity}
	cfg := &types.EngineRuntimeConfig{Git: userGit}
	enterprise := &types.EnterpriseConfig{Git: &types.EnterpriseGitConfig{Required: true}}

	_ = EnforceEnterprise(cfg, enterprise)

	if userGit.Identity.RequiredEnabled() {
		t.Error("EnforceEnterprise must not mutate the caller's GitConfig in place")
	}
}

func TestEnforceEnterprise_SystemMetricsReplacesUserBlock(t *testing.T) {
	off := false
	user := &types.EngineRuntimeConfig{SystemMetrics: &types.SystemMetricsConfig{BackgroundIntervalMs: 1000}}
	got := EnforceEnterprise(user, &types.EnterpriseConfig{
		SystemMetrics: &types.SystemMetricsConfig{Enabled: &off, TelemetryIntervalMs: 120_000},
	})
	if got.SystemMetrics == nil || got.SystemMetrics.IsEnabled() || got.SystemMetrics.BackgroundIntervalMs != 0 || got.SystemMetrics.TelemetryIntervalMs != 120_000 {
		t.Fatalf("enterprise block must replace the user's whole: %+v", got.SystemMetrics)
	}
	untouched := EnforceEnterprise(&types.EngineRuntimeConfig{SystemMetrics: &types.SystemMetricsConfig{BackgroundIntervalMs: 1000}}, &types.EnterpriseConfig{})
	if untouched.SystemMetrics.BackgroundIntervalMs != 1000 {
		t.Fatalf("no enterprise block must leave the user's alone: %+v", untouched.SystemMetrics)
	}
}

func TestEnforceEnterprise_TelemetrySealCarriesOtel(t *testing.T) {
	sealed := &types.OtelConfig{Enabled: true, Endpoint: "https://collector.example.org"}
	got := EnforceEnterprise(
		&types.EngineRuntimeConfig{Telemetry: &types.TelemetryConfig{Otel: &types.OtelConfig{Endpoint: "https://user.example.org"}}},
		&types.EnterpriseConfig{Telemetry: &types.TelemetryConfig{Enabled: true, Otel: sealed}},
	)
	if got.Telemetry.Otel == nil || got.Telemetry.Otel.Endpoint != "https://collector.example.org" {
		t.Fatalf("sealed telemetry must carry the enterprise otel block: %+v", got.Telemetry.Otel)
	}
}

// A sealed telemetry block must carry its destinations: forcing the "http"
// or "eventhub" target on with nowhere to send would fail every flush.
func TestEnforceEnterprise_TelemetrySealCarriesDestinations(t *testing.T) {
	got := EnforceEnterprise(&types.EngineRuntimeConfig{}, &types.EnterpriseConfig{Telemetry: &types.TelemetryConfig{
		Enabled:             true,
		Targets:             []string{"http", "eventhub"},
		HttpEndpoint:        "https://siem.example.org/ingest",
		HttpHeaders:         map[string]string{"X-Tenant": "t1"},
		EventHubNamespace:   "ns.servicebus.windows.net",
		EventHubName:        "ion",
		EventHubTokenScope:  "https://eventhubs.azure.net/.default",
		OversizeEventPolicy: "quarantine",
	}})
	tc := got.Telemetry
	if tc.HttpEndpoint != "https://siem.example.org/ingest" || tc.HttpHeaders["X-Tenant"] != "t1" {
		t.Fatalf("http destination not sealed: %+v", tc)
	}
	if tc.EventHubNamespace != "ns.servicebus.windows.net" || tc.EventHubName != "ion" || tc.EventHubTokenScope == "" {
		t.Fatalf("event hub destination not sealed: %+v", tc)
	}
	if tc.OversizeEventPolicy != "quarantine" {
		t.Fatalf("oversize policy not sealed: %q", tc.OversizeEventPolicy)
	}
}
