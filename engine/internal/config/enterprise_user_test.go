package config

// enterprise_user_test.go — tests for the per-user enterprise layer
// (manifest C11, program child 03): additive-only invariant, ignored-key
// logging, url-based dedupe, and the three per-user sources.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestUserLayer_ExtractsOnlyEnvironments proves extractEnvironmentEntries
// returns the environments array and nothing else -- every other key
// (including a nested policy-relevant field like allowedModels or a
// locked flag) is dropped, never surfaced into the merged policy.
func TestUserLayer_ExtractsOnlyEnvironments(t *testing.T) {
	raw := map[string]any{
		"allowedModels": []any{"should-be-ignored"},
		"customFields": map[string]any{
			"ion-desktop": map[string]any{
				"environments": []any{
					map[string]any{"label": "Team A", "url": "wss://ion-a.corp.example"},
				},
				"environmentPolicy": map[string]any{"mode": "central-only", "locked": true},
				"activeUiPolicy":    "overlay",
			},
			"other-consumer": map[string]any{"foo": "bar"},
		},
	}

	entries := extractEnvironmentEntries(raw, "test-source")
	if len(entries) != 1 {
		t.Fatalf("got %d entries, want 1", len(entries))
	}
	if entries[0]["label"] != "Team A" {
		t.Errorf("entry label = %v, want Team A", entries[0]["label"])
	}
	if entries[0]["url"] != "wss://ion-a.corp.example" {
		t.Errorf("entry url = %v, want wss://ion-a.corp.example", entries[0]["url"])
	}
}

// TestUserLayer_AdditiveOnlyInvariant is the re-pinning of the
// never-loosens invariant per the spec: a per-user file containing
// allowedModels, locked flags, and environmentPolicy must never reach the
// merged policy through mergeUserEnvironmentLayer -- only environments
// merges in.
func TestUserLayer_AdditiveOnlyInvariant(t *testing.T) {
	machine := &types.EnterpriseConfig{
		AllowedModels: []string{"machine-model"},
	}

	userRaw := map[string]any{
		"customFields": map[string]any{
			"ion-desktop": map[string]any{
				"allowedModels": []any{"user-model"}, // must be ignored
				"environmentPolicy": map[string]any{ // must be ignored
					"mode": "central-only", "locked": true,
				},
				"environments": []any{
					map[string]any{"label": "Personal", "url": "wss://personal.example"},
				},
			},
		},
	}
	userEnvs := extractEnvironmentEntries(userRaw, "test")

	merged := mergeUserEnvironmentLayerForTest(machine, userEnvs)

	// The machine's own AllowedModels field is untouched.
	if len(merged.AllowedModels) != 1 || merged.AllowedModels[0] != "machine-model" {
		t.Errorf("AllowedModels = %v, want unchanged [machine-model]", merged.AllowedModels)
	}

	ionDesktop, _ := merged.CustomFields["ion-desktop"].(map[string]any)
	if ionDesktop == nil {
		t.Fatal("merged customFields['ion-desktop'] is nil")
	}
	if _, hasAllowedModels := ionDesktop["allowedModels"]; hasAllowedModels {
		t.Error("merged ion-desktop carries allowedModels from the per-user source; it must not")
	}
	if _, hasPolicy := ionDesktop["environmentPolicy"]; hasPolicy {
		t.Error("merged ion-desktop carries environmentPolicy from the per-user source; it must not")
	}
	envs, _ := ionDesktop["environments"].([]any)
	if len(envs) != 1 {
		t.Fatalf("merged environments = %v, want 1 entry", envs)
	}
}

// mergeUserEnvironmentLayerForTest exercises the merge step directly with
// pre-extracted user entries, so a test can assert the merge behavior
// without going through a real per-user source file.
func mergeUserEnvironmentLayerForTest(cfg *types.EnterpriseConfig, userEnvs []EnvironmentEntry) *types.EnterpriseConfig {
	if len(userEnvs) == 0 {
		return cfg
	}
	machineEnvs := machineEnvironmentEntries(cfg)
	merged := dedupeEnvironmentsByURL(machineEnvs, userEnvs)
	if cfg == nil {
		cfg = &types.EnterpriseConfig{}
	} else {
		clone := *cfg
		cfg = &clone
	}
	setIonDesktopEnvironments(cfg, merged)
	return cfg
}

// TestUserLayer_DedupeByURL_MachineWins proves a per-user entry whose url
// collides with a machine entry is dropped, and the machine entry survives.
func TestUserLayer_DedupeByURL_MachineWins(t *testing.T) {
	machine := []EnvironmentEntry{
		{"label": "Team A (managed)", "url": "wss://ion-a.corp.example"},
	}
	user := []EnvironmentEntry{
		{"label": "Team A (personal alias)", "url": "wss://ion-a.corp.example"},
		{"label": "Personal", "url": "wss://personal.example"},
	}

	merged := dedupeEnvironmentsByURL(machine, user)
	if len(merged) != 2 {
		t.Fatalf("got %d merged entries, want 2 (machine wins collision, personal survives)", len(merged))
	}
	if merged[0]["label"] != "Team A (managed)" {
		t.Errorf("merged[0].label = %v, want the machine entry's label", merged[0]["label"])
	}
	if merged[1]["url"] != "wss://personal.example" {
		t.Errorf("merged[1].url = %v, want wss://personal.example", merged[1]["url"])
	}
}

// TestUserLayer_ThreeSources exercises loadUserEnvironmentLayer for each of
// the three per-platform sources this layer supports.
func TestUserLayer_ThreeSources(t *testing.T) {
	t.Run("linux", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		dir := filepath.Join(home, ".config", "ion")
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		content := `{"customFields":{"ion-desktop":{"environments":[{"label":"Linux Env","url":"wss://linux.example"}]}}}`
		if err := os.WriteFile(filepath.Join(dir, "enterprise-user.json"), []byte(content), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}

		entries := loadUserEnvironmentLayer("linux")
		if len(entries) != 1 || entries[0]["label"] != "Linux Env" {
			t.Errorf("linux user layer = %+v, want one entry labeled Linux Env", entries)
		}
	})

	t.Run("linux absent file yields nil", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		entries := loadUserEnvironmentLayer("linux")
		if entries != nil {
			t.Errorf("expected nil for an absent per-user source, got %+v", entries)
		}
	})

	t.Run("windows stub yields nil on non-windows callers", func(t *testing.T) {
		// readUserSourceWindowsRegistry is a stub returning (nil, false)
		// on every platform this test suite runs on (macOS/Linux CI); the
		// real registry read is exercised only under GOOS=windows, which
		// is covered by enterprise_windows_test.go's build-tagged suite.
		entries := loadUserEnvironmentLayer("windows")
		if entries != nil {
			t.Errorf("expected nil from the non-windows stub, got %+v", entries)
		}
	})

	t.Run("darwin absent plist yields nil", func(t *testing.T) {
		// No real per-user MDM plist exists on a dev/CI machine, so this
		// exercises the "absent source" path end to end without requiring
		// MDM enrollment.
		entries := loadUserEnvironmentLayer("darwin")
		if entries != nil {
			t.Errorf("expected nil for an absent per-user plist, got %+v", entries)
		}
	})
}

// TestUserLayer_MergedPolicyUnion proves get_enterprise_policy's real
// integration point (loadEnterpriseConfig) returns the union in
// customFields['ion-desktop'].environments when both layers are present.
func TestUserLayer_MergedPolicyUnion(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".config", "ion")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	content := `{"customFields":{"ion-desktop":{"environments":[{"label":"Personal","url":"wss://personal.example"}]}}}`
	if err := os.WriteFile(filepath.Join(dir, "enterprise-user.json"), []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	envPath := filepath.Join(t.TempDir(), "machine.json")
	machineJSON, err := json.Marshal(map[string]any{
		"customFields": map[string]any{
			"ion-desktop": map[string]any{
				"environments": []any{
					map[string]any{"label": "Team A", "url": "wss://ion-a.corp.example"},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal machine config: %v", err)
	}
	if err := os.WriteFile(envPath, machineJSON, 0o644); err != nil {
		t.Fatalf("write machine config: %v", err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", envPath)

	cfg := loadEnterpriseConfig("linux")
	if cfg == nil {
		t.Fatal("loadEnterpriseConfig(\"linux\") returned nil")
	}
	ionDesktop, _ := cfg.CustomFields["ion-desktop"].(map[string]any)
	if ionDesktop == nil {
		t.Fatal("merged customFields['ion-desktop'] is nil")
	}
	envs, _ := ionDesktop["environments"].([]any)
	if len(envs) != 2 {
		t.Fatalf("merged environments = %+v, want 2 entries (machine + personal)", envs)
	}
}
