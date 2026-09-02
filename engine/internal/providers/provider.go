package providers

import (
	"context"
	"sort"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/conversation"
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

// ImageProvider generates images from a text prompt. It is a separate
// interface from LlmProvider because image APIs (DALL-E, gpt-image-1, etc.)
// have a completely different wire shape: single prompt in, image bytes out —
// no streaming, no conversation history, no tools. A provider may implement
// both interfaces.
type ImageProvider interface {
	ID() string
	// Generate submits a single text prompt to the image-generation API and
	// returns one or more image results. Data in each result is raw base64
	// bytes (never a URL); callers are responsible for persisting to disk.
	Generate(ctx context.Context, opts types.ImageGenerateOptions) ([]types.ImageResult, error)
}

// CountTokensRequest carries the content to be counted.
type CountTokensRequest struct {
	Model    string
	System   string
	Messages []types.LlmMessage
	Tools    []types.LlmToolDef
}

var (
	providerRegistry      = make(map[string]LlmProvider)
	imageProviderRegistry = make(map[string]ImageProvider)
	modelRegistry         = make(map[string]types.ModelInfo)
	mu                    sync.RWMutex
)

// RegisterProvider adds a provider to the global registry.
func RegisterProvider(p LlmProvider) {
	mu.Lock()
	defer mu.Unlock()
	providerRegistry[p.ID()] = p
}

// UnregisterProvider removes a provider from the global registry. It exists for
// test cleanup and provider lifecycle replacement; callers that remove a provider
// must also unregister any model entries that resolve to it.
func UnregisterProvider(id string) {
	mu.Lock()
	defer mu.Unlock()
	delete(providerRegistry, id)
}

// GetProvider returns a registered provider by ID.
func GetProvider(id string) LlmProvider {
	mu.RLock()
	defer mu.RUnlock()
	return providerRegistry[id]
}

// RegisterImageProvider adds an image provider to the global registry.
func RegisterImageProvider(p ImageProvider) {
	mu.Lock()
	defer mu.Unlock()
	utils.LogWithFields(utils.LevelDebug, "Providers", "register image provider", map[string]any{"provider": p.ID()})
	imageProviderRegistry[p.ID()] = p
}

// GetImageProvider returns a registered image provider by ID.
func GetImageProvider(id string) ImageProvider {
	mu.RLock()
	defer mu.RUnlock()
	return imageProviderRegistry[id]
}

// ResolveImageProvider finds the ImageProvider for a given model name by
// looking up the model's ProviderID in the model registry, then returning the
// ImageProvider registered for that provider ID. Returns nil when no image
// provider is registered for the model's provider.
func ResolveImageProvider(model string) ImageProvider {
	mu.RLock()
	defer mu.RUnlock()
	info, ok := modelRegistry[model]
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "Providers", "resolve image provider: model not in registry", map[string]any{"model": model})
		return nil
	}
	p := imageProviderRegistry[info.ProviderID]
	if p == nil {
		utils.LogWithFields(utils.LevelInfo, "Providers", "resolve image provider: no image provider registered", map[string]any{"model": model, "provider": info.ProviderID})
	} else {
		utils.LogWithFields(utils.LevelDebug, "Providers", "resolve image provider hit", map[string]any{"model": model, "provider": p.ID()})
	}
	return p
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
			utils.LogWithFields(utils.LevelInfo, "Providers", "resolve provider registry hit", map[string]any{"model": model, "provider": p.ID()})
		} else {
			utils.LogWithFields(utils.LevelInfo, "Providers", "resolve provider registry hit but provider not registered", map[string]any{"model": model, "provider": info.ProviderID})
		}
		return p
	}

	// Provider-qualified id: "<providerID>/<model>" routes to that provider
	// directly (dual-provider coexistence — e.g. "dci-marketing/claude-opus-4-8"
	// alongside public anthropic's "claude-opus-4-8"). Only fires when the
	// prefix matches a REGISTERED provider id, so OpenRouter-style wire ids
	// ("deepseek/deepseek-chat"), whose slash is part of the model id and which
	// resolve via the exact registry hit above, are unaffected.
	if idx := strings.Index(model, "/"); idx > 0 {
		if p := providerRegistry[model[:idx]]; p != nil {
			utils.LogWithFields(utils.LevelInfo, "Providers", "resolve provider qualified id", map[string]any{"model": model, "provider": p.ID()})
			return p
		}
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
		utils.LogWithFields(utils.LevelDebug, "Providers", "resolve provider prefix match", map[string]any{"model": model, "provider": matched})
		return providerRegistry[matched]
	}

	utils.LogWithFields(utils.LevelInfo, "Providers", "resolve provider no match", map[string]any{"model": model})
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
	utils.LogWithFields(utils.LevelDebug, "Registry", "register model", map[string]any{"model": model, "provider": info.ProviderID})
	modelRegistry[model] = info
}

// UnregisterModel removes a model from the registry. Intended for test cleanup
// so tests that register ephemeral models do not pollute the shared registry.
func UnregisterModel(model string) {
	mu.Lock()
	defer mu.Unlock()
	delete(modelRegistry, model)
}

// ProviderNameForModel returns the provider ID for a given model name.
// Uses the model registry first, then falls back to prefix matching.
// Returns empty string if no provider can be determined.
func ProviderNameForModel(model string) string {
	mu.RLock()
	defer mu.RUnlock()

	if info, ok := modelRegistry[model]; ok {
		utils.LogWithFields(utils.LevelDebug, "Registry", "provider name for model from registry", map[string]any{"model": model, "provider": info.ProviderID})
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
			ID:                     id,
			ProviderID:             info.ProviderID,
			ContextWindow:          info.ContextWindow,
			CostPer1kInput:         info.CostPer1kInput,
			CostPer1kOutput:        info.CostPer1kOutput,
			CostPer1kCacheCreation: info.CostPer1kCacheCreation,
			CostPer1kCacheRead:     info.CostPer1kCacheRead,
			SupportsCaching:        info.SupportsCaching,
			SupportsThinking:       info.SupportsThinking,
			SupportsImages:         info.SupportsImages,
			MaxOutputTokens:        info.MaxOutputTokens,
			EffectiveContextLimit:  conversation.ResolveModelContextCapacity(info.ContextWindow, 0, &info).EffectiveLimit,
			ThinkingMode:           info.ThinkingMode,
			ThinkingEfforts:        info.ThinkingEfforts,
			Tokenizer:              info.Tokenizer,
			ModelKind:              info.ModelKind,
			Dialect:                info.Dialect,
			CostPerImage:           info.CostPerImage,
			IsCustom:               info.IsCustom,
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
			// Use live-discovered models, enriched with catalog metadata.
			// Enrichment is fill-if-zero only: a discovered value always wins
			// over the embedded catalog (live metadata from an extended
			// /models payload must never be clobbered by stale catalog data).
			for _, dm := range discovered {
				if catalog, ok := catalogLookup[dm.ID]; ok {
					if dm.ContextWindow == 0 {
						dm.ContextWindow = catalog.ContextWindow
					}
					if dm.CostPer1kInput == 0 {
						dm.CostPer1kInput = catalog.CostPer1kInput
					}
					if dm.CostPer1kOutput == 0 {
						dm.CostPer1kOutput = catalog.CostPer1kOutput
					}
					if dm.CostPer1kCacheCreation == 0 {
						dm.CostPer1kCacheCreation = catalog.CostPer1kCacheCreation
					}
					if dm.CostPer1kCacheRead == 0 {
						dm.CostPer1kCacheRead = catalog.CostPer1kCacheRead
					}
					if dm.MaxOutputTokens == 0 {
						dm.MaxOutputTokens = catalog.MaxOutputTokens
					}
					if !dm.SupportsCaching {
						dm.SupportsCaching = catalog.SupportsCaching
					}
					if !dm.SupportsThinking {
						dm.SupportsThinking = catalog.SupportsThinking
					}
					if !dm.SupportsImages {
						dm.SupportsImages = catalog.SupportsImages
					}
					if dm.ThinkingMode == "" {
						dm.ThinkingMode = catalog.ThinkingMode
					}
					if len(dm.ThinkingEfforts) == 0 {
						dm.ThinkingEfforts = catalog.ThinkingEfforts
					}
					if dm.Tokenizer == "" {
						dm.Tokenizer = catalog.Tokenizer
					}
					if dm.ModelKind == "" {
						dm.ModelKind = catalog.ModelKind
					}
					if dm.Dialect == "" {
						dm.Dialect = catalog.Dialect
					}
					if dm.CostPerImage == 0 {
						dm.CostPerImage = catalog.CostPerImage
					}
				}
				entry := dm
				// Identity collision: this provider's discovered bare id is owned
				// by a DIFFERENT provider in the routing registry (dual-provider
				// coexistence in model_discovery.storeResult). Advertising the
				// bare id here would let a consumer pick a model displayed under
				// this provider whose id routes elsewhere — the exact misroute
				// that sent a dci-marketing Sonnet pick to the anthropic CLI.
				// Emit the provider-qualified alias instead, which storeResult
				// registered for dialect-carrying gateway entries and which
				// routing resolves to THIS provider.
				if owner, owned := modelRegistry[dm.ID]; owned && owner.ProviderID != pid {
					qualified := pid + "/" + dm.ID
					if _, hasQualified := modelRegistry[qualified]; hasQualified {
						entry.ID = qualified
					} else {
						// No qualified registration exists (non-dialect payload):
						// there is no id that routes to this provider for this
						// model. Emitting the bare id would be a lie; surface the
						// gap loudly instead of silently misrouting picks.
						utils.LogWithFields(utils.LevelWarn, "Providers", "list_models: collided model has no provider-qualified registration; emitting bare id that routes to another provider", map[string]any{
							"provider": pid, "model": dm.ID, "routes_to": owner.ProviderID,
						})
					}
				}
				entries = append(entries, entry)
				seen[entry.ID] = true
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
	// Apply the engine-wide operator thinking policy LAST, after catalog
	// enrichment and discovery merging have filled in every capability field.
	// Scrubbing earlier would let the fill-if-zero enrichment above restore the
	// very fields the policy withheld. No-op (and no allocation) on the default
	// permitted path. See thinking_policy.go.
	return applyThinkingPolicyToEntries(entries)
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
	utils.LogWithFields(utils.LevelDebug, "Providers", "set provider key", map[string]any{"provider": providerID, "count": len(key)})
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
		utils.LogWithFields(utils.LevelDebug, "Registry", "get provider key no keys map", map[string]any{"provider": providerID})
		return ""
	}
	key := providerKeys[providerID]
	utils.LogWithFields(utils.LevelDebug, "Registry", "get provider key", map[string]any{"provider": providerID, "status": key != "", "count": len(key)})
	return key
}

// ApplyConfig re-registers providers that have config overrides (baseURL,
// authHeader, etc.). Call after loading engine config.
//
// For any provider that has a baseURL (first-class or custom), an image
// provider is also registered under the same ID. This allows user-config
// providers (e.g. a custom Azure OpenAI deployment that serves DALL-E, or
// an on-premise endpoint that implements the /v1/images/generations API) to
// declare image models via modelKind="image" in their models.json entry and
// have those models route through runImageLoop without additional setup.
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
			// Re-register the image provider in case baseURL was overridden
			// (e.g. Azure OpenAI endpoint serving DALL-E).
			RegisterImageProvider(NewOpenAIImageProvider(opts))
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
				compatOpts := CompatibleProviderOptions{
					ID:         name,
					APIKey:     cfg.APIKey,
					BaseURL:    baseURL,
					AuthHeader: cfg.AuthHeader,
				}
				// Dialect-dispatching provider: for stock compatible providers
				// (no dialect metadata in their /models payload) this behaves
				// byte-identically to the plain compatible provider; for
				// gateways it routes per-model by the registered dialect.
				RegisterProvider(NewGatewayProvider(compatOpts))
				// Known compatible providers may also host image models (e.g.
				// a Together endpoint that serves Flux). Register an image
				// provider so modelKind="image" entries route correctly.
				RegisterImageProvider(NewOpenAIImageProvider(&ProviderOptions{
					ID:         name,
					APIKey:     cfg.APIKey,
					BaseURL:    baseURL,
					AuthHeader: cfg.AuthHeader,
				}))
			} else if cfg.BaseURL != "" {
				// Unknown provider name with a baseURL — register a
				// dialect-dispatching provider (chat by default, per-model
				// dialect routing for gateways) AND an image provider so that
				// any of its models declared with modelKind="image" route
				// through runImageLoop without additional config.
				RegisterProvider(NewGatewayProvider(CompatibleProviderOptions{
					ID:         name,
					APIKey:     cfg.APIKey,
					BaseURL:    cfg.BaseURL,
					AuthHeader: cfg.AuthHeader,
				}))
				RegisterImageProvider(NewOpenAIImageProvider(&ProviderOptions{
					ID:         name,
					APIKey:     cfg.APIKey,
					BaseURL:    cfg.BaseURL,
					AuthHeader: cfg.AuthHeader,
				}))
			} else {
				utils.LogWithFields(utils.LevelInfo, "Providers", "apply config skipping unknown provider", map[string]any{"provider": name, "reason": "no baseURL"})
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
	imageProviderRegistry = make(map[string]ImageProvider)
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

	// Register the OpenAI image provider (DALL-E 3, gpt-image-1).
	RegisterImageProvider(NewOpenAIImageProvider(nil))
}
