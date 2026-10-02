package providers

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ModelRefreshStatus is the outcome of one provider's model refresh.
type ModelRefreshStatus string

const (
	// ModelRefreshOK means the provider's models endpoint answered.
	ModelRefreshOK ModelRefreshStatus = "ok"
	// ModelRefreshFailed means discovery was attempted, or was expected to be
	// possible, and did not produce a model list.
	ModelRefreshFailed ModelRefreshStatus = "failed"
	// ModelRefreshSkipped means the provider was not a discovery target: its
	// models come from elsewhere, it is not set up, or its cached list is
	// still fresh.
	ModelRefreshSkipped ModelRefreshStatus = "skipped"
)

// ModelRefreshResult is one provider's refresh outcome. Reason is set for
// every status other than ok.
type ModelRefreshResult struct {
	Provider   string             `json:"provider"`
	Status     ModelRefreshStatus `json:"status"`
	Reason     string             `json:"reason,omitempty"`
	ModelCount int                `json:"modelCount"`
}

// discoverySupported reports whether a provider has a models endpoint this
// package can query.
func discoverySupported(providerID string) bool {
	return providerID != "bedrock" && providerID != "azure"
}

func skippedRefresh(providerID, reason string) ModelRefreshResult {
	return ModelRefreshResult{Provider: providerID, Status: ModelRefreshSkipped, Reason: reason}
}

func failedRefresh(providerID, reason string) ModelRefreshResult {
	return ModelRefreshResult{Provider: providerID, Status: ModelRefreshFailed, Reason: reason}
}

// missingBaseURLResult classifies a provider that resolved no base URL: a
// provider with no models endpoint is skipped, any other one cannot be
// discovered and has failed.
func missingBaseURLResult(providerID string) ModelRefreshResult {
	if !discoverySupported(providerID) {
		return skippedRefresh(providerID, fmt.Sprintf("discovery not supported for %s", providerID))
	}
	return failedRefresh(providerID, "no base url configured")
}

// fetchResult classifies the outcome of a models fetch.
func fetchResult(providerID string, models []types.ModelEntry, err error) ModelRefreshResult {
	if err != nil {
		if !discoverySupported(providerID) {
			return skippedRefresh(providerID, err.Error())
		}
		return failedRefresh(providerID, err.Error())
	}
	return ModelRefreshResult{Provider: providerID, Status: ModelRefreshOK, ModelCount: len(models)}
}

// RefreshModels re-discovers models for the given provider (or all
// providers if providerID is empty) and returns one result per provider
// considered, sorted by provider id. Runs synchronously so the caller
// can return the result. Skips providers that were fetched less than
// 24h ago unless force is true.
//
// A provider named explicitly is always a target, so a missing credential is
// a failure. With no provider named, only providers that are set up are
// targets: one with no credential is skipped.
func RefreshModels(providerID string, force bool, resolveKey keyResolver, providerConfigs map[string]types.ProviderConfig) []ModelRefreshResult {
	utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "refresh requested", map[string]any{"provider": providerID, "status": force})
	if providerID == "" {
		return runDiscoveryAll(resolveKey, providerConfigs, force)
	}
	return []ModelRefreshResult{refreshOne(providerID, force, resolveKey, providerConfigs)}
}

func refreshOne(providerID string, force bool, resolveKey keyResolver, providerConfigs map[string]types.ProviderConfig) ModelRefreshResult {
	if isCliBacked(providerID) {
		utils.LogWithFields(utils.LevelDebug, "ModelDiscovery", "skipping http refresh for cli-backed provider", map[string]any{"provider": providerID})
		return skippedRefresh(providerID, "models come from the provider cli")
	}
	apiKey, err := resolveKey(providerID)
	if apiKey == "" && providerID != "ollama" {
		utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "no api key skipping refresh", map[string]any{"provider": providerID, "error": err})
		reason := "no credential"
		if err != nil {
			reason = "no credential: " + err.Error()
		}
		return failedRefresh(providerID, reason)
	}
	baseURL := resolveBaseURL(providerID, providerConfigs)
	if baseURL == "" {
		utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "no base url skipping refresh", map[string]any{"provider": providerID})
		return missingBaseURLResult(providerID)
	}
	if !force && !isStale(providerID) {
		utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "skipping refresh last fetch under 24h", map[string]any{"provider": providerID})
		return skippedRefresh(providerID, "fetched less than 24h ago")
	}
	models, fetchErr := fetchModelsForProvider(providerID, baseURL, apiKey, resolveAuthHeader(providerID, providerConfigs))
	storeResult(providerID, models, fetchErr)
	return fetchResult(providerID, models, fetchErr)
}

func runDiscoveryAll(resolveKey keyResolver, providerConfigs map[string]types.ProviderConfig, force bool) []ModelRefreshResult {
	providerIDs := ListProviderIDs()
	var wg sync.WaitGroup
	type result struct {
		pid    string
		models []types.ModelEntry
		err    error
		// keyless marks a fetch tried with no credential and no operator
		// config for the provider: a probe of a default local endpoint that
		// nobody asked for, so its failure is a skip.
		keyless bool
	}
	results := make(chan result, len(providerIDs))
	outcomes := make([]ModelRefreshResult, 0, len(providerIDs))

	for _, pid := range providerIDs {
		pid := pid
		if isCliBacked(pid) {
			// CLI-backed providers get their model list from the delegated CLI
			// (via SetExternalModels), not the HTTP /models endpoint. Skipping
			// the fetch is the structural fix for the ChatGPT-token 403 + stale
			// fallback catalog.
			utils.LogWithFields(utils.LevelDebug, "ModelDiscovery", "skipping http discovery for cli-backed provider", map[string]any{"provider": pid})
			outcomes = append(outcomes, skippedRefresh(pid, "models come from the provider cli"))
			continue
		}
		if !force && !isStale(pid) {
			utils.LogWithFields(utils.LevelDebug, "ModelDiscovery", "skipping discovery last fetch under 24h", map[string]any{"provider": pid})
			outcomes = append(outcomes, skippedRefresh(pid, "fetched less than 24h ago"))
			continue
		}
		apiKey, err := resolveKey(pid)
		if (err != nil || apiKey == "") && pid != "ollama" {
			utils.LogWithFields(utils.LevelDebug, "ModelDiscovery", "no api key skipping discovery", map[string]any{"provider": pid})
			outcomes = append(outcomes, skippedRefresh(pid, "no credential"))
			continue
		}
		baseURL := resolveBaseURL(pid, providerConfigs)
		if baseURL == "" {
			utils.LogWithFields(utils.LevelInfo, "ModelDiscovery", "no base url skipping discovery", map[string]any{"provider": pid})
			outcomes = append(outcomes, missingBaseURLResult(pid))
			continue
		}
		_, configured := providerConfigs[pid]
		keyless := apiKey == "" && !configured
		wg.Add(1)
		go func() {
			defer wg.Done()
			models, err := fetchModelsForProvider(pid, baseURL, apiKey, resolveAuthHeader(pid, providerConfigs))
			results <- result{pid: pid, models: models, err: err, keyless: keyless}
		}()
	}
	go func() { wg.Wait(); close(results) }()

	for r := range results {
		storeResult(r.pid, r.models, r.err)
		outcome := fetchResult(r.pid, r.models, r.err)
		if r.keyless && outcome.Status == ModelRefreshFailed {
			outcome.Status = ModelRefreshSkipped
		}
		outcomes = append(outcomes, outcome)
	}
	sort.Slice(outcomes, func(i, j int) bool { return outcomes[i].Provider < outcomes[j].Provider })
	utils.Log("ModelDiscovery", "bulk discovery complete")
	return outcomes
}

// ModelRefreshError returns an error when a refresh failed for every provider
// it targeted, and nil otherwise. Skipped providers are not targets, so a
// refresh that targeted nothing is not an error.
func ModelRefreshError(results []ModelRefreshResult) error {
	var succeeded int
	var failures []string
	for _, r := range results {
		switch r.Status {
		case ModelRefreshOK:
			succeeded++
		case ModelRefreshFailed:
			failures = append(failures, r.Provider+": "+r.Reason)
		}
	}
	if succeeded > 0 || len(failures) == 0 {
		return nil
	}
	return fmt.Errorf("discovery failed for %d of %d provider(s): %s", len(failures), len(failures), strings.Join(failures, "; "))
}
