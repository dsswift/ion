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
	ID                     string   `json:"id"`
	ProviderID             string   `json:"providerId"`
	ContextWindow          int      `json:"contextWindow"`
	CostPer1kInput         float64  `json:"costPer1kInput"`
	CostPer1kOutput        float64  `json:"costPer1kOutput"`
	CostPer1kCacheCreation float64  `json:"costPer1kCacheCreation,omitempty"`
	CostPer1kCacheRead     float64  `json:"costPer1kCacheRead,omitempty"`
	SupportsCaching        bool     `json:"supportsCaching,omitempty"`
	SupportsThinking       bool     `json:"supportsThinking,omitempty"`
	SupportsImages         bool     `json:"supportsImages,omitempty"`
	MaxOutputTokens        int      `json:"maxOutputTokens,omitempty"`
	ThinkingMode           string   `json:"thinkingMode,omitempty"`
	ThinkingEfforts        []string `json:"thinkingEfforts,omitempty"`
	Tokenizer              string   `json:"tokenizer,omitempty"`
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
	// Cache pricing: user config overrides catalog values when non-zero.
	if user.CostPer1kCacheCreation != 0 {
		merged.CostPer1kCacheCreation = user.CostPer1kCacheCreation
	}
	if user.CostPer1kCacheRead != 0 {
		merged.CostPer1kCacheRead = user.CostPer1kCacheRead
	}
	// MaxOutputTokens: non-zero user value wins (additive, matches the rule
	// above). Lets a custom/user-config model declare its own output cap.
	if user.MaxOutputTokens != 0 {
		merged.MaxOutputTokens = user.MaxOutputTokens
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
	// Thinking capability: user config can override the mode/efforts (e.g. a
	// custom model entry declaring its reasoning support). Non-empty wins,
	// matching the additive "user can add capability" rule above.
	if user.ThinkingMode != "" {
		merged.ThinkingMode = user.ThinkingMode
	}
	if len(user.ThinkingEfforts) > 0 {
		merged.ThinkingEfforts = user.ThinkingEfforts
	}
	// Tokenizer: non-empty user value wins (additive, matches the rule above).
	if user.Tokenizer != "" {
		merged.Tokenizer = user.Tokenizer
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
			ProviderID:             e.ProviderID,
			ContextWindow:          e.ContextWindow,
			CostPer1kInput:         e.CostPer1kInput,
			CostPer1kOutput:        e.CostPer1kOutput,
			CostPer1kCacheCreation: e.CostPer1kCacheCreation,
			CostPer1kCacheRead:     e.CostPer1kCacheRead,
			SupportsCaching:        e.SupportsCaching,
			SupportsThinking:       e.SupportsThinking,
			SupportsImages:         e.SupportsImages,
			MaxOutputTokens:        e.MaxOutputTokens,
			ThinkingMode:           e.ThinkingMode,
			ThinkingEfforts:        e.ThinkingEfforts,
			Tokenizer:              e.Tokenizer,
		})
	}
	utils.LogWithFields(utils.LevelInfo, "Registry", "models loaded from catalog", map[string]any{"count": len(entries)})
	return nil
}
