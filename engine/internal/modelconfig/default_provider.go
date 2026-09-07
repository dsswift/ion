package modelconfig

import (
	"strings"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/utils"
)

// DefaultProviderID returns the operator's configured default provider for
// resolving a bare (unqualified) model name, or "" if none is configured.
func DefaultProviderID() string {
	config := LoadModelsConfig()
	id, ok := config["defaultProvider"].(string)
	if !ok {
		// Absent or a non-string value written by hand: no usable preference.
		// Bare-model resolution keeps its unbiased registry/prefix behavior.
		return ""
	}
	return strings.ToLower(strings.TrimSpace(id))
}

// SetDefaultProvider atomically persists the default-provider preference to
// models.json. An empty providerID clears the preference entirely (the key
// is removed, not set to ""), reverting to registry/prefix resolution with
// no provider bias.
func SetDefaultProvider(providerID string) (string, error) {
	providerID = strings.ToLower(strings.TrimSpace(providerID))
	err := withModelsConfig(func(config map[string]interface{}) error {
		if providerID == "" {
			delete(config, "defaultProvider")
		} else {
			config["defaultProvider"] = providerID
		}
		return writeModelsConfigAtomic(modelsConfigPath(), config)
	})
	if err != nil {
		utils.LogWithFields(utils.LevelError, "modelconfig.default_provider", "default provider write failed", map[string]any{"provider": providerID, "error": err.Error()})
		return "", err
	}
	utils.LogWithFields(utils.LevelInfo, "modelconfig.default_provider", "default provider persisted", map[string]any{"provider": providerID})
	return providerID, nil
}

// ApplyDefaultProvider requalifies a bare model name onto the operator's
// configured default provider, but only when that provider actually serves
// the model and the model isn't already provider-qualified. This is a
// preference, not a lock: an unresolvable bare name is returned unchanged so
// the existing registry/prefix resolution chain in ProviderNameForModel keeps
// working exactly as it did before this preference existed.
func ApplyDefaultProvider(model string) string {
	model = strings.TrimSpace(model)
	if model == "" || strings.Contains(model, "/") {
		return model
	}
	defaultProvider := DefaultProviderID()
	if defaultProvider == "" {
		return model
	}
	if providers.ProviderNameForModel(model) == defaultProvider {
		// Already served by the default provider under its bare name; there is
		// nothing to requalify and rewriting it would invent an unregistered ID.
		return model
	}
	qualified := defaultProvider + "/" + model
	if providers.GetModelInfo(qualified) != nil {
		utils.LogWithFields(utils.LevelInfo, "modelconfig.default_provider", "bare model requalified onto default provider", map[string]any{"model": model, "requalified": qualified})
		return qualified
	}
	utils.LogWithFields(utils.LevelDebug, "modelconfig.default_provider", "default provider does not serve bare model; left unqualified", map[string]any{"model": model, "default_provider": defaultProvider})
	return model
}
