package providers

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// LlmProvider streams LLM responses in canonical (Anthropic SSE) format.
type LlmProvider interface {
	ID() string
	Stream(ctx context.Context, opts types.LlmStreamOptions) (<-chan types.LlmStreamEvent, <-chan error)
	// CountTokens returns the exact token count for a prompt via the provider's
	// native count-tokens endpoint. Returns ErrCountUnsupported when the provider
	// has no such endpoint; callers fall back to local BPE or char/4.
	CountTokens(ctx context.Context, req CountTokensRequest) (int, error)
}

// CountTokensRequest carries the content to be counted.
type CountTokensRequest struct {
	Model    string
	System   string
	Messages []types.LlmMessage
	Tools    []types.LlmToolDef
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
		p := providerRegistry[info.ProviderID]
		if p != nil {
			utils.Log("Providers", fmt.Sprintf("ResolveProvider: model=%s → registry hit → provider=%s", model, p.ID()))
		} else {
			utils.Log("Providers", fmt.Sprintf("ResolveProvider: model=%s → registry hit for providerID=%s but provider not registered", model, info.ProviderID))
		}
		return p
	}

	// Prefix matching
	var matched string
	switch {
	case strings.HasPrefix(model, "claude-") || strings.HasPrefix(model, "claude_"):
		matched = "anthropic"
	case strings.HasPrefix(model, "gpt-") || strings.HasPrefix(model, "o1") || strings.HasPrefix(model, "o3") || strings.HasPrefix(model, "o4"):
		matched = "openai"
	case strings.HasPrefix(model, "gemini-"):
		matched = "google"
	case strings.HasPrefix(model, "mistral") || strings.HasPrefix(model, "mixtral"):
		matched = "mistral"
	case strings.HasPrefix(model, "llama") || strings.HasPrefix(model, "meta-llama"):
		if providerRegistry["groq"] != nil {
			matched = "groq"
		} else {
			matched = "together"
		}
	case strings.HasPrefix(model, "deepseek"):
		matched = "deepseek"
	case strings.HasPrefix(model, "grok"):
		matched = "xai"
	case strings.HasPrefix(model, "qwen") || strings.HasPrefix(model, "qwen2"):
		matched = "ollama"
	case strings.Contains(model, "amazon.") || strings.Contains(model, "anthropic.") || strings.Contains(model, "meta."):
		matched = "bedrock"
	}

	if matched != "" {
		utils.Debug("Providers", fmt.Sprintf("ResolveProvider: model=%s → prefix match → provider=%s", model, matched))
		return providerRegistry[matched]
	}

	utils.Log("Providers", fmt.Sprintf("ResolveProvider: model=%s → no match (not in registry, no prefix match)", model))
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
	utils.Debug("Registry", fmt.Sprintf("RegisterModel: model=%s provider=%s", model, info.ProviderID))
	modelRegistry[model] = info
}

// ProviderNameForModel returns the provider ID for a given model name.
// Uses the model registry first, then falls back to prefix matching.
// Returns empty string if no provider can be determined.
func ProviderNameForModel(model string) string {
	mu.RLock()
	defer mu.RUnlock()

	if info, ok := modelRegistry[model]; ok {
		utils.Debug("Registry", fmt.Sprintf("ProviderNameForModel: model=%s → %s (registry)", model, info.ProviderID))
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
	case strings.HasPrefix(model, "qwen") || strings.HasPrefix(model, "qwen2"):
		return "ollama"
	case strings.Contains(model, "amazon.") || strings.Contains(model, "anthropic.") || strings.Contains(model, "meta."):
		return "bedrock"
	}
	return ""
}

// ListModels returns all models. For each provider, if live discovery
// has returned results, those are used (enriched with catalog metadata
// where available). Otherwise the hardcoded catalog is returned as
// fallback. Custom (user-config) models are always included.
func ListModels() []types.ModelEntry {
	mu.RLock()
	defer mu.RUnlock()

	// Separate catalog and custom models from the registry
	catalogByProvider := make(map[string][]types.ModelEntry)
	customModels := make([]types.ModelEntry, 0)
	catalogLookup := make(map[string]types.ModelInfo) // id → info for enrichment

	for id, info := range modelRegistry {
		entry := types.ModelEntry{
			ID:               id,
			ProviderID:       info.ProviderID,
			ContextWindow:    info.ContextWindow,
			CostPer1kInput:   info.CostPer1kInput,
			CostPer1kOutput:  info.CostPer1kOutput,
			SupportsCaching:  info.SupportsCaching,
			SupportsThinking: info.SupportsThinking,
			SupportsImages:   info.SupportsImages,
			ThinkingMode:     info.ThinkingMode,
			ThinkingEfforts:  info.ThinkingEfforts,
			Tokenizer:        info.Tokenizer,
			IsCustom:         info.IsCustom,
		}
		if info.IsCustom {
			customModels = append(customModels, entry)
		} else {
			catalogByProvider[info.ProviderID] = append(catalogByProvider[info.ProviderID], entry)
			catalogLookup[id] = info
		}
	}

	// Build final list: for each provider, prefer live discovery over catalog
	entries := make([]types.ModelEntry, 0, len(modelRegistry))
	seen := make(map[string]bool)

	// Collect all provider IDs from catalog, custom models, AND discovery cache
	providerIDs := make(map[string]bool)
	for pid := range catalogByProvider {
		providerIDs[pid] = true
	}
	for _, m := range customModels {
		providerIDs[m.ProviderID] = true
	}
	// Include providers that have discovered models even if they have
	// no hardcoded catalog entries (e.g. openrouter, together, fireworks)
	discoveryMu.RLock()
	for pid, d := range discoveryCache {
		if d != nil && len(d.models) > 0 {
			providerIDs[pid] = true
		}
	}
	discoveryMu.RUnlock()

	for pid := range providerIDs {
		discovered := GetDiscoveredModels(pid)
		if len(discovered) > 0 {
			// Use live-discovered models, enriched with catalog metadata
			for _, dm := range discovered {
				if catalog, ok := catalogLookup[dm.ID]; ok {
					// Enrich with known cost/capability info
					if dm.ContextWindow == 0 {
						dm.ContextWindow = catalog.ContextWindow
					}
					if dm.CostPer1kInput == 0 {
						dm.CostPer1kInput = catalog.CostPer1kInput
					}
					if dm.CostPer1kOutput == 0 {
						dm.CostPer1kOutput = catalog.CostPer1kOutput
					}
					dm.SupportsCaching = catalog.SupportsCaching
					dm.SupportsThinking = catalog.SupportsThinking
					dm.SupportsImages = catalog.SupportsImages
					dm.ThinkingMode = catalog.ThinkingMode
					dm.ThinkingEfforts = catalog.ThinkingEfforts
					if dm.Tokenizer == "" {
						dm.Tokenizer = catalog.Tokenizer
					}
				}
				entries = append(entries, dm)
				seen[dm.ID] = true
			}
		} else {
			// Fallback to hardcoded catalog
			for _, ce := range catalogByProvider[pid] {
				entries = append(entries, ce)
				seen[ce.ID] = true
			}
		}
	}

	// Always include custom models (not already seen)
	for _, cm := range customModels {
		if !seen[cm.ID] {
			entries = append(entries, cm)
		}
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].ProviderID != entries[j].ProviderID {
			return entries[i].ProviderID < entries[j].ProviderID
		}
		return entries[i].ID < entries[j].ID
	})
	return entries
}

// ListProviderIDs returns the IDs of all registered providers.
func ListProviderIDs() []string {
	mu.RLock()
	defer mu.RUnlock()
	ids := make([]string, 0, len(providerRegistry))
	for id := range providerRegistry {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// SetProviderKey stores a resolved API key for a provider. Provider
// implementations read this when constructing HTTP requests.
func SetProviderKey(providerID, key string) {
	mu.Lock()
	defer mu.Unlock()
	utils.Debug("Providers", fmt.Sprintf("SetProviderKey: provider=%s keyLen=%d", providerID, len(key)))
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
		utils.Debug("Registry", fmt.Sprintf("GetProviderKey: provider=%s → no keys map", providerID))
		return ""
	}
	key := providerKeys[providerID]
	utils.Debug("Registry", fmt.Sprintf("GetProviderKey: provider=%s found=%v keyLen=%d", providerID, key != "", len(key)))
	return key
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
		default:
			// Re-register known OpenAI-compatible providers when config overrides exist.
			// Check defaultBaseURLs to confirm this is a known compatible provider
			// (the three first-class providers are already handled above).
			if dflt, known := defaultBaseURLs[name]; known {
				baseURL := cfg.BaseURL
				if baseURL == "" {
					baseURL = dflt
				}
				RegisterProvider(NewOpenAICompatibleProvider(CompatibleProviderOptions{
					ID:      name,
					APIKey:  cfg.APIKey,
					BaseURL: baseURL,
				}))
			} else if cfg.BaseURL != "" {
				// Unknown provider name with a baseURL — register as a new compatible provider.
				RegisterProvider(NewOpenAICompatibleProvider(CompatibleProviderOptions{
					ID:      name,
					APIKey:  cfg.APIKey,
					BaseURL: cfg.BaseURL,
				}))
			} else {
				utils.Log("Providers", fmt.Sprintf("ApplyConfig: skipping unknown provider %s (no baseURL)", name))
			}
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
	restoreInitRegistries()
}

// restoreInitRegistries registers all built-in providers and loads the
// embedded model catalog. Called once from init() and again from tests
// that call ResetRegistries() to avoid polluting later test cases.
func restoreInitRegistries() {
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

	// Register models from embedded catalog
	if err := loadModelsFromJSON(modelCatalogJSON); err != nil {
		panic("failed to load model catalog: " + err.Error())
	}
}
