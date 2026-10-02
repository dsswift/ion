package modelconfig

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/types"
)

// useManagedModels writes a user models.json and an enterprise policy that
// projects managedJSON over it. It returns the user file's path.
func useManagedModels(t *testing.T, userJSON, managedJSON string, schemaVersion int) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("ION_DATA_DIR", "")
	userPath := filepath.Join(home, ".ion", "models.json")
	if err := os.MkdirAll(filepath.Dir(userPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(userPath, []byte(userJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	managedDir := t.TempDir()
	managedPath := filepath.Join(managedDir, "models.managed.json")
	if err := os.WriteFile(managedPath, []byte(managedJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	policy, err := json.Marshal(types.EnterpriseConfig{
		ManagedConfig: &types.ManagedConfigSource{ModelsPath: managedPath, SchemaVersion: schemaVersion},
	})
	if err != nil {
		t.Fatal(err)
	}
	policyPath := filepath.Join(managedDir, "enterprise.json")
	if err := os.WriteFile(policyPath, policy, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", policyPath)
	return userPath
}

const userModels = `{"defaultProvider":"user-provider","tiers":{"fast":"user-fast","smart":"user-smart"}}`

func TestManagedModels_ReplaceUserFile(t *testing.T) {
	useManagedModels(t, userModels, `{"tiers":{"fast":"managed-fast"}}`, 1)

	if got := ResolveTier("fast"); got != "managed-fast" {
		t.Errorf("ResolveTier(fast) = %q, want the managed model", got)
	}
	// The managed file omits these, so they are absent: the user's values do
	// not fall through.
	if _, configured := LookupTier("smart"); configured {
		t.Error("tier smart is configured, want absent: the user file must contribute nothing")
	}
	if got := DefaultProviderID(); got != "" {
		t.Errorf("DefaultProviderID = %q, want none", got)
	}
}

func TestManagedModels_WritesRefused(t *testing.T) {
	userPath := useManagedModels(t, userModels, `{"tiers":{"fast":"managed-fast"}}`, 1)

	_, setErr := SetTier("fast", "other-model", nil)
	_, removeErr := RemoveTier("fast")
	_, providerErr := SetDefaultProvider("other-provider")
	for operation, err := range map[string]error{"set_model_tier": setErr, "remove_model_tier": removeErr, "set_default_provider": providerErr} {
		var refused *config.ManagedConfigWriteError
		if !errors.As(err, &refused) {
			t.Fatalf("%s error = %v, want a ManagedConfigWriteError", operation, err)
		}
		if refused.Surface != config.ManagedSurfaceModels || refused.Operation != operation {
			t.Errorf("%s refusal = %+v", operation, refused)
		}
	}
	if data, _ := os.ReadFile(userPath); string(data) != userModels {
		t.Errorf("user models.json changed: %s", data)
	}
	if got := ResolveTier("fast"); got != "managed-fast" {
		t.Errorf("ResolveTier(fast) = %q after refused writes, want the managed model", got)
	}
}

func TestManagedModels_UnsupportedVersionYieldsNoConfig(t *testing.T) {
	useManagedModels(t, userModels, `{"tiers":{"fast":"managed-fast"}}`, 99)

	if len(LoadModelsConfig()) != 0 {
		t.Errorf("LoadModelsConfig = %v, want empty: neither file applies", LoadModelsConfig())
	}
	if got := ResolveTier("fast"); got != "fast" {
		t.Errorf("ResolveTier(fast) = %q, want passthrough", got)
	}
}
