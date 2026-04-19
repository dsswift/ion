package config

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// DefaultConfig returns the baseline engine configuration.
func DefaultConfig() *types.EngineRuntimeConfig {
	maxTurns := 50
	maxBudget := 10.0
	idleTimeout := int64(300000)
	return &types.EngineRuntimeConfig{
		Backend:      "api",
		DefaultModel: "claude-sonnet-4-6",
		Providers:    make(map[string]types.ProviderConfig),
		Limits: types.LimitsConfig{
			MaxTurns:      &maxTurns,
			MaxBudgetUsd:  &maxBudget,
			IdleTimeoutMs: &idleTimeout,
		},
		McpServers: make(map[string]types.McpServerConfig),
		Profiles:   nil,
	}
}

// LoadConfig loads the full engine configuration with layered precedence.
//
// Layers (highest to lowest priority):
//  1. Enterprise (MDM/system) -- sealed, immutable from below
//  2. Project config (.ion/engine.json in projectDir)
//  3. User global config (~/.ion/engine.json)
//  4. Defaults
func LoadConfig(projectDir string) *types.EngineRuntimeConfig {
	defaults := DefaultConfig()
	defaults.Profiles = loadProfiles()

	// Load global ~/.ion/engine.json
	globalConfig := loadJSONConfig(globalConfigPath())

	// Resolve provider API keys from env
	resolveEnvProviders(globalConfig)

	// Load project-level .ion/engine.json
	var projectConfig map[string]any
	if projectDir != "" {
		projectConfig = loadJSONConfig(filepath.Join(projectDir, ".ion", "engine.json"))
	}

	// Merge: defaults < global < project
	merged := MergeConfigs(nil, defaults, fromMap(globalConfig), fromMap(projectConfig))

	// Load and enforce enterprise config
	enterprise := LoadEnterpriseConfig()
	if enterprise != nil {
		merged = EnforceEnterprise(merged, enterprise)
	}

	return merged
}

// FindProfile searches loaded profiles by name or ID.
func FindProfile(name string, config *types.EngineRuntimeConfig) *types.EngineProfileConfig {
	if config == nil {
		return nil
	}
	for i := range config.Profiles {
		if config.Profiles[i].Name == name || config.Profiles[i].ID == name {
			return &config.Profiles[i]
		}
	}
	return nil
}

// ExpandTilde replaces a leading ~ with the user's home directory.
func ExpandTilde(path string) string {
	if len(path) == 0 || path[0] != '~' {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return home + path[1:]
}

func globalConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ion", "engine.json")
}

func settingsPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ion", "settings.json")
}

func loadProfiles() []types.EngineProfileConfig {
	data, err := os.ReadFile(settingsPath())
	if err != nil {
		return nil
	}
	var raw struct {
		EngineProfiles  []types.EngineProfileConfig `json:"engineProfiles"`
		HarnessProfiles []types.EngineProfileConfig `json:"harnessProfiles"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	if len(raw.EngineProfiles) > 0 {
		return raw.EngineProfiles
	}
	return raw.HarnessProfiles
}

func loadJSONConfig(path string) map[string]any {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		utils.Log("Config", "failed to parse "+path+": "+err.Error())
		return nil
	}
	return m
}

func resolveEnvProviders(cfg map[string]any) {
	if cfg == nil {
		return
	}
	providers, _ := cfg["providers"].(map[string]any)
	if providers == nil {
		providers = make(map[string]any)
		cfg["providers"] = providers
	}

	if anthropic, _ := providers["anthropic"].(map[string]any); anthropic == nil || anthropic["apiKey"] == nil {
		if key := os.Getenv("ANTHROPIC_API_KEY"); key != "" {
			if anthropic == nil {
				anthropic = make(map[string]any)
			}
			anthropic["apiKey"] = key
			providers["anthropic"] = anthropic
		}
	}

	if openai, _ := providers["openai"].(map[string]any); openai == nil || openai["apiKey"] == nil {
		if key := os.Getenv("OPENAI_API_KEY"); key != "" {
			if openai == nil {
				openai = make(map[string]any)
			}
			openai["apiKey"] = key
			providers["openai"] = openai
		}
	}
}

// fromMap converts a generic JSON map to an EngineRuntimeConfig via re-marshaling.
// Returns nil if the input is nil or conversion fails.
func fromMap(m map[string]any) *types.EngineRuntimeConfig {
	if m == nil {
		return nil
	}
	data, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	var cfg types.EngineRuntimeConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil
	}
	return &cfg
}
