package modelconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestResolveTier_Defaults(t *testing.T) {
	ResetModelsConfig()
	t.Setenv("HOME", t.TempDir())

	tests := []struct {
		tier string
		want string
	}{
		{"fast", "claude-3-5-haiku-latest"},
		{"smart", "claude-sonnet-4-20250514"},
		{"balanced", "claude-sonnet-4-20250514"},
		{"Fast", "claude-3-5-haiku-latest"},
	}

	for _, tt := range tests {
		t.Run(tt.tier, func(t *testing.T) {
			got := ResolveTier(tt.tier)
			if got != tt.want {
				t.Errorf("ResolveTier(%q) = %q, want %q", tt.tier, got, tt.want)
			}
		})
	}
}

func TestResolveTier_PassThrough(t *testing.T) {
	ResetModelsConfig()
	t.Setenv("HOME", t.TempDir())

	model := "claude-3-opus-20240229"
	got := ResolveTier(model)
	if got != model {
		t.Errorf("expected passthrough, got %q", got)
	}
}

func TestResolveTier_CustomConfig(t *testing.T) {
	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	os.MkdirAll(ionDir, 0o700)

	config := map[string]any{
		"tiers": map[string]any{
			"fast": "gpt-4o-mini",
		},
	}
	data, _ := json.Marshal(config)
	os.WriteFile(filepath.Join(ionDir, "models.json"), data, 0o644)

	ResetModelsConfig()
	t.Setenv("HOME", dir)

	got := ResolveTier("fast")
	if got != "gpt-4o-mini" {
		t.Errorf("expected gpt-4o-mini, got %q", got)
	}
}

func TestAvailableProviders_EnvOnly(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("OPENAI_API_KEY", "")

	providers := AvailableProviders(nil)
	found := false
	for _, p := range providers {
		if p == "anthropic" {
			found = true
		}
		if p == "openai" {
			t.Error("openai should not be available without key")
		}
	}
	if !found {
		t.Error("expected anthropic to be available")
	}
}

func TestAvailableProviders_ConfigOverride(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")

	configs := map[string]types.ProviderConfig{
		"anthropic": {APIKey: "from-config"},
	}

	providers := AvailableProviders(configs)
	found := false
	for _, p := range providers {
		if p == "anthropic" {
			found = true
		}
	}
	if !found {
		t.Error("expected anthropic from config")
	}
}

func TestInitializeProviders(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "env-key")
	t.Setenv("OPENAI_API_KEY", "")

	configs := map[string]types.ProviderConfig{
		"custom": {APIKey: "custom-key", BaseURL: "https://example.com"},
	}

	result := InitializeProviders(configs)

	if _, ok := result["custom"]; !ok {
		t.Error("expected custom provider")
	}
	if _, ok := result["anthropic"]; !ok {
		t.Error("expected anthropic from env")
	}
	if p, ok := result["anthropic"]; ok && p.APIKey != "env-key" {
		t.Errorf("expected env-key, got %q", p.APIKey)
	}
}

func TestLoadModelsConfig_Missing(t *testing.T) {
	ResetModelsConfig()
	t.Setenv("HOME", t.TempDir())

	config := LoadModelsConfig()
	if config == nil {
		t.Fatal("expected non-nil map")
	}
	if len(config) != 0 {
		t.Errorf("expected empty map, got %d entries", len(config))
	}
}
