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
	DisplayName            string   `json:"displayName,omitempty"`
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
	// ModelKind declares the API shape: "" / "chat" (default) or "image".
	// Image models are routed through the image-generation endpoint instead of
	// the chat-completion endpoint.
	ModelKind string `json:"modelKind,omitempty"`
	// Dialect declares the wire protocol a dialect-dispatching (gateway)
	// provider must speak for this model. See types.ModelInfo.Dialect.
	Dialect string `json:"dialect,omitempty"`
	// CostPerImage is the USD cost of one standard (1MP) image generation.
	// See types.ModelInfo.CostPerImage.
	CostPerImage float64 `json:"costPerImage,omitempty"`
	// CacheTtlSeconds overrides the prompt-cache lifetime for this model. Left
	// unset for every catalog model today: the lifetime is a property of the
	// request the provider builds, so loadModelsFromJSON derives it from the
	// provider rather than repeating a number in 30 catalog rows. The field
	// exists so a user-config or gateway model that caches on a different tier
	// can declare it.
	CacheTtlSeconds int `json:"cacheTtlSeconds,omitempty"`
}

// DefaultCacheTtlSeconds is the prompt-cache lifetime assumed for a caching
// model that does not publish one.
//
// Five minutes is the shortest lifetime the major providers offer, and every
// one of them is at least this long: Anthropic's default "ephemeral" tier is
// exactly 5 minutes, and OpenAI's shortest retention (in_memory) holds entries
// for roughly 5 to 10 minutes of inactivity, with its newer models defaulting
// to 30. So a model that declares caching and no lifetime almost certainly
// caches for at least this long.
//
// Taking the SHORTEST rather than a typical value is deliberate, because the
// two ways of being wrong are not symmetric. Assuming too long reports a dead
// cache as live and quotes the cheap read rate for a turn that will actually
// be billed at the write rate — understating the cost by up to 50x, which is
// the exact defect this whole estimate exists to prevent. Assuming too short
// reports a live cache as dead and overstates the stay-put cost, which is
// visible, self-correcting, and never talks the operator into a switch that
// costs more than they were told.
//
// A gateway that knows better should publish cacheTtlSeconds; an explicit
// value always wins over this floor.
const DefaultCacheTtlSeconds = 300

// ResolveCacheTtlSeconds reports the prompt-cache lifetime for a model.
//
// An explicit declared value always wins. Otherwise a model that declares
// caching gets DefaultCacheTtlSeconds, whatever provider serves it. This is
// deliberately provider-blind: an enterprise gateway serves models under its
// own provider id and frequently publishes rates without a lifetime, and every
// such model previously resolved to zero. Consumers read zero as "no declared
// lifetime" and cannot tell a live prompt cache from an expired one, so they
// are forced to hedge instead of pricing the turn — for exactly the models an
// enterprise operator runs all day.
//
// supportsCaching is still honored: a model that says it does not cache has no
// lifetime, and inventing one would claim a cache that is never written.
func ResolveCacheTtlSeconds(supportsCaching bool, explicit int) int {
	if explicit > 0 {
		return explicit
	}
	if !supportsCaching {
		return 0
	}
	return DefaultCacheTtlSeconds
}

// catalogCacheTtlSeconds resolves the lifetime for a catalog entry.
func catalogCacheTtlSeconds(e catalogEntry) int {
	return ResolveCacheTtlSeconds(e.SupportsCaching, e.CacheTtlSeconds)
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
	// DisplayName: non-empty user value wins (additive, matches the rule above).
	// Lets a custom/user-config model entry declare its own picker label.
	if user.DisplayName != "" {
		merged.DisplayName = user.DisplayName
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
	// Cache lifetime: non-zero user value wins (additive, matches the rule
	// above). Lets a user-config model declare a different cache tier than the
	// one its provider defaults to.
	if user.CacheTtlSeconds != 0 {
		merged.CacheTtlSeconds = user.CacheTtlSeconds
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
	// ModelKind: non-empty user value wins. Lets a custom model entry declare
	// its kind (e.g. "image") explicitly. Additive — matches the rule above.
	if user.ModelKind != "" {
		merged.ModelKind = user.ModelKind
	}
	// Dialect: non-empty user value wins (additive, matches the rule above).
	// Lets a user-config model entry pin its wire protocol for gateway dispatch.
	if user.Dialect != "" {
		merged.Dialect = user.Dialect
	}
	// CostPerImage: non-zero user value wins (additive, matches the rule above).
	if user.CostPerImage != 0 {
		merged.CostPerImage = user.CostPerImage
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
			DisplayName:            e.DisplayName,
			ContextWindow:          e.ContextWindow,
			CostPer1kInput:         e.CostPer1kInput,
			CostPer1kOutput:        e.CostPer1kOutput,
			CostPer1kCacheCreation: e.CostPer1kCacheCreation,
			CostPer1kCacheRead:     e.CostPer1kCacheRead,
			SupportsCaching:        e.SupportsCaching,
			CacheTtlSeconds:        catalogCacheTtlSeconds(e),
			SupportsThinking:       e.SupportsThinking,
			SupportsImages:         e.SupportsImages,
			MaxOutputTokens:        e.MaxOutputTokens,
			ThinkingMode:           e.ThinkingMode,
			ThinkingEfforts:        e.ThinkingEfforts,
			Tokenizer:              e.Tokenizer,
			ModelKind:              e.ModelKind,
			Dialect:                e.Dialect,
			CostPerImage:           e.CostPerImage,
		})
	}
	utils.LogWithFields(utils.LevelInfo, "Registry", "models loaded from catalog", map[string]any{"count": len(entries)})
	return nil
}
