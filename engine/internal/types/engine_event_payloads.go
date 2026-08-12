package types

// engine_event_payloads.go — the nested payload structs carried inside
// EngineEvent.
//
// Split out of engine_event.go, which reached its 800-line cap. The seam is
// natural rather than arbitrary: EngineEvent is the flat wire envelope, while
// these are the structured sub-objects a few of its variants nest. Splitting
// on that boundary keeps each file about one thing, and keeps the comments on
// both intact -- the alternative of trimming documentation to fit the cap
// would trade the explanations for line count.

// ContextBreakdownPayload is the payload for engine_context_breakdown events.
// Mirrors the internal ContextBreakdownEvent shape. All token counts are
// itemized per category; Tier records how each count was obtained ("exact"
// from a provider count-tokens endpoint, "local" from the tiktoken BPE
// encoder, or "approximate" from the char/4 heuristic).
type ContextBreakdownPayload struct {
	Categories       []ContextBreakdownCategory `json:"categories"`
	ContextWindow    int                        `json:"contextWindow"`
	TotalTokens      int                        `json:"totalTokens"`
	APIReportedTotal int                        `json:"apiReportedTotal,omitempty"`
	Unaccounted      int                        `json:"unaccounted,omitempty"`
	// CacheReadTokens and CacheCreationTokens are provider-reported cache
	// annotations. Annotation only — NOT included in TotalTokens.
	CacheReadTokens     int    `json:"cacheReadTokens,omitempty"`
	CacheCreationTokens int    `json:"cacheCreationTokens,omitempty"`
	Model               string `json:"model"`
	// OccupancyTokens is the engine's authoritative context-window occupancy —
	// the same figure carried by StatusFields.ContextTokens and the same input
	// the proactive-compaction gate measures. Divide it by ContextWindow to
	// render "how full is the context".
	//
	// Distinct from its two neighbours by design: TotalTokens is the itemized
	// per-category sum (an independent estimate, for attribution), and
	// APIReportedTotal is the raw provider input_tokens for the last turn with
	// nothing added for messages appended since. See the field comment on
	// ContextBreakdownEvent for the full contract.
	//
	// Zero when the engine has no occupancy figure for the conversation.
	OccupancyTokens int `json:"occupancyTokens,omitempty"`
	// AggregateCostUsd is the sum of this session's cost plus every descendant
	// dispatch session's cost, computed on demand. Zero for sessions with no
	// dispatches or no cost yet.
	AggregateCostUsd float64 `json:"aggregateCostUsd,omitempty"`
	// ModelBreakdown is the per-model cost breakdown for the conversation dispatch
	// tree. Populated by the on-demand breakdown. Sorted by CostUsd descending.
	// Empty for runloop-emitted breakdowns.
	ModelBreakdown []ModelBreakdown `json:"modelBreakdown,omitempty"`
}

// BackgroundTaskCompletePayload is the payload for
// engine_background_task_complete events. Mirrors the internal
// BackgroundTaskCompleteEvent shape: a background bash command started with
// notify_on_complete reached a terminal state.
//
// RemainingTaskIDs is the session's still-outstanding notifying task set at
// the instant this task completed, so a consumer can render progress
// ("2 of 3 done") without having tracked the starts. Empty means this was the
// last outstanding command.
type BackgroundTaskCompletePayload struct {
	TaskID           string   `json:"taskId"`
	Status           string   `json:"status"`
	ExitCode         int      `json:"exitCode"`
	ElapsedMs        int64    `json:"elapsedMs"`
	OutputPath       string   `json:"outputPath,omitempty"`
	Tail             string   `json:"tail,omitempty"`
	Command          string   `json:"command,omitempty"`
	RemainingTaskIDs []string `json:"remainingTaskIds,omitempty"`
}

// DispatchLostPayload is the nested wire payload for engine_dispatch_lost
// events. Mirrors the internal DispatchLostEvent field-for-field; see that
// type (normalized_event_run_signals.go) for full semantics.
type DispatchLostPayload struct {
	DispatchID          string `json:"dispatchId"`
	AgentName           string `json:"agentName"`
	Task                string `json:"task,omitempty"`
	ParentDispatchID    string `json:"parentDispatchId,omitempty"`
	Depth               int    `json:"depth,omitempty"`
	ChildConversationID string `json:"childConversationId,omitempty"`
}
