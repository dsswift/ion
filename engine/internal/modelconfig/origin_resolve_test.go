package modelconfig

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
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
	providers.RegisterModel("origin-private/origin-allowed", types.ModelInfo{ProviderID: "origin-private"})
	providers.RegisterModel("anthropic/origin-claude", types.ModelInfo{ProviderID: "anthropic"})
	t.Cleanup(func() {
		providers.UnregisterModel("origin-parent-refuse")
		providers.UnregisterModel("origin-private/origin-allowed")
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
	// The message itself must name what IS allowed -- a dispatching agent
	// only sees Error() text, never the AllowedModels field directly, so a
	// refusal with an unpopulated message left it no way to self-correct.
	if !strings.Contains(err.Error(), "origin-private/origin-allowed") {
		t.Fatalf("error message = %q, want it to list the allowed model", err.Error())
	}
}

// A tier written with a bare model name follows the operator's configured
// default provider, so flipping one setting reroutes every tier alias without
// hand-qualifying each models.json entry.
func TestResolveModelForOrigin_TierFollowsDefaultProvider(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	ionDir := filepath.Join(home, ".ion")
	if err := os.MkdirAll(ionDir, 0o700); err != nil {
		t.Fatalf("create temp .ion: %v", err)
	}
	config := map[string]any{
		"defaultProvider": "origin-defprov",
		"tiers":           map[string]any{"standard": "origin-tier-bare"},
	}
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("marshal config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(ionDir, "models.json"), data, 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	providers.RegisterModel("origin-tier-bare", types.ModelInfo{ProviderID: "anthropic"})
	providers.RegisterModel("origin-defprov/origin-tier-bare", types.ModelInfo{ProviderID: "origin-defprov"})
	t.Cleanup(func() {
		providers.UnregisterModel("origin-tier-bare")
		providers.UnregisterModel("origin-defprov/origin-tier-bare")
	})

	got, _, err := ResolveModelForOrigin("standard", "", types.ModelOriginConfig)
	if err != nil {
		t.Fatalf("ResolveModelForOrigin: %v", err)
	}
	if got != "origin-defprov/origin-tier-bare" {
		t.Fatalf("resolved model = %q, want origin-defprov/origin-tier-bare", got)
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
