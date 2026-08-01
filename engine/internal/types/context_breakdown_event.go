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
	// OccupancyTokens is the engine's authoritative context-window occupancy:
	// the provider's reported usage for the most recent assistant turn, plus an
	// estimate for any messages appended since (tool results from the current
	// turn that have not yet been sent to the provider). It is the SAME figure
	// the engine publishes as StatusFields.ContextTokens and the same input the
	// proactive-compaction gate measures against its limit.
	//
	// This is what a consumer should divide by ContextWindow to render "how full
	// is the context". It is deliberately distinct from the two neighbouring
	// fields:
	//
	//   TotalTokens      — the ITEMIZED per-category sum. An independent
	//                      estimate, useful for attribution ("what is taking up
	//                      the space"), not for occupancy.
	//   APIReportedTotal — the raw provider input_tokens for the last turn, with
	//                      nothing added for messages appended since.
	//
	// Published because a consumer computing occupancy from the breakdown alone
	// would otherwise have to re-derive it, and the two available approximations
	// both drift: TotalTokens over-reports (it counts content the provider did
	// not bill for this turn), and APIReportedTotal under-reports mid-turn (it
	// omits tool results not yet sent). Emitting the engine's own figure means a
	// consumer reading the breakdown and a consumer reading engine_status agree
	// by construction rather than by luck.
	//
	// Zero when the engine has no occupancy figure for the conversation.
	OccupancyTokens int `json:"occupancyTokens,omitempty"`
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
