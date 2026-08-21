package modelconfig

import (
	"errors"
	"testing"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestResolveModelForOrigin_AgentLocksBareModelToParentProvider(t *testing.T) {
	const provider = "origin-gateway"
	const bare = "origin-claude"
	qualified := provider + "/" + bare
	providers.RegisterModel("origin-parent", types.ModelInfo{ProviderID: provider})
	providers.RegisterModel(bare, types.ModelInfo{ProviderID: "anthropic"})
	providers.RegisterModel(qualified, types.ModelInfo{ProviderID: provider})
	t.Cleanup(func() {
		providers.UnregisterModel("origin-parent")
		providers.UnregisterModel(bare)
		providers.UnregisterModel(qualified)
	})

	got, _, err := ResolveModelForOrigin(bare, "origin-parent", types.ModelOriginAgent)
	if err != nil {
		t.Fatalf("ResolveModelForOrigin: %v", err)
	}
	if got != qualified {
		t.Fatalf("resolved model = %q, want %q", got, qualified)
	}
}

func TestResolveModelForOrigin_AgentRefusesCrossProvider(t *testing.T) {
	providers.RegisterModel("origin-parent-refuse", types.ModelInfo{ProviderID: "origin-private"})
	providers.RegisterModel("anthropic/origin-claude", types.ModelInfo{ProviderID: "anthropic"})
	t.Cleanup(func() {
		providers.UnregisterModel("origin-parent-refuse")
		providers.UnregisterModel("anthropic/origin-claude")
	})

	_, _, err := ResolveModelForOrigin("anthropic/origin-claude", "origin-parent-refuse", types.ModelOriginAgent)
	var locked *ProviderLockedModelError
	if !errors.As(err, &locked) {
		t.Fatalf("error = %v, want ProviderLockedModelError", err)
	}
	if locked.SessionProvider != "origin-private" {
		t.Fatalf("provider = %q, want origin-private", locked.SessionProvider)
	}
}

func TestResolveModelForOrigin_ConfigAllowsCrossProviderAndTier(t *testing.T) {
	providers.RegisterModel("origin-parent-config", types.ModelInfo{ProviderID: "origin-private-config"})
	providers.RegisterModel("anthropic/origin-config", types.ModelInfo{ProviderID: "anthropic"})
	t.Cleanup(func() {
		providers.UnregisterModel("origin-parent-config")
		providers.UnregisterModel("anthropic/origin-config")
	})

	got, _, err := ResolveModelForOrigin("anthropic/origin-config", "origin-parent-config", types.ModelOriginConfig)
	if err != nil {
		t.Fatalf("ResolveModelForOrigin: %v", err)
	}
	if got != "anthropic/origin-config" {
		t.Fatalf("resolved model = %q", got)
	}
}
