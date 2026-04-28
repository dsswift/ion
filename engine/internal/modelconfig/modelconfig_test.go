package modelconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestResolveTier_Defaults(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	tests := []struct {
		tier string
		want string
	}{
		{"fast", "claude-haiku-4-5-20251001"},
		{"smart", "claude-sonnet-4-20250514"},
		{"balanced", "claude-sonnet-4-20250514"},
		{"Fast", "claude-haiku-4-5-20251001"},
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

	t.Setenv("HOME", dir)

	got := ResolveTier("fast")
	if got != "gpt-4o-mini" {
		t.Errorf("expected gpt-4o-mini, got %q", got)
	}
}

func TestResolveTier_ConfigChangesWithoutRestart(t *testing.T) {
	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	os.MkdirAll(ionDir, 0o700)
	t.Setenv("HOME", dir)

	// Initially no config file — should use defaults
	got := ResolveTier("fast")
	if got != "claude-haiku-4-5-20251001" {
		t.Errorf("expected default, got %q", got)
	}

	// Write a config file — next call should pick it up
	config := map[string]any{
		"tiers": map[string]any{
			"fast": "claude-haiku-4-5",
		},
	}
	data, _ := json.Marshal(config)
	os.WriteFile(filepath.Join(ionDir, "models.json"), data, 0o644)

	got = ResolveTier("fast")
	if got != "claude-haiku-4-5" {
		t.Errorf("expected claude-haiku-4-5 after config change, got %q", got)
	}

	// Change it again
	config["tiers"] = map[string]any{"fast": "gpt-4o-mini"}
	data, _ = json.Marshal(config)
	os.WriteFile(filepath.Join(ionDir, "models.json"), data, 0o644)

	got = ResolveTier("fast")
	if got != "gpt-4o-mini" {
		t.Errorf("expected gpt-4o-mini after second config change, got %q", got)
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
	t.Setenv("HOME", t.TempDir())

	config := LoadModelsConfig()
	if config == nil {
		t.Fatal("expected non-nil map")
	}
	if len(config) != 0 {
		t.Errorf("expected empty map, got %d entries", len(config))
	}
}

func TestUserModels(t *testing.T) {
	config := map[string]interface{}{
		"providers": map[string]interface{}{
			"anthropic": map[string]interface{}{
				"baseURL": "https://ai.example.com",
				"models": map[string]interface{}{
					"claude-haiku-4-5": map[string]interface{}{
						"contextWindow":  float64(200000),
						"costPer1kInput": 0.0008,
						"supportsCaching": true,
					},
					"claude-sonnet-4-6": map[string]interface{}{
						"contextWindow":    float64(200000),
						"supportsThinking": true,
					},
				},
			},
			"openai": map[string]interface{}{
				"models": map[string]interface{}{
					"gpt-4.1": map[string]interface{}{
						"contextWindow": float64(1047576),
					},
				},
			},
		},
	}

	models := UserModels(config)

	if len(models) != 3 {
		t.Fatalf("expected 3 models, got %d", len(models))
	}

	haiku, ok := models["claude-haiku-4-5"]
	if !ok {
		t.Fatal("expected claude-haiku-4-5")
	}
	if haiku.ProviderID != "anthropic" {
		t.Errorf("expected anthropic provider, got %q", haiku.ProviderID)
	}
	if haiku.ContextWindow != 200000 {
		t.Errorf("expected context window 200000, got %d", haiku.ContextWindow)
	}
	if !haiku.SupportsCaching {
		t.Error("expected supportsCaching=true")
	}

	gpt, ok := models["gpt-4.1"]
	if !ok {
		t.Fatal("expected gpt-4.1")
	}
	if gpt.ProviderID != "openai" {
		t.Errorf("expected openai provider, got %q", gpt.ProviderID)
	}
}

func TestUserModels_Empty(t *testing.T) {
	models := UserModels(map[string]interface{}{})
	if len(models) != 0 {
		t.Errorf("expected 0 models, got %d", len(models))
	}

	models = UserModels(map[string]interface{}{
		"providers": map[string]interface{}{
			"anthropic": map[string]interface{}{
				"baseURL": "https://example.com",
			},
		},
	})
	if len(models) != 0 {
		t.Errorf("expected 0 models when no models section, got %d", len(models))
	}
}
