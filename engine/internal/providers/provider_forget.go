package providers

import (
	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/utils"
)

// builtinProviderIDs is the set of providers the engine registers on its own,
// before any configuration applies. Guarded by mu.
var builtinProviderIDs = map[string]bool{}

// recordBuiltinProviders snapshots the registry as the built-in set. Called
// once the built-in providers are registered and before ApplyConfig.
func recordBuiltinProviders() {
	mu.Lock()
	defer mu.Unlock()
	builtinProviderIDs = make(map[string]bool, len(providerRegistry))
	for id := range providerRegistry {
		builtinProviderIDs[id] = true
	}
}

// IsBuiltinProvider reports whether the engine registers providerID itself.
// Configuration can point a built-in provider elsewhere but cannot remove it;
// every other configured provider exists only because configuration names it.
func IsBuiltinProvider(providerID string) bool {
	mu.RLock()
	defer mu.RUnlock()
	return builtinProviderIDs[providerID]
}

// ForgetProvider removes a configured provider from the running engine: its
// chat and image registrations, every model registered under it, its
// discovered model list, and its auth header style. It is the runtime half of
// deleting the provider from configuration. A built-in provider is left
// alone, since configuration does not create it.
func ForgetProvider(providerID string) {
	if IsBuiltinProvider(providerID) {
		utils.LogWithFields(utils.LevelWarn, "Providers", "forget provider skipped: built-in", map[string]any{"provider": providerID})
		return
	}
	mu.Lock()
	delete(providerRegistry, providerID)
	delete(imageProviderRegistry, providerID)
	models := 0
	for id, info := range modelRegistry {
		if info.ProviderID == providerID {
			delete(modelRegistry, id)
			models++
		}
	}
	mu.Unlock()

	discoveryMu.Lock()
	delete(discoveryCache, providerID)
	discoveryMu.Unlock()

	auth.RegisterProviderAuthHeader(providerID, "")
	utils.LogWithFields(utils.LevelInfo, "Providers", "provider forgotten", map[string]any{"provider": providerID, "models_removed": models})
}
