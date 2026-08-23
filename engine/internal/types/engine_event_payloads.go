// Package types — nested wire payloads for EngineEvent.
//
// Split from engine_event.go for the file-size cap. Same package, same
// contract surface: every struct here is a nested payload carried by an
// EngineEvent field and serialized onto the engine wire as part of that
// event's JSON envelope.
package types

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

// BackgroundTaskTerminalPayload carries a terminal task record to clients.
type BackgroundTaskTerminalPayload struct {
	TaskID     string `json:"taskId"`
	Status     string `json:"status"`
	ExitCode   int    `json:"exitCode"`
	ElapsedMs  int64  `json:"elapsedMs"`
	Command    string `json:"command,omitempty"`
	OutputPath string `json:"outputPath,omitempty"`
	Tail       string `json:"tail,omitempty"`
}

// BackgroundWorkDeliveredPayload is the nested wire payload for
// engine_background_work_delivered events. Mirrors the internal
// BackgroundWorkDeliveredEvent; see that type for full semantics.
type BackgroundWorkDeliveredPayload struct {
	EntryID string             `json:"entryId"`
	Content string             `json:"content"`
	Work    BackgroundWorkInfo `json:"work"`
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
