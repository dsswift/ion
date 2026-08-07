// Package modelconfig loads model configuration from disk and resolves
// tier aliases to concrete model identifiers.
package modelconfig

import (
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
				if v, ok := m["costPer1kCacheCreation"].(float64); ok {
					info.CostPer1kCacheCreation = v
				}
				if v, ok := m["costPer1kCacheRead"].(float64); ok {
					info.CostPer1kCacheRead = v
				}
				if v, ok := m["maxOutputTokens"].(float64); ok {
					info.MaxOutputTokens = int(v)
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
				if v, ok := m["modelKind"].(string); ok {
					info.ModelKind = v
				}
				if v, ok := m["dialect"].(string); ok {
					info.Dialect = v
				}
				if v, ok := m["costPerImage"].(float64); ok {
					info.CostPerImage = v
				}
			}
			result[modelName] = info
		}
	}

	return result
}
