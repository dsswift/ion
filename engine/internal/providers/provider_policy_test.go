package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// withPolicyRegistry registers a public "anthropic" provider owning a bare
// claude id and a gateway provider serving the same model under its qualified
// id, then restores the registry and the allow-list when the test ends.
func withPolicyRegistry(t *testing.T) {
	t.Helper()
	prevAllowed := allowedProviders.Load()
	prevAnthropic := GetProvider("anthropic")
	RegisterProvider(&mockProvider{id: "anthropic"})
	RegisterProvider(&mockProvider{id: "policy-gw"})
	RegisterModel("claude-policy-test", types.ModelInfo{ProviderID: "anthropic", ContextWindow: 1000})
	RegisterModel("policy-gw/claude-policy-test", types.ModelInfo{ProviderID: "policy-gw", ContextWindow: 1000})
	t.Cleanup(func() {
		allowedProviders.Store(prevAllowed)
		UnregisterModel("claude-policy-test")
		UnregisterModel("policy-gw/claude-policy-test")
		UnregisterProvider("policy-gw")
		if prevAnthropic != nil {
			RegisterProvider(prevAnthropic)
		} else {
			UnregisterProvider("anthropic")
		}
	})
}

func TestProviderAllowListZeroValueIsUnrestricted(t *testing.T) {
	withPolicyRegistry(t)
	allowedProviders.Store(nil)
	if p := ResolveProvider("claude-policy-test"); p == nil || p.ID() != "anthropic" {
		t.Fatalf("unrestricted bare claude id should resolve to anthropic, got %v", p)
	}
}

func TestProviderAllowListRefusesBuiltInProvider(t *testing.T) {
	withPolicyRegistry(t)
	SetAllowedProviders([]string{"policy-gw"})

	if p := ResolveProvider("claude-policy-test"); p != nil {
		t.Fatalf("registered bare id resolved to %q; allow-list should refuse it", p.ID())
	}
	if p := ResolveProvider("claude-not-registered"); p != nil {
		t.Fatalf("prefix-matched bare id resolved to %q; allow-list should refuse it", p.ID())
	}
	if info := GetModelInfo("claude-policy-test"); info != nil {
		t.Fatalf("GetModelInfo exposed refused model on provider %q", info.ProviderID)
	}
	if id := ProviderNameForModel("claude-not-registered"); id != "" {
		t.Fatalf("ProviderNameForModel = %q, want empty", id)
	}
}

func TestProviderAllowListKeepsPermittedGateway(t *testing.T) {
	withPolicyRegistry(t)
	SetAllowedProviders([]string{"policy-gw"})

	if p := ResolveProvider("policy-gw/claude-policy-test"); p == nil || p.ID() != "policy-gw" {
		t.Fatalf("gateway id should resolve to policy-gw, got %v", p)
	}
	if info := GetModelInfo("policy-gw/claude-policy-test"); info == nil || info.ProviderID != "policy-gw" {
		t.Fatalf("gateway model info missing: %v", info)
	}
}

func TestProviderAllowListFiltersListing(t *testing.T) {
	withPolicyRegistry(t)
	SetAllowedProviders([]string{"policy-gw"})

	sawGateway := false
	for _, m := range ListModels() {
		if m.ProviderID != "policy-gw" {
			t.Fatalf("listing advertised %q on refused provider %q", m.ID, m.ProviderID)
		}
		if m.ID == "policy-gw/claude-policy-test" {
			sawGateway = true
		}
	}
	if !sawGateway {
		t.Fatal("listing dropped the permitted gateway model")
	}
}
