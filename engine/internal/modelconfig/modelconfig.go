// Package modelconfig loads model configuration from disk and resolves
// tier aliases to concrete model identifiers.
package modelconfig

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

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

// Default tier mappings. Empty by design: the engine ships no model opinions.
// Users define their own tiers in ~/.ion/models.json under the "tiers" key.
var defaultTiers = map[string]string{}

// LoadModelsConfig reads the models configuration from ~/.ion/models.json.
// The file is read on every call so that changes take effect without
// restarting the engine (the file is tiny — typically <1KB).
func LoadModelsConfig() map[string]interface{} {
	return loadModelsFile()
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
//
// Tier values in models.json may be either a bare string or an object of
// the shape {"model": "...", "fallbacks": [...]}. This function returns only
// the primary model. Use ResolveTierChain to also retrieve the fallback list.
func ResolveTier(tierName string) string {
	model, _ := ResolveTierChain(tierName)
	return model
}

// ResolveTierChain returns the primary model for a tier plus the configured
// fallback chain. Tier values in models.json may be a bare string (no
// fallbacks) or an object {"model": "...", "fallbacks": ["...", "..."]}.
// If tierName is not a recognized tier, it is returned as-is and fallbacks
// is nil — the input is assumed to be a model name already.
func ResolveTierChain(tierName string) (string, []string) {
	lower := strings.ToLower(tierName)

	config := LoadModelsConfig()
	tiers, ok := config["tiers"].(map[string]interface{})
	if !ok {
		if model, ok := defaultTiers[lower]; ok {
			return model, nil
		}
		return tierName, nil
	}

	switch v := tiers[lower].(type) {
	case string:
		return v, nil
	case map[string]interface{}:
		model, _ := v["model"].(string)
		if model == "" {
			break
		}
		var fallbacks []string
		if arr, ok := v["fallbacks"].([]interface{}); ok {
			fallbacks = make([]string, 0, len(arr))
			for _, item := range arr {
				if s, ok := item.(string); ok && s != "" {
					fallbacks = append(fallbacks, s)
				}
			}
		}
		return model, fallbacks
	}

	if model, ok := defaultTiers[lower]; ok {
		return model, nil
	}
	return tierName, nil
}

// UserModels extracts user-defined model entries from the models.json config.
// Returns a map of model name → ModelInfo for every model listed under the
// providers section. This lets callers register user model aliases (e.g.
// "claude-haiku-4-5") into the engine's model registry so they resolve to
// the correct provider without relying on prefix matching.
func UserModels(config map[string]interface{}) map[string]types.ModelInfo {
	result := make(map[string]types.ModelInfo)

	providersRaw, ok := config["providers"].(map[string]interface{})
	if !ok {
		return result
	}

	for providerName, providerRaw := range providersRaw {
		providerMap, ok := providerRaw.(map[string]interface{})
		if !ok {
			continue
		}
		modelsRaw, ok := providerMap["models"].(map[string]interface{})
		if !ok {
			continue
		}
		for modelName, modelRaw := range modelsRaw {
			info := types.ModelInfo{ProviderID: providerName}
			if m, ok := modelRaw.(map[string]interface{}); ok {
				if v, ok := m["contextWindow"].(float64); ok {
					info.ContextWindow = int(v)
				}
				if v, ok := m["costPer1kInput"].(float64); ok {
					info.CostPer1kInput = v
				}
				if v, ok := m["costPer1kOutput"].(float64); ok {
					info.CostPer1kOutput = v
				}
				if v, ok := m["supportsCaching"].(bool); ok {
					info.SupportsCaching = v
				}
				if v, ok := m["supportsThinking"].(bool); ok {
					info.SupportsThinking = v
				}
				if v, ok := m["supportsImages"].(bool); ok {
					info.SupportsImages = v
				}
				if v, ok := m["thinkingMode"].(string); ok {
					info.ThinkingMode = v
				}
				if v, ok := m["thinkingEfforts"].([]interface{}); ok {
					efforts := make([]string, 0, len(v))
					for _, e := range v {
						if s, ok := e.(string); ok {
							efforts = append(efforts, s)
						}
					}
					info.ThinkingEfforts = efforts
				}
			}
			result[modelName] = info
		}
	}

	return result
}
