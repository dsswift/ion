// Package types — EngineEvent is the tagged-union outbound event surface
// of the engine. Lives in its own file because the struct grew to ~290
// lines as more fields were added to support new event variants; the
// shared types.go (sessions, agents, providers, plan-mode) keeps a
// smaller surface this way.
package types

import "encoding/json"

// --- Engine Events ---

// EngineEvent is a tagged union of all engine-emitted events.
// Populate the fields relevant to the specific Type.
type EngineEvent struct {
	Type string `json:"type"`

	// engine_agent_state
	Agents []AgentStateUpdate `json:"agents"`

	// engine_status
	Fields *StatusFields `json:"fields,omitempty"`

	// engine_session_status — Phase 3 of the state-management overhaul.
	// Typed counterpart to engine_status that carries a SessionStatus
	// payload. Emitted in parallel with engine_status during the
	// transition window. Once Phase 4 lands and the legacy
	// engine_status emission is removed (a deliberate contract break
	// gated on the published deprecation policy), this is the sole
	// authoritative status surface. See types.SessionStatus for the
	// payload's per-field contract.
	SessionStatus *SessionStatus `json:"sessionStatus,omitempty"`

	// engine_working_message, engine_notify, engine_error, engine_harness_message
	EventMessage  string `json:"message,omitempty"`
	Level         string `json:"level,omitempty"`
	ErrorCode     string `json:"errorCode,omitempty"`
	ErrorCategory string `json:"errorCategory,omitempty"`
	Retryable     bool   `json:"retryable,omitempty"`
	RetryAfterMs  int64  `json:"retryAfterMs,omitempty"`
	HttpStatus    int    `json:"httpStatus,omitempty"`

	// engine_harness_message
	HarnessSource string `json:"source,omitempty"`

	// Metadata is an opaque harness-defined map carried verbatim by the
	// engine to clients. The engine attaches no semantics — it forwards the
	// map unchanged in JSON marshal/unmarshal. Clients (desktop renderer,
	// iOS, custom harnesses) may honor specific conventions defined on the
	// consumer side; e.g. the desktop honors `metadata.dedupKey` on
	// `engine_harness_message` to suppress repeated emissions within an
	// engine-instance scrollback. The convention is documented in
	// docs/protocol/server-events.md (well-known metadata keys), not
	// enforced here. Intended for small structured hints, not state
	// transfer — reviewers should push back on multi-kilobyte payloads.
	// Mirrors AgentStateUpdate.Metadata's shape and serialization.
	Metadata map[string]interface{} `json:"metadata,omitempty"`

	// engine_dialog
	DialogID      string   `json:"dialogId,omitempty"`
	Method        string   `json:"method,omitempty"`
	Title         string   `json:"title,omitempty"`
	DialogOptions []string `json:"options,omitempty"`
	DefaultValue  string   `json:"defaultValue,omitempty"`

	// engine_text_delta
	TextDelta string `json:"text,omitempty"`

	// engine_message_end
	EndUsage *MessageEndUsage `json:"usage,omitempty"`

	// engine_tool_start
	ToolName string `json:"toolName,omitempty"`
	ToolID   string `json:"toolId,omitempty"`

	// engine_tool_update
	ToolPartialInput string `json:"partialInput,omitempty"`

	// engine_tool_complete (pointer avoids zero-value omission for index 0)
	ToolIndex *int `json:"index,omitempty"`

	// engine_tool_end
	ToolResult  string `json:"result,omitempty"`
	ToolIsError bool   `json:"isError,omitempty"`

	// engine_tool_stalled
	ToolElapsed float64 `json:"toolElapsed,omitempty"`

	// engine_run_stalled — workflow signal emitted exactly once per run
	// when the engine's progress watchdog detects that the run has made
	// no forward progress for longer than the configured threshold and
	// is about to cancel the run as a safety backstop. Mirrors the
	// underlying RunStalledEvent NormalizedEvent variant. The
	// authoritative completion signal remains the follow-up
	// TaskCompleteEvent + emitExit; this event is advisory so consumers
	// that want to distinguish "stalled" from generic "errored" can do
	// so (e.g. desktop renders a watchdog icon, iOS surfaces a distinct
	// notification, headless harnesses may opt to retry). See
	// engine/internal/backend/runloop_watchdog.go for the watchdog
	// implementation and CLAUDE.md § "The typed-event corollary" for
	// the rule that this typed event is the engine's complete
	// signaling surface for stall detection.
	RunStalledDuration     float64 `json:"runStalledDuration,omitempty"`
	RunStalledLastActivity string  `json:"runStalledLastActivity,omitempty"`

	// engine_steer_injected — character count of a mid-turn steer
	// message the engine drained into the conversation before the next
	// LLM call. Clients use this to confirm a steer was captured without
	// echoing the message body back over the wire. See
	// SteerInjectedEvent for the underlying normalized variant.
	SteerMessageLength int `json:"steerMessageLength,omitempty"`

	// engine_model_fallback — workflow signal emitted when the engine
	// fell back to its configured defaultModel because the requested
	// model didn't resolve to a provider. Mirrors the underlying
	// ModelFallbackEvent NormalizedEvent variant. Fields are surfaced
	// distinctly (not packed into Metadata) so a typed client like the
	// desktop or iOS doesn't have to parse an opaque map to learn the
	// fallback decision. Consumers may surface a status indicator,
	// abort orchestration, log a metric, or ignore the event — see
	// CLAUDE.md § "The typed-event corollary".
	FallbackRequestedModel string `json:"fallbackRequestedModel,omitempty"`
	FallbackModel          string `json:"fallbackModel,omitempty"`
	FallbackReason         string `json:"fallbackReason,omitempty"`

	// engine_dead
	ExitCode   *int     `json:"exitCode,omitempty"`
	Signal     *string  `json:"signal,omitempty"`
	StderrTail []string `json:"stderrTail,omitempty"`

	// engine_permission_request
	QuestionID    string          `json:"questionId,omitempty"`
	PermToolName  string          `json:"permToolName,omitempty"`
	PermToolDesc  string          `json:"permToolDescription,omitempty"`
	PermToolInput map[string]any  `json:"permToolInput,omitempty"`
	PermOptions   []PermissionOpt `json:"permOptions,omitempty"`

	// engine_plan_mode_changed
	PlanModeEnabled  bool   `json:"planModeEnabled,omitempty"`
	PlanModeFilePath string `json:"planFilePath,omitempty"`
	// PlanModeSlug mirrors PlanModeChangedEvent.PlanSlug: the basename of
	// the plan file without the ".md" extension, surfaced so clients can
	// render a human-readable plan identifier. See PlanModeChangedEvent
	// for the legacy-hex round-trip note.
	PlanModeSlug string `json:"planSlug,omitempty"`

	// engine_plan_proposal — workflow-level signal emitted when the model
	// proposes a plan-mode transition that requires user approval. Distinct
	// from engine_plan_mode_changed, which fires only on confirmed *state*
	// transitions. PlanProposalKind discriminates the proposal ("exit"
	// initially; future kinds may include "enter", "amend"). PlanFilePath
	// and PlanModeSlug are shared with engine_plan_mode_changed since the
	// shape is identical; only the discriminator differs. See
	// docs/architecture/adr/003-state-events-vs-workflow-events.md.
	PlanProposalKind string `json:"planProposalKind,omitempty"`

	// engine_plan_mode_auto_exit — sibling to engine_plan_proposal.
	// Fires when the engine deterministically synthesizes an ExitPlanMode
	// call at end-of-turn because the model ended a plan-mode run without
	// invoking ExitPlanMode or AskUserQuestion (issue #187). Both events
	// surface the plan-approval card, but this one additionally tells
	// consumers the exit was engine-driven rather than model-driven.
	//
	// Fields use the planModeAutoExit* prefix to avoid colliding with
	// other event variants that share field name primitives (StopReason
	// in particular collides with early-stop, which already uses
	// earlyStopStopReason). PlanFilePath and PlanModeSlug are reused
	// from engine_plan_mode_changed / engine_plan_proposal since the
	// shape is identical.
	PlanModeAutoExitStopReason string `json:"planModeAutoExitStopReason,omitempty"`
	PlanModeAutoExitReason     string `json:"planModeAutoExitReason,omitempty"`
	PlanModeAutoExitSessionID  string `json:"planModeAutoExitSessionId,omitempty"`
	PlanModeAutoExitRunID      string `json:"planModeAutoExitRunId,omitempty"`

	// engine_compacting
	CompactingActive         bool   `json:"active,omitempty"`
	CompactingSummary        string `json:"summary,omitempty"`
	CompactingMessagesBefore int    `json:"messagesBefore,omitempty"`
	CompactingMessagesAfter  int    `json:"messagesAfter,omitempty"`
	CompactingClearedBlocks  int    `json:"clearedBlocks,omitempty"`
	CompactingStrategy       string `json:"strategy,omitempty"`

	// engine_extension_died, engine_extension_respawned, engine_extension_dead_permanent
	ExtensionName string `json:"extensionName,omitempty"`
	AttemptNumber int    `json:"attemptNumber,omitempty"`

	// engine_elicitation_request, engine_elicitation_response
	// RequestID identifies the elicitation; clients echo it back via the
	// elicitation_response command. Schema, Url, and Mode describe what to
	// render. Response/Cancelled describe the user's reply (engine_elicitation_response).
	ElicitRequestID string                 `json:"requestId,omitempty"`
	ElicitSchema    map[string]interface{} `json:"schema,omitempty"`
	ElicitURL       string                 `json:"url,omitempty"`
	ElicitMode      string                 `json:"elicitMode,omitempty"`
	ElicitResponse  map[string]interface{} `json:"response,omitempty"`
	ElicitCancelled bool                   `json:"cancelled,omitempty"`

	// engine_command_registry — complete snapshot of slash commands exposed by
	// the session's currently-loaded extensions. Emitted at session_start (after
	// extensions wire up) and on every subsequent change to the command map
	// (RegisterCommand from inside a hook, extension hot reload, etc.). Consumers
	// REPLACE their cached set with this payload; never merge. An empty slice is
	// the authoritative "no extension commands" signal.
	Commands []EngineCommandListing `json:"commands,omitempty"`

	// engine_command_result — `Command` carries the bare name (e.g. "clear",
	// "ion--review-changes") so a consumer can switch on it without reparsing
	// EventMessage prose. `CommandError` is set when the result is a failure
	// (extension error, unknown command). Together these let consumers
	// distinguish "ran fine" from "engine disclaims this name" and route to
	// whatever fallback they own.
	Command      string `json:"command,omitempty"`
	CommandError string `json:"commandError,omitempty"`

	// engine_export — ExportFormat carries the rendered format the engine
	// produced ("markdown" | "json" | "html" | "jsonl"), driven by the
	// /export args (defaults to "markdown"). Consumers use it to pick a
	// file extension / MIME type instead of sniffing the payload bytes.
	// The rendered payload itself rides on EventMessage (`message`).
	ExportFormat string `json:"exportFormat,omitempty"`

	// engine_early_stop_decision_request — request/response wire protocol for
	// the before_early_stop_decision hook. Promotes the hook to the socket so
	// socket-only harnesses can participate without running
	// a subprocess extension. Mirrors the permission_request / elicitation_request
	// patterns: engine emits this event carrying the full decision payload, then
	// blocks briefly on a channel; consumers reply via the early_stop_decision_response
	// client command. Extension-side subprocess hooks (registered via the TS/Go
	// SDK) fire first and take precedence — the wire event only emits when no
	// extension expressed an opinion. A short timeout (default 100ms) prevents
	// a missing or slow consumer from stalling the run.
	//
	// Field semantics mirror extension.EarlyStopDecisionInfo verbatim; the
	// wire layer simply translates between EngineEvent (flat) and the typed
	// extension struct. Adding a field here requires adding it on both sides
	// of the protocol (types.go + Manager.emit path + ClientCommand response).
	EarlyStopRequestID             string `json:"earlyStopRequestId,omitempty"`
	EarlyStopRunID                 string `json:"earlyStopRunId,omitempty"`
	EarlyStopModel                 string `json:"earlyStopModel,omitempty"`
	EarlyStopTurnNumber            int    `json:"earlyStopTurnNumber,omitempty"`
	EarlyStopStopReason            string `json:"earlyStopStopReason,omitempty"`
	EarlyStopCumulativeOutput      int    `json:"earlyStopCumulativeOutput,omitempty"`
	EarlyStopBudget                int    `json:"earlyStopBudget,omitempty"`
	EarlyStopThresholdPct          int    `json:"earlyStopThresholdPct,omitempty"`
	EarlyStopContinuationCount     int    `json:"earlyStopContinuationCount,omitempty"`
	EarlyStopMaxContinuations      int    `json:"earlyStopMaxContinuations,omitempty"`
	EarlyStopLastContinuationDelta int    `json:"earlyStopLastContinuationDelta,omitempty"`
	EarlyStopWouldContinue         bool   `json:"earlyStopWouldContinue,omitempty"`
	EarlyStopIsSubagent            bool   `json:"earlyStopIsSubagent,omitempty"`

	// --- Async-trigger events (D-010 / D-011) ---
	//
	// Webhook fire events: engine_webhook_received, engine_webhook_authenticated,
	// engine_webhook_handler_error, engine_webhook_responded.
	// Webhook lifecycle events: engine_webhook_registered, engine_webhook_deregistered.
	// Schedule fire events: engine_schedule_fired, engine_schedule_skipped,
	// engine_schedule_failed.
	// Schedule lifecycle events: engine_schedule_registered, engine_schedule_deregistered.
	// Shared error: engine_async_fire_dropped.
	//
	// All of these are observation-only — the engine emits them so the
	// desktop / iOS can render a "what's registered" panel and an
	// audit log of fires. Consumers MUST NOT depend on these for
	// state machines; they are advisory.
	//
	// AsyncKind is "webhook" or "schedule" — discriminator for the
	// engine_*_registered / engine_*_deregistered and engine_async_fire_dropped
	// events. Carried as a free-form string so future kinds (e.g. queue
	// listeners) don't force a wire break.
	AsyncKind string `json:"asyncKind,omitempty"`
	// AsyncID is the declaration's stable id within its kind (webhook
	// path or schedule job id). Carried on every async event so a
	// consumer can correlate received → authenticated → responded by
	// (kind, id, requestId).
	AsyncID string `json:"asyncId,omitempty"`
	// AsyncOrigin is "init" or "runtime" — set on lifecycle events
	// only. Lets the operator distinguish bulk init declarations from
	// dynamic post-init add/remove.
	AsyncOrigin string `json:"asyncOrigin,omitempty"`
	// AsyncReason discriminates the cause for negative-path async
	// events: engine_webhook_handler_error ("auth", "body_size",
	// "handler_failed", "timeout"); engine_schedule_skipped
	// ("disabled"); engine_schedule_failed (free-form);
	// engine_async_fire_dropped ("no_session", "cap_exceeded",
	// "subprocess_dead", "unregistered").
	AsyncReason string `json:"asyncReason,omitempty"`
	// AsyncDecl carries the declaration JSON for engine_*_registered /
	// engine_*_deregistered events so a renderer can show "registered
	// /webhook/foo via init handshake" without keeping its own table.
	// Auth secrets are NEVER included — only the auth shape and the
	// opaque TokenRefName.
	AsyncDecl json.RawMessage `json:"asyncDecl,omitempty"`
	// AsyncRequestID correlates a single webhook request from received
	// → authenticated → handler_error/responded for downstream tracing.
	// Schedule fires omit this (each fire is its own event).
	AsyncRequestID string `json:"asyncRequestId,omitempty"`
	// AsyncMethod / AsyncPath / AsyncStatus describe an engine_webhook_*
	// event's HTTP layer. Method is "POST" / "GET" / …; Path mirrors
	// AsyncID for symmetry; Status is the response status code
	// (engine_webhook_responded, engine_webhook_handler_error).
	AsyncMethod string `json:"asyncMethod,omitempty"`
	AsyncPath   string `json:"asyncPath,omitempty"`
	AsyncStatus int    `json:"asyncStatus,omitempty"`
	// AsyncDurationMs is the elapsed time of a fire from receipt to
	// response (webhook) or fire to handler-return (schedule).
	AsyncDurationMs int64 `json:"asyncDurationMs,omitempty"`

	// --- engine_llm_call ---
	//
	// Emitted exactly once when ctx.LLMCall completes successfully. This is
	// the lightweight-inference counterpart to the rich telemetry the agent
	// loop emits via engine_message_end / engine_status: LLMCall does not
	// produce a streamed conversation, so consumers need a single
	// observability event carrying the post-call metadata in one place.
	//
	// The event NEVER carries the prompt text or the response content —
	// LLMCall is often used for sensitive extraction / classification
	// prompts (private-memory recall, intent routing) and the engine
	// refuses to put that material on the wire. Consumers that want to log
	// content must do so inside the extension that owns the call.
	//
	// Field set:
	//   - LlmCallModel:        model name the call resolved to
	//   - LlmCallProvider:     provider id ("anthropic", "openai", "ollama", …)
	//   - LlmCallLatencyMs:    elapsed wall-clock time of the call
	//   - LlmCallInputTokens:  prompt tokens reported by the provider
	//   - LlmCallOutputTokens: completion tokens reported by the provider
	//   - LlmCallCost:         USD cost estimate via the model registry
	//   - LlmCallJsonMode:     true when the call requested JSON output
	//
	// No event is emitted on the error path; LLMCall returns (nil, error)
	// and the caller decides whether to surface a harness-level event.
	LlmCallModel        string  `json:"llmCallModel,omitempty"`
	LlmCallProvider     string  `json:"llmCallProvider,omitempty"`
	LlmCallLatencyMs    int64   `json:"llmCallLatencyMs,omitempty"`
	LlmCallInputTokens  int     `json:"llmCallInputTokens,omitempty"`
	LlmCallOutputTokens int     `json:"llmCallOutputTokens,omitempty"`
	LlmCallCost         float64 `json:"llmCallCost,omitempty"`
	LlmCallJsonMode     bool    `json:"llmCallJsonMode,omitempty"`

	// --- engine_dispatch_start / engine_dispatch_end ---
	//
	// Emitted on the parent session's event stream when an extension-initiated
	// dispatch begins and ends. These are factual telemetry events — not agent
	// state (which the harness owns via engine_agent_state). With these events,
	// harnesses can persist dispatch records or surface dispatch status in UIs
	// without hand-rolling plumbing.
	//
	// engine_dispatch_start fields:
	//   - DispatchAgent:     the dispatched agent name
	//   - DispatchTask:      the task string passed to the agent
	//   - DispatchModel:     the resolved model for the dispatch
	//   - DispatchSessionID: the child session's request ID
	//
	// engine_dispatch_end fields:
	//   - DispatchAgent:       the dispatched agent name
	//   - DispatchExitCode:    0=success, 1=error, 2=recalled
	//   - DispatchElapsed:     wall-clock seconds
	//   - DispatchCost:        USD cost of the dispatch
	//   - DispatchInputTokens: total input tokens
	//   - DispatchOutputTokens: total output tokens
	//   - DispatchToolCount:   number of tool calls made during dispatch
	//   - DispatchThinkingTokens: estimated reasoning tokens (subset of output;
	//     see ThinkingBlockEndEvent.TotalTokens for the estimate caveat). Lets
	//     cost/audit consumers separate reasoning spend from user-facing output.
	DispatchAgent          string  `json:"dispatchAgent,omitempty"`
	DispatchTask           string  `json:"dispatchTask,omitempty"`
	DispatchModel          string  `json:"dispatchModel,omitempty"`
	DispatchSessionID      string  `json:"dispatchSessionId,omitempty"`
	DispatchExitCode       int     `json:"dispatchExitCode,omitempty"`
	DispatchElapsed        float64 `json:"dispatchElapsed,omitempty"`
	DispatchCost           float64 `json:"dispatchCost,omitempty"`
	DispatchInputTokens    int     `json:"dispatchInputTokens,omitempty"`
	DispatchOutputTokens   int     `json:"dispatchOutputTokens,omitempty"`
	DispatchToolCount      int     `json:"dispatchToolCount,omitempty"`
	DispatchThinkingTokens int     `json:"dispatchThinkingTokens,omitempty"`

	// --- Resource subsystem events (D-007) ---
	//
	// engine_resource_snapshot: emitted when a client subscribes to a
	// resource kind. Carries the full set of items the producer returned
	// for the subscription's filter. Consumers REPLACE their local
	// collection with this payload.
	//
	// engine_resource_delta: emitted when a producer publishes a change
	// (create, update, delete, mark_read). Consumers apply the delta
	// incrementally to their local collection.
	//
	// Both events carry ResourceKind and ResourceSubID so consumers can
	// correlate events with their active subscriptions.
	ResourceKind  string         `json:"resourceKind,omitempty"`
	ResourceSubID string         `json:"resourceSubId,omitempty"`
	ResourceItems []ResourceItem `json:"resourceItems,omitempty"`
	ResourceDelta *ResourceDelta `json:"resourceDelta,omitempty"`

	// --- Notification events (D-009) ---
	//
	// engine_notification: emitted when an extension calls ctx.Notify.
	// The Push/PushTitle/PushBody fields trigger APNs delivery through
	// the relay when the mobile peer is not connected — the relay checks
	// these fields on any forwarded message, so no relay changes are needed.
	// NotifyKind/ResourceID/Title/Body/Sound/Scope carry structured metadata
	// for clients that want richer handling beyond the basic push title/body.
	Push             bool   `json:"push,omitempty"`
	PushTitle        string `json:"pushTitle,omitempty"`
	PushBody         string `json:"pushBody,omitempty"`
	NotifyKind       string `json:"notifyKind,omitempty"`
	NotifyResourceID string `json:"notifyResourceId,omitempty"`
	NotifyTitle      string `json:"notifyTitle,omitempty"`
	NotifyBody       string `json:"notifyBody,omitempty"`
	NotifySound      string `json:"notifySound,omitempty"`
	NotifyScope      string `json:"notifyScope,omitempty"`

	// --- engine_intercept ---
	//
	// Fire-and-forget signal event emitted when an extension calls ctx.Intercept.
	// The engine attaches no semantics beyond routing the event to the target
	// session's stream. Clients decide how to render and whether to act on the
	// Level hint ("banner" = informational, "redirect" = urgent). There is no
	// "current intercept state" to query — the engine emits it exactly once per
	// ctx.Intercept() call and moves on.
	InterceptLevel    string                 `json:"interceptLevel,omitempty"`
	InterceptTitle    string                 `json:"interceptTitle,omitempty"`
	InterceptMessage  string                 `json:"interceptMessage,omitempty"`
	InterceptSource   string                 `json:"interceptSource,omitempty"` // extension name, set by engine
	InterceptMetadata map[string]interface{} `json:"interceptMetadata,omitempty"`

	// --- engine_plan_content ---
	//
	// Emitted in response to a get_plan_content command. Carries a bounded
	// byte-range window of a plan file so remote clients (e.g. iOS via the
	// desktop relay) can page through large plans without filesystem access
	// to the engine host.
	//
	// PlanModeFilePath (json:"planFilePath") is REUSED for the plan file path —
	// the JSON key is identical for plan_mode_changed and plan_content events,
	// so no new field is needed for the path.
	//
	// PlanContentOffset is the byte offset of the first byte of Content.
	// PlanContentBody is the UTF-8 string for this byte-range window.
	// PlanContentTotalBytes is the file size at read time.
	// PlanContentHasMore is true when more data follows.
	//
	// The wire JSON keys (offset, content, totalBytes, hasMore) are the
	// canonical names that the iOS and desktop clients reference (1a9b6a87).
	PlanContentOffset     int    `json:"offset,omitempty"`
	PlanContentBody       string `json:"content,omitempty"`
	PlanContentTotalBytes int    `json:"totalBytes,omitempty"`
	PlanContentHasMore    bool   `json:"hasMore,omitempty"`

	// --- Extended-thinking events (issue #158) ---
	//
	// engine_thinking_block_start: reasoning block began (no fields).
	// engine_thinking_delta: incremental reasoning text (ThinkingText). Gated
	//   by ThinkingConfig.StreamDeltas (default on) — boundaries always emit.
	// engine_thinking_block_end: reasoning block finished, carrying a summary
	//   (ThinkingTotalTokens, ThinkingElapsedSeconds, ThinkingRedacted).
	//
	// Mirror the underlying Thinking*Event NormalizedEvent variants. Surfaced
	// distinctly (not packed into Metadata) so typed clients (desktop, iOS)
	// read them without parsing an opaque map. See normalized_event.go for the
	// per-block emission contract (optional per turn; signature_delta excluded;
	// redacted_thinking sets ThinkingRedacted). ThinkingTotalTokens is an
	// estimate — see ThinkingBlockEndEvent.TotalTokens.
	ThinkingText           string  `json:"thinkingText,omitempty"`
	ThinkingTotalTokens    int     `json:"thinkingTotalTokens,omitempty"`
	ThinkingElapsedSeconds float64 `json:"thinkingElapsedSeconds,omitempty"`
	ThinkingRedacted       bool    `json:"thinkingRedacted,omitempty"`
}
