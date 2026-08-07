package server

import (
	"strings"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// filterCustomGatewayModels hides embedded public-catalog entries from a
// provider configured against a private gateway. It retains every user-defined
// entry and every model the gateway actually returned. Discovery records bare
// wire IDs; ListModels deliberately emits qualified IDs for collisions (for
// example dci-marketing/claude-opus-4-8), so matching must compare both forms.
func filterCustomGatewayModels(models []types.ModelEntry, customGateways map[string]bool) []types.ModelEntry {
	discovered := make(map[string]map[string]bool, len(customGateways))
	for providerID := range customGateways {
		ids := make(map[string]bool)
		for _, model := range providers.GetDiscoveredModels(providerID) {
			ids[model.ID] = true
		}
		discovered[providerID] = ids
	}

	return filterModelsAgainstDiscovery(models, discovered, customGateways)
}

func filterModelsAgainstDiscovery(models []types.ModelEntry, discovered map[string]map[string]bool, customGateways map[string]bool) []types.ModelEntry {
	filtered := make([]types.ModelEntry, 0, len(models))
	for _, model := range models {
		if !customGateways[model.ProviderID] || model.IsCustom || discovered[model.ProviderID][bareModelID(model.ProviderID, model.ID)] {
			filtered = append(filtered, model)
		}
	}
	return filtered
}

func bareModelID(providerID, modelID string) string {
	prefix := providerID + "/"
	return strings.TrimPrefix(modelID, prefix)
}
