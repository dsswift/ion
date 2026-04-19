// Package modelconfig loads model configuration from disk and resolves
// tier aliases to concrete model identifiers.
package modelconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
)

// Known provider env var names for auto-detection.
var providerEnvVars = map[string]string{
	"anthropic": "ANTHROPIC_API_KEY",
	"openai":    "OPENAI_API_KEY",
	"google":    "GOOGLE_API_KEY",
	"azure":     "AZURE_OPENAI_API_KEY",
	"groq":      "GROQ_API_KEY",
	"mistral":   "MISTRAL_API_KEY",
	"cohere":    "COHERE_API_KEY",
	"aws":       "AWS_ACCESS_KEY_ID",
}

// Default tier mappings.
var defaultTiers = map[string]string{
	"fast":     "claude-3-5-haiku-latest",
	"smart":    "claude-sonnet-4-20250514",
	"balanced": "claude-sonnet-4-20250514",
}

var (
	modelsConfig     map[string]interface{}
	modelsConfigOnce sync.Once
)

// LoadModelsConfig reads the models configuration from ~/.ion/models.json.
// Returns an empty map if the file does not exist or cannot be parsed.
func LoadModelsConfig() map[string]interface{} {
	modelsConfigOnce.Do(func() {
		modelsConfig = loadModelsFile()
	})
	return modelsConfig
}

func loadModelsFile() map[string]interface{} {
	home, err := os.UserHomeDir()
	if err != nil {
		return make(map[string]interface{})
	}

	path := filepath.Join(home, ".ion", "models.json")
	data, err := os.ReadFile(path)
	if err != nil {
		return make(map[string]interface{})
	}

	var config map[string]interface{}
	if err := json.Unmarshal(data, &config); err != nil {
		return make(map[string]interface{})
	}
	return config
}

// AvailableProviders returns the list of providers that have API keys available,
// either through environment variables or the provided config.
func AvailableProviders(providerConfigs map[string]types.ProviderConfig) []string {
	var available []string
	seen := make(map[string]bool)

	// Check configured providers first.
	for name, cfg := range providerConfigs {
		if cfg.APIKey != "" {
			available = append(available, name)
			seen[name] = true
		}
	}

	// Check environment variables for known providers.
	for provider, envVar := range providerEnvVars {
		if seen[provider] {
			continue
		}
		if os.Getenv(envVar) != "" {
			available = append(available, provider)
		}
	}

	return available
}

// InitializeProviders checks each known provider for available credentials
// and returns those that are accessible.
func InitializeProviders(providerConfigs map[string]types.ProviderConfig) map[string]types.ProviderConfig {
	result := make(map[string]types.ProviderConfig)

	// Include all explicitly configured providers.
	for name, cfg := range providerConfigs {
		result[name] = cfg
	}

	// Auto-detect providers from environment.
	for provider, envVar := range providerEnvVars {
		if _, exists := result[provider]; exists {
			continue
		}
		if key := os.Getenv(envVar); key != "" {
			result[provider] = types.ProviderConfig{APIKey: key}
		}
	}

	return result
}

// ResolveTier maps a tier name to a concrete model identifier.
// If tierName is not a recognized tier, it is returned as-is (assumed to be
// a model name already).
func ResolveTier(tierName string) string {
	lower := strings.ToLower(tierName)

	// Check custom tiers from models.json.
	config := LoadModelsConfig()
	if tiers, ok := config["tiers"].(map[string]interface{}); ok {
		if model, ok := tiers[lower].(string); ok {
			return model
		}
	}

	// Fall back to defaults.
	if model, ok := defaultTiers[lower]; ok {
		return model
	}

	return tierName
}

// ResetModelsConfig clears the cached models config, forcing a reload on
// the next call to LoadModelsConfig. Used in tests.
func ResetModelsConfig() {
	modelsConfigOnce = sync.Once{}
	modelsConfig = nil
}
