package config

// provider_remove.go — delete one provider definition from engine.json.

import (
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/durablefile"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ProviderRemoveError is a removal the engine refused because of what the
// configuration says, as opposed to an I/O failure.
type ProviderRemoveError struct {
	Provider string
	Reason   string
}

func (e *ProviderRemoveError) Error() string {
	return fmt.Sprintf("cannot remove provider %q: %s", e.Provider, e.Reason)
}

// RemoveProvider deletes providers.<providerID> from ~/.ion/engine.json. It
// edits the raw map, so every other key survives the write.
//
// engine.json's defaultModel is the model the engine falls back to when a
// requested one does not resolve. When it is one of the provider's
// provider-qualified models it goes too, since a fallback to a removed
// provider can never run; the cleared value is returned.
//
// It refuses, writing nothing, when a managed file owns the engine
// configuration, when enterprise policy declares the provider (the user file
// is not where it comes from), and when the file does not define it.
func RemoveProvider(providerID string) (clearedFallback string, err error) {
	if err := RefuseManagedConfigWrite(ManagedSurfaceEngine, "provider_remove"); err != nil {
		return "", err
	}
	if enterprise := LoadEnterpriseConfig(); enterprise != nil {
		if _, pinned := enterprise.Providers[providerID]; pinned {
			utils.LogWithFields(utils.LevelWarn, "config", "provider remove refused: enterprise policy declares it", map[string]any{"provider": providerID})
			return "", &ProviderRemoveError{Provider: providerID, Reason: "your organization's policy defines it"}
		}
	}
	path := globalConfigPath()
	err = durablefile.Transaction(path, 5*time.Second, func(_ string) error {
		raw, err := readRawConfig(path)
		if err != nil {
			return err
		}
		configured, _ := raw["providers"].(map[string]any) //nolint:errcheck // missing/non-map handled below
		if _, ok := configured[providerID]; !ok {
			utils.LogWithFields(utils.LevelInfo, "config", "provider remove refused: not configured", map[string]any{"provider": providerID, "path": path})
			return &ProviderRemoveError{Provider: providerID, Reason: "it is not configured in " + path}
		}
		if model, _ := raw["defaultModel"].(string); strings.HasPrefix(model, providerID+"/") { //nolint:errcheck // a non-string defaultModel names no provider
			delete(raw, "defaultModel")
			clearedFallback = model
		}
		delete(configured, providerID)
		raw["providers"] = configured
		if err := writeRawConfig(path, raw); err != nil {
			return err
		}
		utils.LogWithFields(utils.LevelInfo, "config", "provider removed from config", map[string]any{"provider": providerID, "path": path, "remaining": len(configured), "cleared_fallback_model": clearedFallback})
		return nil
	})
	if err != nil {
		return "", err
	}
	return clearedFallback, nil
}
