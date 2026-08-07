package modelconfig

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/types"
)

// LoadModelsConfig reads models.json for every call so external edits take
// effect without an engine restart.
func LoadModelsConfig() map[string]interface{} {
	config, err := loadModelsConfigErr()
	if err != nil {
		return map[string]interface{}{}
	}
	return config
}

// loadModelsConfigErr keeps read-only callers tolerant while giving mutations
// enough information to refuse replacing a corrupt or unreadable config file.
// A missing file is an intentional empty configuration and may be created.
func loadModelsConfigErr() (map[string]interface{}, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("resolve home directory: %w", err)
	}
	path := filepath.Join(home, ".ion", "models.json")
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]interface{}{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var config map[string]interface{}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return config, nil
}

// AvailableProviders returns configured providers plus those detected from
// known credential environment variables.
func AvailableProviders(providerConfigs map[string]types.ProviderConfig) []string {
	var available []string
	seen := make(map[string]bool)
	for name, cfg := range providerConfigs {
		if cfg.APIKey != "" {
			available = append(available, name)
			seen[name] = true
		}
	}
	for provider, envVar := range providerEnvVars {
		if !seen[provider] && os.Getenv(envVar) != "" {
			available = append(available, provider)
		}
	}
	return available
}

// InitializeProviders combines explicit provider configuration with detected
// credentials for known providers.
func InitializeProviders(providerConfigs map[string]types.ProviderConfig) map[string]types.ProviderConfig {
	result := make(map[string]types.ProviderConfig)
	for name, cfg := range providerConfigs {
		result[name] = cfg
	}
	for provider, envVar := range providerEnvVars {
		if _, exists := result[provider]; !exists && os.Getenv(envVar) != "" {
			result[provider] = types.ProviderConfig{APIKey: os.Getenv(envVar)}
		}
	}
	return result
}
