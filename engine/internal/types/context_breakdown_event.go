// Package types — context_breakdown_event.go
//
// The ContextBreakdownEvent NormalizedEvent variant and its row type. Split
// out of normalized_event.go to keep that file under the 800-line cap. The
// wire (EngineEvent) counterpart is ContextBreakdownPayload in engine_event.go;
// the translation lives in session/event_translation_translate.go.
package types

// ContextBreakdownEvent carries a per-category token breakdown for the active run.
// Emitted once after prompt assembly and again after the first UsageEvent
// reconciliation (with APIReportedTotal and Unaccounted populated).
type ContextBreakdownEvent struct {
	// Categories is the ordered list of named token rows.
	Categories    []ContextBreakdownCategory `json:"categories"`
	ContextWindow int                        `json:"contextWindow"`
	TotalTokens   int                        `json:"totalTokens"`
	// APIReportedTotal is the provider's reported input_tokens. Zero until reconciliation.
	APIReportedTotal int `json:"apiReportedTotal,omitempty"`
	// Unaccounted is APIReportedTotal - TotalTokens. Non-zero after reconciliation.
	Unaccounted int `json:"unaccounted,omitempty"`
	// CacheReadTokens is the provider-reported cache-read input tokens.
	// Annotation only — NOT included in TotalTokens. Zero until reconciliation.
	CacheReadTokens int `json:"cacheReadTokens,omitempty"`
	// CacheCreationTokens is the provider-reported cache-creation input tokens.
	// Annotation only — NOT included in TotalTokens. Zero until reconciliation.
	CacheCreationTokens int    `json:"cacheCreationTokens,omitempty"`
	Model               string `json:"model"`
	// AggregateCostUsd is the sum of this session's cost plus every descendant
	// dispatch session's cost, walked on demand from the conversation tree.
	// Zero for fresh sessions and sessions with no dispatches.
	AggregateCostUsd float64 `json:"aggregateCostUsd,omitempty"`
	// ModelBreakdown is the per-model cost breakdown for this conversation's
	// dispatch tree. Populated by the on-demand breakdown (ComputeAndEmitContextBreakdown).
	// Empty for runloop-emitted breakdowns, which fire before attribution is
	// complete. Sorted by CostUsd descending (highest spend first).
	ModelBreakdown []ModelBreakdown `json:"modelBreakdown,omitempty"`
}

func (ContextBreakdownEvent) eventType() string { return EventContextBreakdown }

// ContextBreakdownCategory is one row in a ContextBreakdownEvent.
type ContextBreakdownCategory struct {
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	Tokens int    `json:"tokens"`
	Tier   string `json:"tier"` // "exact", "local", "approximate"
	Path   string `json:"path,omitempty"`
}
