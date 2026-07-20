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
	go discoverOne(providerID, baseURL, apiKey)
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
		discoverOne(providerID, baseURL, apiKey)
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
			models, err := fetchModelsForProvider(pid, baseURL, apiKey)
			results <- result{pid: pid, models: models, err: err}
		}()
	}
	go func() { wg.Wait(); close(results) }()

	for r := range results {
		storeResult(r.pid, r.models, r.err)
	}
	utils.Log("ModelDiscovery", "bulk discovery complete")
}

func discoverOne(providerID, baseURL, apiKey string) {
	models, err := fetchModelsForProvider(providerID, baseURL, apiKey)
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
	if len(models) > 0 {
		mu.Lock()
		registered := 0
		for _, m := range models {
			if _, exists := modelRegistry[m.ID]; !exists {
				modelRegistry[m.ID] = types.ModelInfo{ProviderID: providerID}
				registered++
			}
		}
		mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "registered new models in provider registry", map[string]any{"provider": providerID, "count": registered})
	}
}

// ─── Provider-specific fetch implementations ──────────────────────

func fetchModelsForProvider(providerID, baseURL, apiKey string) ([]types.ModelEntry, error) {
	switch providerID {
	case "anthropic":
		return fetchAnthropicModels(baseURL, apiKey)
	case "google":
		return fetchGoogleModels(baseURL, apiKey)
	case "openai":
		// OpenAI's default base URL (https://api.openai.com) doesn't include /v1,
		// unlike the compatible providers. Append /v1 only if not already present.
		if !strings.HasSuffix(baseURL, "/v1") && !strings.Contains(baseURL, "/v1/") {
			baseURL = strings.TrimRight(baseURL, "/") + "/v1"
		}
		return fetchOpenAICompatModels(providerID, baseURL, apiKey)
	case "bedrock", "azure":
		return nil, fmt.Errorf("discovery not supported for %s", providerID)
	default:
		return fetchOpenAICompatModels(providerID, baseURL, apiKey)
	}
}

func fetchOpenAICompatModels(providerID, baseURL, apiKey string) ([]types.ModelEntry, error) {
	url := strings.TrimRight(baseURL, "/") + "/models"
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
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
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode error: %w", err)
	}
	var entries []types.ModelEntry
	for _, m := range result.Data {
		if m.ID == "" {
			continue
		}
		entries = append(entries, factory(m.ID))
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
