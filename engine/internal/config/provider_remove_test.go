package config

import (
	"errors"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// isolateProviderRemove gives RemoveProvider no managed marker and the given
// machine policy, so the developer's own machine policy never leaks in.
func isolateProviderRemove(t *testing.T, policy types.EnterpriseConfig) {
	t.Helper()
	useManagedMarker(t, "")
	t.Setenv("ION_ENTERPRISE_CONFIG", "")
	useMachinePolicy(t, policy)
}

func TestRemoveProvider_DeletesEntryAndKeepsTheRest(t *testing.T) {
	isolateProviderRemove(t, types.EnterpriseConfig{})
	path := seedEngineConfig(t, `{
		"defaultModel": "anthropic/claude-sonnet-5",
		"futureKey": {"nested": true},
		"providers": {
			"corp-gateway": {"baseURL": "https://gw.example.org", "displayName": "Corp"},
			"anthropic": {"backend": "claude-code"}
		}
	}`)

	cleared, err := RemoveProvider("corp-gateway")
	if err != nil {
		t.Fatalf("RemoveProvider: %v", err)
	}
	if cleared != "" {
		t.Errorf("cleared fallback = %q, want none", cleared)
	}

	raw := readRawTestConfig(t, path)
	providers, _ := raw["providers"].(map[string]any)
	if _, still := providers["corp-gateway"]; still {
		t.Fatal("corp-gateway is still configured")
	}
	if _, kept := providers["anthropic"]; !kept {
		t.Error("an unrelated provider was dropped")
	}
	if raw["defaultModel"] != "anthropic/claude-sonnet-5" {
		t.Errorf("defaultModel = %v, want it untouched", raw["defaultModel"])
	}
	if _, kept := raw["futureKey"]; !kept {
		t.Error("an unknown top-level key was dropped")
	}
}

func TestRemoveProvider_Refusals(t *testing.T) {
	cases := []struct {
		name   string
		config string
		policy types.EnterpriseConfig
	}{
		{name: "not configured", config: `{"providers": {"other": {"baseURL": "https://x.example.org"}}}`},
		{name: "no providers block", config: `{}`},
		{
			name:   "enterprise declares it",
			config: `{"providers": {"corp-gateway": {"baseURL": "https://gw.example.org"}}}`,
			policy: types.EnterpriseConfig{Providers: map[string]types.ProviderConfig{"corp-gateway": {BaseURL: "https://gw.example.org"}}},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			isolateProviderRemove(t, tc.policy)
			path := seedEngineConfig(t, tc.config)
			before := readRawTestConfig(t, path)

			_, err := RemoveProvider("corp-gateway")
			var refused *ProviderRemoveError
			if !errors.As(err, &refused) {
				t.Fatalf("err = %v, want a ProviderRemoveError", err)
			}
			after := readRawTestConfig(t, path)
			if len(after) != len(before) {
				t.Errorf("a refused removal changed engine.json: %v -> %v", before, after)
			}
			if providers, ok := after["providers"].(map[string]any); ok {
				if _, kept := providers["corp-gateway"]; !kept && tc.name != "not configured" && tc.name != "no providers block" {
					t.Error("a refused removal deleted the provider")
				}
			}
		})
	}
}

// engine.json's defaultModel is only the engine's fallback; one that names
// the removed provider goes with it instead of blocking the removal.
func TestRemoveProvider_ClearsAFallbackModelFromTheProvider(t *testing.T) {
	isolateProviderRemove(t, types.EnterpriseConfig{})
	path := seedEngineConfig(t, `{"defaultModel": "corp-gateway/claude-sonnet-5", "providers": {"corp-gateway": {"baseURL": "https://gw.example.org"}}}`)

	cleared, err := RemoveProvider("corp-gateway")
	if err != nil {
		t.Fatalf("RemoveProvider: %v", err)
	}
	if cleared != "corp-gateway/claude-sonnet-5" {
		t.Errorf("cleared fallback = %q, want corp-gateway/claude-sonnet-5", cleared)
	}
	raw := readRawTestConfig(t, path)
	if _, still := raw["defaultModel"]; still {
		t.Error("the fallback model naming the removed provider is still set")
	}
}
