package conversation

import "github.com/dsswift/ion/engine/internal/types"

// ContextCapacity is the usable input budget for one provider request. RawLimit
// is the model context window. EffectiveLimit reserves space for the next model
// response and a compaction summary, so the request never treats all raw context
// tokens as available input capacity.
type ContextCapacity struct {
	RawLimit       int
	EffectiveLimit int
	OutputReserve  int
	SummaryReserve int
}

// ResolveContextCapacity calculates the input budget for a model. An explicit
// run MaxTokens wins, then the model registry's MaxOutputTokens, then the
// engine default. A positive raw limit always produces at least one usable
// token, even for intentionally tiny test or custom-model windows.
func ResolveContextCapacity(rawLimit, maxTokens, modelMaxOutputTokens, summaryReserve int) ContextCapacity {
	outputReserve := maxTokens
	if outputReserve <= 0 {
		outputReserve = modelMaxOutputTokens
	}
	if outputReserve <= 0 {
		outputReserve = DefaultMaxOutputTokens
	}
	if summaryReserve <= 0 {
		summaryReserve = DefaultCompactSummaryReserve
	}

	capacity := ContextCapacity{
		RawLimit:       rawLimit,
		OutputReserve:  outputReserve,
		SummaryReserve: summaryReserve,
	}
	if rawLimit <= 0 {
		return capacity
	}
	capacity.EffectiveLimit = rawLimit - outputReserve - summaryReserve
	if capacity.EffectiveLimit < 1 {
		capacity.EffectiveLimit = 1
	}
	return capacity
}

// ResolveModelContextCapacity applies the registered model's declared output
// capacity to a raw context window.
func ResolveModelContextCapacity(rawLimit, maxTokens int, model *types.ModelInfo) ContextCapacity {
	modelMaxOutputTokens := 0
	if model != nil {
		modelMaxOutputTokens = model.MaxOutputTokens
	}
	return ResolveContextCapacity(rawLimit, maxTokens, modelMaxOutputTokens, DefaultCompactSummaryReserve)
}

// WarningLimit is the point where the engine warns consumers before the hard
// effective limit. It is deliberately derived from EffectiveLimit rather than
// the raw model window so warning and rejection use one capacity contract.
func (c ContextCapacity) WarningLimit() int {
	return c.EffectiveLimit * 80 / 100
}

// AutoCompactLimit returns the proactive compaction threshold for this capacity.
// Legacy configuration documented threshold as a 0..1 ratio, while older callers
// also supplied 1..100 percentages. Accept both forms so existing overrides keep
// their behavior; otherwise use the model-aware effective input limit.
func (c ContextCapacity) AutoCompactLimit(legacyThreshold float64) int {
	if legacyThreshold <= 0 {
		return c.EffectiveLimit
	}
	if legacyThreshold <= 1 {
		return int(float64(c.RawLimit) * legacyThreshold)
	}
	return int(float64(c.RawLimit) * legacyThreshold / 100.0)
}

// AutoCompactTokenLimit remains the compatibility entry point for callers that
// only have a raw window and an explicit output limit.
func AutoCompactTokenLimit(window, maxOutputTokens int) int {
	return ResolveContextCapacity(window, maxOutputTokens, 0, DefaultCompactSummaryReserve).AutoCompactLimit(0)
}
