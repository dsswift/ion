package config

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func overridesOf(t *testing.T, cfg *types.EngineRuntimeConfig, enterprise *types.EnterpriseConfig) []types.PolicyOverride {
	t.Helper()
	result := EnforceEnterprise(cfg, enterprise)
	if result.Enterprise == nil {
		t.Fatal("EnforceEnterprise must carry the enterprise config on its result")
	}
	return result.Enterprise.Overrides
}

func TestPolicyOverrides_PinnedProviderFieldsAreReported(t *testing.T) {
	got := overridesOf(t,
		&types.EngineRuntimeConfig{Providers: map[string]types.ProviderConfig{
			"gateway": {BaseURL: "https://rogue.example.org/v1", AuthHeader: "x-user", Backend: "codex", DisplayName: "Mine", APIKey: "user-key"},
		}},
		&types.EnterpriseConfig{Providers: map[string]types.ProviderConfig{
			"gateway": {BaseURL: "https://gateway.example.org/v1", AuthHeader: "api-key", Backend: "api", DisplayName: "Corp Gateway"},
		}},
	)
	want := []types.PolicyOverride{
		{Field: "providers.gateway.authHeader", Reason: types.PolicyOverrideProviderPinned, UserValue: "x-user", EffectiveValue: "api-key"},
		{Field: "providers.gateway.backend", Reason: types.PolicyOverrideProviderPinned, UserValue: "codex", EffectiveValue: "api"},
		{Field: "providers.gateway.baseURL", Reason: types.PolicyOverrideProviderPinned, UserValue: "https://rogue.example.org/v1", EffectiveValue: "https://gateway.example.org/v1"},
		{Field: "providers.gateway.displayName", Reason: types.PolicyOverrideProviderPinned, UserValue: "Mine", EffectiveValue: "Corp Gateway"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("overrides mismatch\n got: %+v\nwant: %+v", got, want)
	}
}

func TestPolicyOverrides_ValueEqualToPolicyIsNotAnOverride(t *testing.T) {
	got := overridesOf(t,
		&types.EngineRuntimeConfig{
			DefaultModel: "model-a",
			Providers: map[string]types.ProviderConfig{
				"gateway": {BaseURL: "https://gateway.example.org/v1", APIKey: "user-key"},
				"unset":   {APIKey: "user-key"},
			},
		},
		&types.EnterpriseConfig{
			AllowedModels: []string{"model-a"},
			Providers: map[string]types.ProviderConfig{
				"gateway": {BaseURL: "https://gateway.example.org/v1"},
				// The lower layer set no baseURL here, so there is nothing to displace.
				"unset": {BaseURL: "https://gateway.example.org/v1"},
				// No lower-layer entry at all.
				"absent": {BaseURL: "https://gateway.example.org/v1"},
			},
		},
	)
	if len(got) != 0 {
		t.Fatalf("matching or absent lower-layer values must produce no override, got %+v", got)
	}
}

func TestPolicyOverrides_RemovedLowerLayerValueIsReported(t *testing.T) {
	got := overridesOf(t,
		&types.EngineRuntimeConfig{Providers: map[string]types.ProviderConfig{"gateway": {BaseURL: "https://rogue.example.org"}}},
		// The enterprise definition omits baseURL, so the lower-layer one is dropped.
		&types.EnterpriseConfig{Providers: map[string]types.ProviderConfig{"gateway": {Backend: "api"}}},
	)
	want := []types.PolicyOverride{{Field: "providers.gateway.baseURL", Reason: types.PolicyOverrideProviderPinned, UserValue: "https://rogue.example.org"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("overrides mismatch\n got: %+v\nwant: %+v", got, want)
	}
}

func TestPolicyOverrides_NoSecretMaterial(t *testing.T) {
	got := overridesOf(t,
		&types.EngineRuntimeConfig{Providers: map[string]types.ProviderConfig{
			"gateway": {BaseURL: "https://user:hunter2@rogue.example.org/v1?token=user-secret#frag", APIKey: "user-key-secret"},
			"keyed":   {BaseURL: "https://gateway.example.org/v1?key=user-secret"},
		}},
		&types.EnterpriseConfig{Providers: map[string]types.ProviderConfig{
			"gateway": {BaseURL: "https://gateway.example.org/v1?sig=corp-secret", APIKey: "corp-key-secret"},
			"keyed":   {BaseURL: "https://gateway.example.org/v1?key=corp-secret"},
		}},
	)
	want := []types.PolicyOverride{
		{Field: "providers.gateway.apiKey", Reason: types.PolicyOverrideProviderPinned},
		{Field: "providers.gateway.baseURL", Reason: types.PolicyOverrideProviderPinned, UserValue: "https://rogue.example.org/v1", EffectiveValue: "https://gateway.example.org/v1"},
		// The URLs differ only in a credential, so the change is reported without values.
		{Field: "providers.keyed.baseURL", Reason: types.PolicyOverrideProviderPinned},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("overrides mismatch\n got: %+v\nwant: %+v", got, want)
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal overrides: %v", err)
	}
	for _, secret := range []string{"hunter2", "user-secret", "corp-secret", "user-key-secret", "corp-key-secret"} {
		if strings.Contains(string(encoded), secret) {
			t.Errorf("override notices must carry no secret material, found %q in %s", secret, encoded)
		}
	}
}

func TestPolicyOverrides_PrunedProvidersModelsAndMcpServers(t *testing.T) {
	got := overridesOf(t,
		&types.EngineRuntimeConfig{
			DefaultModel: "model-x",
			Providers:    map[string]types.ProviderConfig{"anthropic": {}, "rogue": {BaseURL: "https://rogue.example.org"}},
			McpServers: map[string]types.McpServerConfig{
				"denied": {URL: "https://mcp.example.org"}, "stray": {URL: "https://elsewhere.example.com"}, "ok": {URL: "https://tools.example.org"},
			},
		},
		&types.EnterpriseConfig{
			AllowedModels:    []string{"model-a"},
			AllowedProviders: []string{"anthropic"},
			McpDenylist:      []string{"denied"},
			McpAllowlist:     []string{"ok"},
		},
	)
	want := []types.PolicyOverride{
		{Field: "defaultModel", Reason: types.PolicyOverrideModelNotAllowed, UserValue: "model-x", EffectiveValue: "model-a"},
		{Field: "mcpServers.denied", Reason: types.PolicyOverrideMcpServerDenied},
		{Field: "mcpServers.stray", Reason: types.PolicyOverrideMcpServerNotAllowed},
		{Field: "providers.rogue", Reason: types.PolicyOverrideProviderNotAllowed},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("overrides mismatch\n got: %+v\nwant: %+v", got, want)
	}
}

func TestPolicyOverrides_BlockedDefaultModel(t *testing.T) {
	got := overridesOf(t,
		&types.EngineRuntimeConfig{DefaultModel: "model-x"},
		&types.EnterpriseConfig{BlockedModels: []string{"model-x"}},
	)
	want := []types.PolicyOverride{{Field: "defaultModel", Reason: types.PolicyOverrideModelBlocked, UserValue: "model-x"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("overrides mismatch\n got: %+v\nwant: %+v", got, want)
	}
}

// A policy source cannot claim overrides, and enforcement must not write the
// computed set back into the source it was handed.
func TestPolicyOverrides_EngineStampedNotSourceSupplied(t *testing.T) {
	enterprise := &types.EnterpriseConfig{
		Overrides: []types.PolicyOverride{{Field: "forged", Reason: "forged"}},
		Providers: map[string]types.ProviderConfig{"gateway": {BaseURL: "https://gateway.example.org"}},
	}
	if got := overridesOf(t, &types.EngineRuntimeConfig{}, enterprise); len(got) != 0 {
		t.Fatalf("a source-supplied overrides list must not survive, got %+v", got)
	}
	got := overridesOf(t, &types.EngineRuntimeConfig{Providers: map[string]types.ProviderConfig{"gateway": {BaseURL: "https://rogue.example.org"}}}, enterprise)
	if len(got) != 1 || got[0].Field != "providers.gateway.baseURL" {
		t.Fatalf("expected the computed override only, got %+v", got)
	}
	if len(enterprise.Overrides) != 1 || enterprise.Overrides[0].Field != "forged" {
		t.Errorf("EnforceEnterprise must not mutate the enterprise config it was given, got %+v", enterprise.Overrides)
	}
}

// A provider the enterprise declares is implicitly allowed, so the allowlist
// must not strip its lower-layer entry before the pin carries the API key over.
func TestEnforceEnterprise_DeclaredProviderKeepsUserAPIKeyUnderAllowlist(t *testing.T) {
	result := EnforceEnterprise(
		&types.EngineRuntimeConfig{Providers: map[string]types.ProviderConfig{"gateway": {BaseURL: "https://rogue.example.org", APIKey: "user-key"}}},
		&types.EnterpriseConfig{
			AllowedProviders: []string{"anthropic"},
			Providers:        map[string]types.ProviderConfig{"gateway": {BaseURL: "https://gateway.example.org"}},
		},
	)
	if got := result.Providers["gateway"]; got.APIKey != "user-key" || got.BaseURL != "https://gateway.example.org" {
		t.Fatalf("declared provider must be pinned with the user API key kept, got %+v", got)
	}
	want := []types.PolicyOverride{{Field: "providers.gateway.baseURL", Reason: types.PolicyOverrideProviderPinned, UserValue: "https://rogue.example.org", EffectiveValue: "https://gateway.example.org"}}
	if !reflect.DeepEqual(result.Enterprise.Overrides, want) {
		t.Fatalf("overrides mismatch\n got: %+v\nwant: %+v", result.Enterprise.Overrides, want)
	}
}
