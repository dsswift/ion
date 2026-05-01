package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

func TestLoadConfig_WithFiles(t *testing.T) {
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}

	projectCfg := map[string]any{
		"defaultModel": "claude-opus-4",
		"limits": map[string]any{
			"maxTurns": 200,
		},
	}
	data, _ := json.Marshal(projectCfg)
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	if cfg.DefaultModel != "claude-opus-4" {
		t.Fatalf("expected defaultModel=claude-opus-4, got %q", cfg.DefaultModel)
	}
	if cfg.Limits.MaxTurns == nil || *cfg.Limits.MaxTurns != 200 {
		t.Fatalf("expected maxTurns=200, got %v", cfg.Limits.MaxTurns)
	}
	// Defaults should still apply for non-overridden fields
	if cfg.Backend != "api" {
		t.Fatalf("expected backend=api, got %q", cfg.Backend)
	}
}

func TestLoadConfig_NoProjectDir(t *testing.T) {
	cfg := LoadConfig("")
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.Backend != "api" {
		t.Fatalf("expected default backend=api, got %q", cfg.Backend)
	}
}

func TestLoadConfig_MissingProjectDir(t *testing.T) {
	cfg := LoadConfig("/nonexistent/path/that/does/not/exist")
	if cfg == nil {
		t.Fatal("expected non-nil config")
	}
	if cfg.Backend != "api" {
		t.Fatalf("expected default backend=api, got %q", cfg.Backend)
	}
}

func TestLoadConfig_MalformedJSON(t *testing.T) {
	// Isolate HOME so a contributor's real ~/.ion/engine.json does not bleed
	// into the merged config and override the defaults this test asserts on.
	t.Setenv("HOME", t.TempDir())
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), []byte("{not valid json!!!"), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	// Should return defaults when JSON is malformed
	if cfg.Backend != "api" {
		t.Fatalf("expected default backend=api, got %q", cfg.Backend)
	}
	if cfg.DefaultModel != "claude-sonnet-4-6" {
		t.Fatalf("expected default model, got %q", cfg.DefaultModel)
	}
	// Defaults ship unopinionated -- limits remain unset.
	if cfg.Limits.MaxTurns != nil {
		t.Fatalf("expected default MaxTurns=nil, got %v", *cfg.Limits.MaxTurns)
	}
}

func TestLoadConfig_PartialOverride(t *testing.T) {
	// Isolate from the developer's real ~/.ion/engine.json so the test
	// is deterministic on CI where no home config exists.
	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)

	// Write a known global config that provides maxBudgetUsd.
	globalIonDir := filepath.Join(fakeHome, ".ion")
	if err := os.MkdirAll(globalIonDir, 0o755); err != nil {
		t.Fatal(err)
	}
	globalData, _ := json.Marshal(map[string]any{
		"limits": map[string]any{"maxBudgetUsd": 10},
	})
	if err := os.WriteFile(filepath.Join(globalIonDir, "engine.json"), globalData, 0o644); err != nil {
		t.Fatal(err)
	}

	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Only override maxTurns at the project level.
	data, _ := json.Marshal(map[string]any{
		"limits": map[string]any{"maxTurns": 5},
	})
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	if cfg.Limits.MaxTurns == nil || *cfg.Limits.MaxTurns != 5 {
		t.Fatalf("expected maxTurns=5, got %v", cfg.Limits.MaxTurns)
	}
	if cfg.Limits.MaxBudgetUsd == nil || *cfg.Limits.MaxBudgetUsd != 10 {
		t.Fatalf("expected maxBudgetUsd=10, got %v", cfg.Limits.MaxBudgetUsd)
	}
	if cfg.Backend != "api" {
		t.Fatalf("expected backend=api, got %q", cfg.Backend)
	}
}

func TestLoadConfig_WithBackendAndModel(t *testing.T) {
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{
		"backend":      "cli",
		"defaultModel": "claude-opus-4-6",
	})
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	if cfg.Backend != "cli" {
		t.Fatalf("expected backend=cli, got %q", cfg.Backend)
	}
	if cfg.DefaultModel != "claude-opus-4-6" {
		t.Fatalf("expected defaultModel=claude-opus-4-6, got %q", cfg.DefaultModel)
	}
}

func TestLoadConfig_EmptyJSON(t *testing.T) {
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	// Empty JSON should result in defaults
	if cfg.Backend != "api" {
		t.Fatalf("expected backend=api, got %q", cfg.Backend)
	}
	if cfg.DefaultModel != "claude-sonnet-4-6" {
		t.Fatalf("expected default model, got %q", cfg.DefaultModel)
	}
}

func TestLoadConfig_McpServers(t *testing.T) {
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{
		"mcpServers": map[string]any{
			"test-server": map[string]any{
				"type":    "stdio",
				"command": "test-cmd",
				"args":    []string{"--flag"},
			},
		},
	})
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	srv, ok := cfg.McpServers["test-server"]
	if !ok {
		t.Fatal("expected test-server in MCP servers")
	}
	if srv.Type != "stdio" {
		t.Fatalf("expected type=stdio, got %q", srv.Type)
	}
	if srv.Command != "test-cmd" {
		t.Fatalf("expected command=test-cmd, got %q", srv.Command)
	}
	if len(srv.Args) != 1 || srv.Args[0] != "--flag" {
		t.Fatalf("expected args=[--flag], got %v", srv.Args)
	}
}

func TestLoadConfig_Providers(t *testing.T) {
	projectDir := t.TempDir()
	ionDir := filepath.Join(projectDir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(map[string]any{
		"providers": map[string]any{
			"anthropic": map[string]any{
				"baseURL": "https://custom.api.com",
			},
		},
	})
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	cfg := LoadConfig(projectDir)
	if cfg.Providers["anthropic"].BaseURL != "https://custom.api.com" {
		t.Fatalf("expected custom baseURL, got %q", cfg.Providers["anthropic"].BaseURL)
	}
}

// ---------------------------------------------------------------------------
// Enterprise config loading
// ---------------------------------------------------------------------------

func TestLoadEnterpriseConfig_EnvVar(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "enterprise.json")

	enterprise := types.EnterpriseConfig{
		AllowedModels: []string{"claude-sonnet-4-6"},
		BlockedModels: []string{"gpt-4"},
	}
	data, _ := json.Marshal(enterprise)
	if err := os.WriteFile(cfgPath, data, 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("ION_ENTERPRISE_CONFIG", cfgPath)

	cfg := LoadEnterpriseConfig()
	if cfg == nil {
		t.Fatal("expected enterprise config from env var")
	}
	if len(cfg.AllowedModels) != 1 || cfg.AllowedModels[0] != "claude-sonnet-4-6" {
		t.Fatalf("unexpected allowedModels: %v", cfg.AllowedModels)
	}
}

func TestLoadEnterpriseConfig_MissingEnvVar(t *testing.T) {
	t.Setenv("ION_ENTERPRISE_CONFIG", "/nonexistent/path.json")

	cfg := loadEnterpriseConfig("unsupported")
	if cfg != nil {
		t.Fatal("expected nil for unsupported platform with missing env var")
	}
}

func TestLoadEnterpriseConfig_UnsupportedPlatform(t *testing.T) {
	// No env var set -- unset it to be sure
	t.Setenv("ION_ENTERPRISE_CONFIG", "")
	cfg := loadEnterpriseConfig("freebsd")
	if cfg != nil {
		t.Fatal("expected nil for unsupported platform")
	}
}

func TestLoadEnterpriseConfig_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(cfgPath, []byte("{not valid json"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", cfgPath)

	cfg := loadEnterpriseConfig("unsupported")
	if cfg != nil {
		t.Fatal("expected nil for invalid JSON enterprise config")
	}
}

func TestLoadEnterpriseConfig_EnvVarPriorityOverPlatform(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "env-priority.json")
	enterprise := types.EnterpriseConfig{
		AllowedModels: []string{"from-env"},
	}
	data, _ := json.Marshal(enterprise)
	if err := os.WriteFile(cfgPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", cfgPath)

	// Even on unsupported platform, env var should work
	cfg := loadEnterpriseConfig("unsupported")
	if cfg == nil {
		t.Fatal("expected config from env var")
	}
	if len(cfg.AllowedModels) != 1 || cfg.AllowedModels[0] != "from-env" {
		t.Fatalf("expected from-env, got %v", cfg.AllowedModels)
	}
}

func TestLoadEnterpriseConfig_FullConfig(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "full-enterprise.json")

	enterprise := types.EnterpriseConfig{
		AllowedModels:    []string{"claude-sonnet-4-6"},
		BlockedModels:    []string{"gpt-4"},
		AllowedProviders: []string{"anthropic"},
		McpAllowlist:     []string{"safe-server"},
		McpDenylist:      []string{"bad-server"},
		ToolRestrictions: &types.ToolRestrictions{
			Allow: []string{"Read", "Write"},
			Deny:  []string{"Bash"},
		},
		Telemetry: &types.TelemetryConfig{
			Enabled:      true,
			Targets:      []string{"https://telemetry.corp"},
			PrivacyLevel: "full",
		},
		Network: &types.NetworkConfig{
			Proxy: &types.ProxyConfig{
				HttpsProxy: "http://proxy:8080",
			},
			CustomCaCerts: []string{"/ca.pem"},
		},
	}
	data, _ := json.Marshal(enterprise)
	if err := os.WriteFile(cfgPath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", cfgPath)

	cfg := LoadEnterpriseConfig()
	if cfg == nil {
		t.Fatal("expected full enterprise config")
	}
	if len(cfg.AllowedModels) != 1 {
		t.Fatal("expected 1 allowed model")
	}
	if len(cfg.BlockedModels) != 1 {
		t.Fatal("expected 1 blocked model")
	}
	if len(cfg.AllowedProviders) != 1 {
		t.Fatal("expected 1 allowed provider")
	}
	if cfg.ToolRestrictions == nil {
		t.Fatal("expected tool restrictions")
	}
	if cfg.Telemetry == nil || !cfg.Telemetry.Enabled {
		t.Fatal("expected telemetry enabled")
	}
	if cfg.Network == nil || cfg.Network.Proxy == nil {
		t.Fatal("expected network config with proxy")
	}
}

func TestLoadEnterpriseConfig_EmptyJSON(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "empty-enterprise.json")
	if err := os.WriteFile(cfgPath, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ION_ENTERPRISE_CONFIG", cfgPath)

	cfg := LoadEnterpriseConfig()
	if cfg == nil {
		t.Fatal("expected non-nil config for empty JSON")
	}
	if len(cfg.AllowedModels) != 0 {
		t.Fatal("expected no allowed models")
	}
}

// ---------------------------------------------------------------------------
// Environment variable provider resolution
// ---------------------------------------------------------------------------

func TestResolveEnvProviders_AnthropicKey(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-test-key")

	cfg := make(map[string]any)
	resolveEnvProviders(cfg)

	providers, ok := cfg["providers"].(map[string]any)
	if !ok {
		t.Fatal("expected providers map")
	}
	anthropic, ok := providers["anthropic"].(map[string]any)
	if !ok {
		t.Fatal("expected anthropic provider")
	}
	if anthropic["apiKey"] != "sk-ant-test-key" {
		t.Fatalf("expected sk-ant-test-key, got %v", anthropic["apiKey"])
	}
}

func TestResolveEnvProviders_OpenAIKey(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "sk-oai-test-key")

	cfg := make(map[string]any)
	resolveEnvProviders(cfg)

	providers, ok := cfg["providers"].(map[string]any)
	if !ok {
		t.Fatal("expected providers map")
	}
	openai, ok := providers["openai"].(map[string]any)
	if !ok {
		t.Fatal("expected openai provider")
	}
	if openai["apiKey"] != "sk-oai-test-key" {
		t.Fatalf("expected sk-oai-test-key, got %v", openai["apiKey"])
	}
}

func TestResolveEnvProviders_DoesNotOverrideExistingKey(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "env-key")

	cfg := map[string]any{
		"providers": map[string]any{
			"anthropic": map[string]any{
				"apiKey": "config-key",
			},
		},
	}
	resolveEnvProviders(cfg)

	providers := cfg["providers"].(map[string]any)
	anthropic := providers["anthropic"].(map[string]any)
	if anthropic["apiKey"] != "config-key" {
		t.Fatalf("expected config-key to be preserved, got %v", anthropic["apiKey"])
	}
}

func TestResolveEnvProviders_NilConfig(t *testing.T) {
	// Should not panic
	resolveEnvProviders(nil)
}

func TestResolveEnvProviders_NoEnvVars(t *testing.T) {
	// Unset both
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	os.Unsetenv("ANTHROPIC_API_KEY")
	os.Unsetenv("OPENAI_API_KEY")

	cfg := make(map[string]any)
	resolveEnvProviders(cfg)

	providers, _ := cfg["providers"].(map[string]any)
	if providers == nil {
		t.Fatal("expected providers map to exist")
	}
	// No anthropic or openai should be added
	if _, ok := providers["anthropic"]; ok {
		t.Fatal("did not expect anthropic provider without env var")
	}
	if _, ok := providers["openai"]; ok {
		t.Fatal("did not expect openai provider without env var")
	}
}

// ---------------------------------------------------------------------------
// fromMap
// ---------------------------------------------------------------------------

func TestLoadJSONConfig_MissingFile(t *testing.T) {
	result := loadJSONConfig("/nonexistent/path/config.json")
	if result != nil {
		t.Fatal("expected nil for missing file")
	}
}

func TestLoadJSONConfig_ValidFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	data, _ := json.Marshal(map[string]any{"key": "value"})
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}

	result := loadJSONConfig(path)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result["key"] != "value" {
		t.Fatalf("expected key=value, got %v", result["key"])
	}
}

func TestLoadJSONConfig_MalformedFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(path, []byte("{invalid json}"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := loadJSONConfig(path)
	if result != nil {
		t.Fatal("expected nil for malformed JSON")
	}
}

func TestLoadJSONConfig_EmptyFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "empty.json")
	if err := os.WriteFile(path, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}

	result := loadJSONConfig(path)
	if result != nil {
		t.Fatal("expected nil for empty file")
	}
}

// ---------------------------------------------------------------------------
// mergeEnterprisePartial
// ---------------------------------------------------------------------------

func TestReadJSONFile_Valid(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.json")
	enterprise := types.EnterpriseConfig{AllowedModels: []string{"test"}}
	data, _ := json.Marshal(enterprise)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}

	result := readJSONFile[types.EnterpriseConfig](path)
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if len(result.AllowedModels) != 1 {
		t.Fatal("expected 1 allowed model")
	}
}

func TestReadJSONFile_MissingFile(t *testing.T) {
	result := readJSONFile[types.EnterpriseConfig]("/nonexistent.json")
	if result != nil {
		t.Fatal("expected nil for missing file")
	}
}

func TestReadJSONFile_InvalidJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(path, []byte("{bad}"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := readJSONFile[types.EnterpriseConfig](path)
	if result != nil {
		t.Fatal("expected nil for invalid JSON")
	}
}

// ---------------------------------------------------------------------------
// contains helper
// ---------------------------------------------------------------------------
