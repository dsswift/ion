package providers

import (
	"context"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
)

// LlmProvider streams LLM responses in canonical (Anthropic SSE) format.
type LlmProvider interface {
	ID() string
	Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error)
}

var (
	providerRegistry = make(map[string]LlmProvider)
	modelRegistry    = make(map[string]types.ModelInfo)
	mu               sync.RWMutex
)

// RegisterProvider adds a provider to the global registry.
func RegisterProvider(p LlmProvider) {
	mu.Lock()
	defer mu.Unlock()
	providerRegistry[p.ID()] = p
}

// GetProvider returns a registered provider by ID.
func GetProvider(id string) LlmProvider {
	mu.RLock()
	defer mu.RUnlock()
	return providerRegistry[id]
}

// ResolveProvider finds the provider for a given model name using model registry
// lookup followed by prefix matching.
func ResolveProvider(model string) LlmProvider {
	mu.RLock()
	defer mu.RUnlock()

	// Check model registry first
	if info, ok := modelRegistry[model]; ok {
		return providerRegistry[info.ProviderID]
	}

	// Prefix matching
	switch {
	case strings.HasPrefix(model, "claude-") || strings.HasPrefix(model, "claude_"):
		return providerRegistry["anthropic"]
	case strings.HasPrefix(model, "gpt-") || strings.HasPrefix(model, "o1") || strings.HasPrefix(model, "o3") || strings.HasPrefix(model, "o4"):
		return providerRegistry["openai"]
	case strings.HasPrefix(model, "gemini-"):
		return providerRegistry["google"]
	case strings.HasPrefix(model, "mistral") || strings.HasPrefix(model, "mixtral"):
		return providerRegistry["mistral"]
	case strings.HasPrefix(model, "llama") || strings.HasPrefix(model, "meta-llama"):
		if p := providerRegistry["groq"]; p != nil {
			return p
		}
		return providerRegistry["together"]
	case strings.HasPrefix(model, "deepseek"):
		return providerRegistry["deepseek"]
	case strings.HasPrefix(model, "grok"):
		return providerRegistry["xai"]
	case strings.Contains(model, "amazon.") || strings.Contains(model, "anthropic.") || strings.Contains(model, "meta."):
		return providerRegistry["bedrock"]
	}

	return nil
}

// GetModelInfo returns metadata for a registered model.
func GetModelInfo(model string) *types.ModelInfo {
	mu.RLock()
	defer mu.RUnlock()
	if info, ok := modelRegistry[model]; ok {
		return &info
	}
	return nil
}

// RegisterModel adds a model to the global model registry.
func RegisterModel(model string, info types.ModelInfo) {
	mu.Lock()
	defer mu.Unlock()
	modelRegistry[model] = info
}

// ProviderNameForModel returns the provider ID for a given model name.
// Uses the model registry first, then falls back to prefix matching.
// Returns empty string if no provider can be determined.
func ProviderNameForModel(model string) string {
	mu.RLock()
	defer mu.RUnlock()

	if info, ok := modelRegistry[model]; ok {
		return info.ProviderID
	}

	switch {
	case strings.HasPrefix(model, "claude-") || strings.HasPrefix(model, "claude_"):
		return "anthropic"
	case strings.HasPrefix(model, "gpt-") || strings.HasPrefix(model, "o1") || strings.HasPrefix(model, "o3") || strings.HasPrefix(model, "o4"):
		return "openai"
	case strings.HasPrefix(model, "gemini-"):
		return "google"
	case strings.HasPrefix(model, "mistral") || strings.HasPrefix(model, "mixtral"):
		return "mistral"
	case strings.HasPrefix(model, "deepseek"):
		return "deepseek"
	case strings.HasPrefix(model, "grok"):
		return "xai"
	case strings.Contains(model, "amazon.") || strings.Contains(model, "anthropic.") || strings.Contains(model, "meta."):
		return "bedrock"
	}
	return ""
}

// SetProviderKey stores a resolved API key for a provider. Provider
// implementations read this when constructing HTTP requests.
func SetProviderKey(providerID, key string) {
	mu.Lock()
	defer mu.Unlock()
	if providerKeys == nil {
		providerKeys = make(map[string]string)
	}
	providerKeys[providerID] = key
}

// GetProviderKey returns a previously stored API key for the given provider.
func GetProviderKey(providerID string) string {
	mu.RLock()
	defer mu.RUnlock()
	if providerKeys == nil {
		return ""
	}
	return providerKeys[providerID]
}

// ApplyConfig re-registers providers that have config overrides (baseURL,
// authHeader, etc.). Call after loading engine config.
func ApplyConfig(configs map[string]types.ProviderConfig) {
	for name, cfg := range configs {
		opts := &ProviderOptions{
			APIKey:     cfg.APIKey,
			BaseURL:    cfg.BaseURL,
			AuthHeader: cfg.AuthHeader,
		}
		switch name {
		case "anthropic":
			RegisterProvider(NewAnthropicProvider(opts))
		case "openai":
			RegisterProvider(NewOpenAIProvider(opts))
		case "google":
			RegisterProvider(NewGoogleProvider(opts))
		}
	}
}

var providerKeys map[string]string

// ResetRegistries clears both registries. Used for testing only.
func ResetRegistries() {
	mu.Lock()
	defer mu.Unlock()
	providerRegistry = make(map[string]LlmProvider)
	modelRegistry = make(map[string]types.ModelInfo)
}

func init() {
	// Register provider instances
	RegisterProvider(NewAnthropicProvider(nil))
	RegisterProvider(NewOpenAIProvider(nil))
	RegisterProvider(NewGoogleProvider(nil))
	RegisterProvider(NewBedrockProvider(nil))
	RegisterProvider(NewAzureOpenAIProvider(&AzureOptions{}))

	// OpenAI-compatible providers
	compatibles := []CompatibleProviderOptions{
		{ID: "groq", BaseURL: "https://api.groq.com/openai/v1"},
		{ID: "cerebras", BaseURL: "https://api.cerebras.ai/v1"},
		{ID: "mistral", BaseURL: "https://api.mistral.ai/v1"},
		{ID: "openrouter", BaseURL: "https://openrouter.ai/api/v1"},
		{ID: "together", BaseURL: "https://api.together.xyz/v1"},
		{ID: "fireworks", BaseURL: "https://api.fireworks.ai/inference/v1"},
		{ID: "xai", BaseURL: "https://api.x.ai/v1"},
		{ID: "deepseek", BaseURL: "https://api.deepseek.com/v1"},
		{ID: "ollama", BaseURL: "http://localhost:11434/v1"},
	}
	for _, c := range compatibles {
		RegisterProvider(NewOpenAICompatibleProvider(c))
	}

	// Register models
	// Anthropic
	RegisterModel("claude-opus-4-6", types.ModelInfo{ProviderID: "anthropic", ContextWindow: 200000, CostPer1kInput: 0.015, CostPer1kOutput: 0.075, SupportsCaching: true, SupportsThinking: true, SupportsImages: true})
	RegisterModel("claude-sonnet-4-6", types.ModelInfo{ProviderID: "anthropic", ContextWindow: 200000, CostPer1kInput: 0.003, CostPer1kOutput: 0.015, SupportsCaching: true, SupportsThinking: true, SupportsImages: true})
	RegisterModel("claude-haiku-4-5-20251001", types.ModelInfo{ProviderID: "anthropic", ContextWindow: 200000, CostPer1kInput: 0.0008, CostPer1kOutput: 0.004, SupportsCaching: true, SupportsImages: true})
	// OpenAI
	RegisterModel("gpt-4.1", types.ModelInfo{ProviderID: "openai", ContextWindow: 1047576, CostPer1kInput: 0.002, CostPer1kOutput: 0.008, SupportsImages: true})
	RegisterModel("gpt-4.1-mini", types.ModelInfo{ProviderID: "openai", ContextWindow: 1047576, CostPer1kInput: 0.0004, CostPer1kOutput: 0.0016, SupportsImages: true})
	RegisterModel("o4-mini", types.ModelInfo{ProviderID: "openai", ContextWindow: 200000, CostPer1kInput: 0.0011, CostPer1kOutput: 0.0044, SupportsThinking: true, SupportsImages: true})
	RegisterModel("o3", types.ModelInfo{ProviderID: "openai", ContextWindow: 200000, CostPer1kInput: 0.01, CostPer1kOutput: 0.04, SupportsThinking: true, SupportsImages: true})
}
