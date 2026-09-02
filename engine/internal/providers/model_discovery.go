package providers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ─── Provider base URLs (defaults, used for model discovery) ──────

var defaultBaseURLs = map[string]string{
	"anthropic":  "https://api.anthropic.com",
	"openai":     "https://api.openai.com",
	"google":     "https://generativelanguage.googleapis.com",
	"groq":       "https://api.groq.com/openai/v1",
	"cerebras":   "https://api.cerebras.ai/v1",
	"mistral":    "https://api.mistral.ai/v1",
	"openrouter": "https://openrouter.ai/api/v1",
	"together":   "https://api.together.xyz/v1",
	"fireworks":  "https://api.fireworks.ai/inference/v1",
	"xai":        "https://api.x.ai/v1",
	"deepseek":   "https://api.deepseek.com/v1",
	"ollama":     "http://localhost:11434/v1",
}

const (
	discoveryTimeout  = 8 * time.Second
	discoveryStaleDur = 24 * time.Hour
)

// discoveryState per provider
type providerDiscovery struct {
	models    []types.ModelEntry
	fetchedAt time.Time
	err       string
}

var (
	discoveryCache = make(map[string]*providerDiscovery)
	discoveryMu    sync.RWMutex
	discoveryOnce  sync.Once

	// cliBackedProviders is the set of providers whose models come from a
	// delegated CLI (via SetExternalModels) rather than the HTTP /models
	// endpoint. The server sets it from the operator's backend selection.
	cliBackedProviders   = make(map[string]bool)
	cliBackedProvidersMu sync.RWMutex
)

// SetCliBackedProviders records which providers are served by a CLI backend, so
// HTTP model discovery skips them. Replaces the set wholesale.
func SetCliBackedProviders(ids map[string]bool) {
	cliBackedProvidersMu.Lock()
	defer cliBackedProvidersMu.Unlock()
	cliBackedProviders = make(map[string]bool, len(ids))
	for id, v := range ids {
		if v {
			cliBackedProviders[id] = true
		}
	}
}

// isCliBacked reports whether a provider's models come from a CLI backend.
func isCliBacked(providerID string) bool {
	cliBackedProvidersMu.RLock()
	defer cliBackedProvidersMu.RUnlock()
	return cliBackedProviders[providerID]
}

// SetExternalModels records models discovered outside the HTTP path (e.g. a CLI
// backend's own model listing) so they surface in ListModels and
// GetDiscoveredModels for the provider. It replaces the provider's discovered
// set and registers each model in the provider registry for exact-id routing.
func SetExternalModels(providerID string, models []types.ModelEntry) {
	discoveryMu.Lock()
	discoveryCache[providerID] = &providerDiscovery{models: models}
	discoveryMu.Unlock()

	mu.Lock()
	for _, m := range models {
		if _, exists := modelRegistry[m.ID]; !exists {
			modelRegistry[m.ID] = types.ModelInfo{ProviderID: providerID}
		}
	}
	mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "external models set", map[string]any{"provider": providerID, "count": len(models)})
}

type keyResolver func(provider string) (string, error)

// StartModelDiscovery fetches models from all authed providers in the
// background. Call once at startup.
func StartModelDiscovery(resolveKey keyResolver, providerConfigs map[string]types.ProviderConfig) {
	discoveryOnce.Do(func() {
		utils.Log("ModelDiscovery", "starting background discovery for all providers")
		go runDiscoveryAll(resolveKey, providerConfigs, false)
	})
}

// DiscoverProvider runs model discovery for a single provider. Called
// after store_credential so newly-authed providers get their models
// without an engine restart.
func DiscoverProvider(providerID, apiKey string, providerConfigs map[string]types.ProviderConfig) {
	if isCliBacked(providerID) {
		utils.LogWithFields(utils.LevelDebug, "ModelDiscovery", "skipping on-demand http discovery for cli-backed provider", map[string]any{"provider": providerID})
		return
	}
	baseURL := resolveBaseURL(providerID, providerConfigs)
	if baseURL == "" {
		utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "no base url skipping", map[string]any{"provider": providerID})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "on-demand discovery", map[string]any{"provider": providerID, "path": baseURL, "status": apiKey != ""})
	go discoverOne(providerID, baseURL, apiKey, resolveAuthHeader(providerID, providerConfigs))
}

// RefreshModels re-discovers models for the given provider (or all
// providers if providerID is empty). Runs synchronously so the caller
// can return the result. Skips providers that were fetched less than
// 24h ago unless force is true.
func RefreshModels(providerID string, force bool, resolveKey keyResolver, providerConfigs map[string]types.ProviderConfig) {
	utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "refresh requested", map[string]any{"provider": providerID, "status": force})
	if providerID != "" {
		if isCliBacked(providerID) {
			utils.LogWithFields(utils.LevelDebug, "ModelDiscovery", "skipping http refresh for cli-backed provider", map[string]any{"provider": providerID})
			return
		}
		apiKey, err := resolveKey(providerID)
		if apiKey == "" && providerID != "ollama" {
			utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "no api key skipping refresh", map[string]any{"provider": providerID, "error": err})
			return
		}
		baseURL := resolveBaseURL(providerID, providerConfigs)
		if baseURL == "" {
			utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "no base url skipping refresh", map[string]any{"provider": providerID})
			return
		}
		if !force && !isStale(providerID) {
			utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "skipping refresh last fetch under 24h", map[string]any{"provider": providerID})
			return
		}
		discoverOne(providerID, baseURL, apiKey, resolveAuthHeader(providerID, providerConfigs))
	} else {
		runDiscoveryAll(resolveKey, providerConfigs, force)
	}
}

// GetDiscoveredModels returns live-fetched models for a provider, or
// nil if discovery hasn't completed or failed.
func GetDiscoveredModels(providerID string) []types.ModelEntry {
	discoveryMu.RLock()
	defer discoveryMu.RUnlock()
	if d := discoveryCache[providerID]; d != nil {
		return d.models
	}
	return nil
}

// IsDiscoveryDone returns true if discovery has run for the provider.
func IsDiscoveryDone(providerID string) bool {
	discoveryMu.RLock()
	defer discoveryMu.RUnlock()
	return discoveryCache[providerID] != nil
}

// ─── Internal ─────────────────────────────────────────────────────

func isStale(providerID string) bool {
	discoveryMu.RLock()
	defer discoveryMu.RUnlock()
	d := discoveryCache[providerID]
	return d == nil || time.Since(d.fetchedAt) > discoveryStaleDur
}

func resolveBaseURL(providerID string, configs map[string]types.ProviderConfig) string {
	if cfg, ok := configs[providerID]; ok && cfg.BaseURL != "" {
		return cfg.BaseURL
	}
	return defaultBaseURLs[providerID]
}

// resolveAuthHeader returns the provider's configured auth header style
// ("" means the provider default — bearer for OpenAI-compatible fetches).
// Enterprise gateways (e.g. APIM) typically require x-api-key; without this
// the discovery request would send Authorization: Bearer and be rejected.
func resolveAuthHeader(providerID string, configs map[string]types.ProviderConfig) string {
	if cfg, ok := configs[providerID]; ok {
		return cfg.AuthHeader
	}
	return ""
}

func runDiscoveryAll(resolveKey keyResolver, providerConfigs map[string]types.ProviderConfig, force bool) {
	providerIDs := ListProviderIDs()
	var wg sync.WaitGroup
	type result struct {
		pid    string
		models []types.ModelEntry
		err    error
	}
	results := make(chan result, len(providerIDs))

	for _, pid := range providerIDs {
		pid := pid
		if isCliBacked(pid) {
			// CLI-backed providers get their model list from the delegated CLI
			// (via SetExternalModels), not the HTTP /models endpoint. Skipping
			// the fetch is the structural fix for the ChatGPT-token 403 + stale
			// fallback catalog.
			utils.LogWithFields(utils.LevelDebug, "ModelDiscovery", "skipping http discovery for cli-backed provider", map[string]any{"provider": pid})
			continue
		}
		if !force && !isStale(pid) {
			continue
		}
		apiKey, err := resolveKey(pid)
		if (err != nil || apiKey == "") && pid != "ollama" {
			continue
		}
		baseURL := resolveBaseURL(pid, providerConfigs)
		if baseURL == "" {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			models, err := fetchModelsForProvider(pid, baseURL, apiKey, resolveAuthHeader(pid, providerConfigs))
			results <- result{pid: pid, models: models, err: err}
		}()
	}
	go func() { wg.Wait(); close(results) }()

	for r := range results {
		storeResult(r.pid, r.models, r.err)
	}
	utils.Log("ModelDiscovery", "bulk discovery complete")
}

func discoverOne(providerID, baseURL, apiKey, authHeader string) {
	models, err := fetchModelsForProvider(providerID, baseURL, apiKey, authHeader)
	storeResult(providerID, models, err)
}

func storeResult(providerID string, models []types.ModelEntry, err error) {
	// Store discovery result (hold discoveryMu only for the cache write)
	discoveryMu.Lock()
	d := &providerDiscovery{fetchedAt: time.Now()}
	if err != nil {
		d.err = err.Error()
		utils.LogWithFields(utils.LevelWarn, "ModelDiscovery", "discovery failed using fallback catalog", map[string]any{"provider": providerID, "error": err.Error()})
	} else if len(models) > 0 {
		d.models = models
		utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "models discovered", map[string]any{"provider": providerID, "count": len(models)})
	} else {
		utils.LogWithFields(utils.LevelWarn, "ModelDiscovery", "api returned 0 models using fallback catalog", map[string]any{"provider": providerID})
	}
	discoveryCache[providerID] = d
	discoveryMu.Unlock()

	// Register discovered models in the model registry so that
	// ResolveProvider finds them by exact ID before prefix matching.
	// This is critical for meta-routers like OpenRouter whose model
	// IDs (e.g. "deepseek/deepseek-chat") would otherwise match the
	// wrong provider via prefix heuristics.
	//
	// Registration carries the full discovered metadata (dialect, context
	// window, costs, capabilities) — an extended /models payload (enterprise
	// gateway) is the source of truth for dialect dispatch and cost display.
	//
	// Merge, never replace: a stock provider's /models payload is ids only, so
	// every extended field is zero. Overwriting the registry entry with that
	// sparse struct would destroy the embedded-catalog metadata that
	// GetModelInfo serves — and GetModelInfo is what cost.TurnCost reads, so a
	// clobbered entry silently prices every turn at $0. Exact cache prices now
	// follow the same non-zero overlay rule as the base token rates.
	//
	// Dual-provider coexistence: when the bare id is already claimed by a
	// DIFFERENT provider (e.g. public anthropic owns claude-opus-4-8 and a
	// gateway also serves it), only the provider-qualified id
	// ("<provider>/<model>") is registered so the existing owner is never
	// stomped. The qualified id is always registered for gateway entries that
	// carry a dialect, so pickers can address the gateway copy explicitly.
	if len(models) > 0 {
		mu.Lock()
		// Counters describe exactly what happened to the registry, so the log
		// line an operator reads while debugging discovery is the truth:
		// added = ids the registry had never seen, refreshed = existing
		// same-provider entries updated with live metadata, qualified = new
		// provider-qualified aliases for gateway models.
		added, refreshed, qualifiedAdded := 0, 0, 0
		for _, m := range models {
			info := types.ModelInfo{
				ProviderID:             providerID,
				ContextWindow:          m.ContextWindow,
				CostPer1kInput:         m.CostPer1kInput,
				CostPer1kOutput:        m.CostPer1kOutput,
				CostPer1kCacheCreation: m.CostPer1kCacheCreation,
				CostPer1kCacheRead:     m.CostPer1kCacheRead,
				SupportsCaching:        m.SupportsCaching,
				SupportsThinking:       m.SupportsThinking,
				SupportsImages:         m.SupportsImages,
				MaxOutputTokens:        m.MaxOutputTokens,
				ThinkingMode:           m.ThinkingMode,
				ThinkingEfforts:        m.ThinkingEfforts,
				Tokenizer:              m.Tokenizer,
				ModelKind:              m.ModelKind,
				Dialect:                m.Dialect,
				CostPerImage:           m.CostPerImage,
			}
			existing, exists := modelRegistry[m.ID]
			if !exists {
				modelRegistry[m.ID] = info
				added++
			} else if existing.ProviderID == providerID {
				// Same provider re-discovered: overlay live metadata onto the
				// existing entry (catalog values survive where the payload is
				// silent).
				modelRegistry[m.ID] = mergeDiscoveredInfo(existing, info)
				refreshed++
			}
			// Qualified id for dialect-carrying (gateway) models, so the same
			// bare model id can coexist across providers.
			if m.Dialect != "" {
				qualified := providerID + "/" + m.ID
				if qExisting, qExists := modelRegistry[qualified]; qExists {
					modelRegistry[qualified] = mergeDiscoveredInfo(qExisting, info)
				} else {
					modelRegistry[qualified] = info
					qualifiedAdded++
				}
			}
		}
		mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "registered discovered models in provider registry", map[string]any{
			"provider":  providerID,
			"count":     len(models),
			"added":     added,
			"refreshed": refreshed,
			"qualified": qualifiedAdded,
		})
	}
}

// mergeDiscoveredInfo overlays live-discovered metadata onto an existing
// registry entry. Fill-if-set only: a non-zero/non-empty discovered value wins
// (live metadata from an extended /models payload is authoritative), and every
// field the payload left empty keeps the existing value.
//
// This asymmetry is deliberate and is the inverse of MergeModelInfo's
// catalog-wins rule for ContextWindow: MergeModelInfo reconciles *user config*
// against the catalog (where the catalog is trusted over a hand-written
// override), whereas this reconciles a *provider's own live payload* against
// the catalog (where the provider is trusted over a possibly-stale embedded
// entry). Discovery must never subtract: a stock provider returning ids only
// leaves the entry exactly as it was.
//
// ModelEntry carries the same cache-pricing fields as ModelInfo. Sparse live
// discovery still preserves catalog rates because the merge starts from the
// existing entry and overlays only non-zero values.
func mergeDiscoveredInfo(existing, discovered types.ModelInfo) types.ModelInfo {
	merged := existing
	// ProviderID is the routing key. Callers only merge when the provider
	// already matches, so this is a no-op guard rather than a reassignment.
	if discovered.ProviderID != "" {
		merged.ProviderID = discovered.ProviderID
	}
	if discovered.ContextWindow != 0 {
		merged.ContextWindow = discovered.ContextWindow
	}
	if discovered.CostPer1kInput != 0 {
		merged.CostPer1kInput = discovered.CostPer1kInput
	}
	if discovered.CostPer1kOutput != 0 {
		merged.CostPer1kOutput = discovered.CostPer1kOutput
	}
	if discovered.CostPer1kCacheCreation != 0 {
		merged.CostPer1kCacheCreation = discovered.CostPer1kCacheCreation
	}
	if discovered.CostPer1kCacheRead != 0 {
		merged.CostPer1kCacheRead = discovered.CostPer1kCacheRead
	}
	if discovered.MaxOutputTokens != 0 {
		merged.MaxOutputTokens = discovered.MaxOutputTokens
	}
	// Capabilities are additive, matching MergeModelInfo: a payload that omits
	// a flag must not disable a known capability.
	if discovered.SupportsCaching {
		merged.SupportsCaching = true
	}
	if discovered.SupportsThinking {
		merged.SupportsThinking = true
	}
	if discovered.SupportsImages {
		merged.SupportsImages = true
	}
	if discovered.ThinkingMode != "" {
		merged.ThinkingMode = discovered.ThinkingMode
	}
	if len(discovered.ThinkingEfforts) > 0 {
		merged.ThinkingEfforts = discovered.ThinkingEfforts
	}
	if discovered.Tokenizer != "" {
		merged.Tokenizer = discovered.Tokenizer
	}
	if discovered.ModelKind != "" {
		merged.ModelKind = discovered.ModelKind
	}
	if discovered.Dialect != "" {
		merged.Dialect = discovered.Dialect
	}
	if discovered.CostPerImage != 0 {
		merged.CostPerImage = discovered.CostPerImage
	}
	return merged
}

// ─── Provider-specific fetch implementations ──────────────────────

func fetchModelsForProvider(providerID, baseURL, apiKey, authHeader string) ([]types.ModelEntry, error) {
	switch providerID {
	case "anthropic":
		return fetchAnthropicModels(baseURL, apiKey)
	case "google":
		return fetchGoogleModels(baseURL, apiKey)
	case "bedrock", "azure":
		return nil, fmt.Errorf("discovery not supported for %s", providerID)
	default:
		// OpenAI and every OpenAI-compatible provider (incl. custom gateways):
		// normalize to a /v1 base so the request hits {base}/v1/models. The
		// stock compatible providers' default base URLs already end in /v1;
		// api.openai.com and enterprise gateways (e.g. https://ai.dcim.com) do not.
		if !strings.HasSuffix(baseURL, "/v1") && !strings.Contains(baseURL, "/v1/") {
			baseURL = strings.TrimRight(baseURL, "/") + "/v1"
		}
		return fetchOpenAICompatModels(providerID, baseURL, apiKey, authHeader)
	}
}

func fetchOpenAICompatModels(providerID, baseURL, apiKey, authHeader string) ([]types.ModelEntry, error) {
	url := strings.TrimRight(baseURL, "/") + "/models"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	if apiKey != "" {
		// Honor the provider's configured auth header style (setAuthHeader
		// defaults to Authorization: Bearer when authHeader is empty).
		// Enterprise gateways commonly require x-api-key instead.
		setAuthHeader(req, authHeader, apiKey)
	}
	return doModelsFetch(req, providerID, func(id string) types.ModelEntry {
		return types.ModelEntry{ID: id, ProviderID: providerID}
	})
}

func fetchAnthropicModels(baseURL, apiKey string) ([]types.ModelEntry, error) {
	url := strings.TrimRight(baseURL, "/") + "/v1/models"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	return doModelsFetch(req, "anthropic", func(id string) types.ModelEntry {
		return types.ModelEntry{ID: id, ProviderID: "anthropic"}
	})
}

func fetchGoogleModels(baseURL, apiKey string) ([]types.ModelEntry, error) {
	url := strings.TrimRight(baseURL, "/") + "/v1beta/models?key=" + apiKey
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: discoveryTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http error: %w", err)
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // resource close
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512)) //nolint:errcheck // best-effort read of error-response body
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var result struct {
		Models []struct {
			Name                       string   `json:"name"`
			InputTokenLimit            int      `json:"inputTokenLimit"`
			SupportedGenerationMethods []string `json:"supportedGenerationMethods"`
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode error: %w", err)
	}
	var entries []types.ModelEntry
	for _, m := range result.Models {
		id := strings.TrimPrefix(m.Name, "models/")
		isGenerative := false
		for _, method := range m.SupportedGenerationMethods {
			if method == "generateContent" {
				isGenerative = true
				break
			}
		}
		if !isGenerative {
			continue
		}
		entries = append(entries, types.ModelEntry{
			ID: id, ProviderID: "google", ContextWindow: m.InputTokenLimit,
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].ID < entries[j].ID })
	return entries, nil
}

type modelFactory func(id string) types.ModelEntry

// discoveredModelEntry is the wire shape of one /models list entry. Beyond the
// standard OpenAI {id} field it decodes the extended capability metadata that
// enterprise gateways emit (field names match ModelEntry's JSON tags). Stock
// providers omit the extended fields — zero values, behavior unchanged.
type discoveredModelEntry struct {
	ID                     string   `json:"id"`
	Dialect                string   `json:"dialect,omitempty"`
	ContextWindow          int      `json:"contextWindow,omitempty"`
	MaxOutputTokens        int      `json:"maxOutputTokens,omitempty"`
	CostPer1kInput         float64  `json:"costPer1kInput,omitempty"`
	CostPer1kOutput        float64  `json:"costPer1kOutput,omitempty"`
	CostPer1kCacheCreation float64  `json:"costPer1kCacheCreation,omitempty"`
	CostPer1kCacheRead     float64  `json:"costPer1kCacheRead,omitempty"`
	CostPerImage           float64  `json:"costPerImage,omitempty"`
	SupportsCaching        bool     `json:"supportsCaching,omitempty"`
	SupportsThinking       bool     `json:"supportsThinking,omitempty"`
	SupportsImages         bool     `json:"supportsImages,omitempty"`
	ThinkingMode           string   `json:"thinkingMode,omitempty"`
	ThinkingEfforts        []string `json:"thinkingEfforts,omitempty"`
	ModelKind              string   `json:"modelKind,omitempty"`
}

func doModelsFetch(req *http.Request, providerID string, factory modelFactory) ([]types.ModelEntry, error) {
	client := &http.Client{Timeout: discoveryTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http error: %w", err)
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // resource close
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512)) //nolint:errcheck // best-effort read of error-response body
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var result struct {
		Data []discoveredModelEntry `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode error: %w", err)
	}
	var entries []types.ModelEntry
	for _, m := range result.Data {
		if m.ID == "" {
			continue
		}
		entry := factory(m.ID)
		// Overlay extended payload fields (zero values from stock providers
		// leave the factory entry untouched, minus fields the factory set).
		entry.Dialect = m.Dialect
		if m.ContextWindow != 0 {
			entry.ContextWindow = m.ContextWindow
		}
		entry.MaxOutputTokens = m.MaxOutputTokens
		entry.CostPer1kInput = m.CostPer1kInput
		entry.CostPer1kOutput = m.CostPer1kOutput
		entry.CostPer1kCacheCreation = m.CostPer1kCacheCreation
		entry.CostPer1kCacheRead = m.CostPer1kCacheRead
		entry.CostPerImage = m.CostPerImage
		entry.SupportsCaching = m.SupportsCaching
		entry.SupportsThinking = m.SupportsThinking
		entry.SupportsImages = m.SupportsImages
		entry.ThinkingMode = m.ThinkingMode
		entry.ThinkingEfforts = m.ThinkingEfforts
		entry.ModelKind = m.ModelKind
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].ID < entries[j].ID })
	return entries, nil
}

// ResetDiscoveryCache clears the discovery cache. Used for testing.
func ResetDiscoveryCache() {
	discoveryMu.Lock()
	defer discoveryMu.Unlock()
	discoveryCache = make(map[string]*providerDiscovery)
	discoveryOnce = sync.Once{}
}
