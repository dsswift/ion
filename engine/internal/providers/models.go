package providers

import (
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// catalogEntry mirrors the JSON shape in models.json. Booleans default to
// false when omitted from the JSON, which matches the Go zero-value semantics.
type catalogEntry struct {
	ID               string  `json:"id"`
	ProviderID       string  `json:"providerId"`
	ContextWindow    int     `json:"contextWindow"`
	CostPer1kInput   float64 `json:"costPer1kInput"`
	CostPer1kOutput  float64 `json:"costPer1kOutput"`
	SupportsCaching  bool    `json:"supportsCaching,omitempty"`
	SupportsThinking bool    `json:"supportsThinking,omitempty"`
	SupportsImages   bool    `json:"supportsImages,omitempty"`
}

// MergeModelInfo overlays user-config fields onto a catalog (base) entry.
// The catalog provides defaults; the user config overrides only the fields it
// explicitly set (non-zero values). ProviderID from the user config always
// wins since it controls routing.
func MergeModelInfo(base, user types.ModelInfo) types.ModelInfo {
	merged := base
	// ProviderID always comes from the user config — it determines which
	// provider endpoint the model routes to.
	if user.ProviderID != "" {
		merged.ProviderID = user.ProviderID
	}
	if user.CostPer1kInput != 0 {
		merged.CostPer1kInput = user.CostPer1kInput
	}
	if user.CostPer1kOutput != 0 {
		merged.CostPer1kOutput = user.CostPer1kOutput
	}
	// Boolean capabilities: user config can only ADD capabilities, not remove
	// catalog capabilities. This prevents a user config that omits a field
	// from accidentally disabling a known capability.
	if user.SupportsCaching {
		merged.SupportsCaching = true
	}
	if user.SupportsThinking {
		merged.SupportsThinking = true
	}
	if user.SupportsImages {
		merged.SupportsImages = true
	}
	return merged
}

// loadModelsFromJSON parses the embedded model catalog and registers each
// entry in the global model registry. Called from init().
func loadModelsFromJSON(data []byte) error {
	var entries []catalogEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return fmt.Errorf("parse model catalog: %w", err)
	}
	for _, e := range entries {
		RegisterModel(e.ID, types.ModelInfo{
			ProviderID:       e.ProviderID,
			ContextWindow:    e.ContextWindow,
			CostPer1kInput:   e.CostPer1kInput,
			CostPer1kOutput:  e.CostPer1kOutput,
			SupportsCaching:  e.SupportsCaching,
			SupportsThinking: e.SupportsThinking,
			SupportsImages:   e.SupportsImages,
		})
	}
	utils.Log("Registry", fmt.Sprintf("loaded %d models from catalog", len(entries)))
	return nil
}
