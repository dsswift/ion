// Package types defines the wire-compatible Go equivalents of the Ion Engine
// TypeScript types. JSON struct tags match the TypeScript field names exactly.
package types

import "encoding/json"

// RawEngineEvent is a pass-through JSON representation of an engine event.
// Use this when forwarding events without parsing (e.g., socket relay).
type RawEngineEvent = json.RawMessage

// Stream-event payload shapes (InitEvent, StreamEvent, AssistantEvent,
// ResultEvent, UsageData, PermissionEvent, etc. — everything consumed off
// the Anthropic streaming API) live in stream_events.go. Split out so this
// file has headroom for ongoing EngineEvent surface growth.

// --- Message ---

// Message is a single entry in the conversation history.
type Message struct {
	ID               string `json:"id"`
	Role             string `json:"role"`
	Content          string `json:"content"`
	ToolName         string `json:"toolName,omitempty"`
	ToolInput        string `json:"toolInput,omitempty"`
	ToolID           string `json:"toolId,omitempty"`
	ToolStatus       string `json:"toolStatus,omitempty"`
	UserExecuted     bool   `json:"userExecuted,omitempty"`
	AutoExpandResult bool   `json:"autoExpandResult,omitempty"`
	Timestamp        int64  `json:"timestamp"`
}

// --- Engine Types ---

// EngineProfile defines an extension profile for the engine.
type EngineProfile struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Extensions []string `json:"extensions"`
}

// EngineConfig configures a single engine session.
type EngineConfig struct {
	ProfileID        string            `json:"profileId"`
	Extensions       []string          `json:"extensions"`
	WorkingDirectory string            `json:"workingDirectory"`
	SessionID        string            `json:"sessionId,omitempty"`
	Model            string            `json:"model,omitempty"`
	MaxTokens        int               `json:"maxTokens,omitempty"`
	Thinking         *ThinkingConfig   `json:"thinking,omitempty"`
	SystemHint       string            `json:"systemHint,omitempty"`

	// WorkspaceWatchIgnore overrides the engine's default ignore-glob list
	// for the workspace_file_changed watcher. When nil/empty the engine uses
	// its built-in defaults (.git/**, node_modules/**, dist/**, build/**,
	// target/**, .next/**, .nuxt/**, .venv/**, __pycache__/**, .ion/**,
	// .DS_Store, *.swp, *.swo, *.tmp, *~). A non-empty slice REPLACES the
	// defaults entirely -- it does not merge. Patterns use doublestar
	// (forward-slash) syntax and are matched against repo-relative paths.
	WorkspaceWatchIgnore []string `json:"workspaceWatchIgnore,omitempty"`

	// ClaudeCompat enables Claude Code compatibility features such as loading
	// skills from ~/.claude/skills/.
	ClaudeCompat bool `json:"claudeCompat,omitempty"`
}

// ThinkingConfig controls extended thinking for API-backend runs.
type ThinkingConfig struct {
	Enabled      bool `json:"enabled"`
	BudgetTokens int  `json:"budgetTokens,omitempty"`
}

// EngineInstance identifies a running engine instance.
type EngineInstance struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// EnginePaneState tracks the set of engine instances and which is active.
type EnginePaneState struct {
	Instances        []EngineInstance `json:"instances"`
	ActiveInstanceID *string          `json:"activeInstanceId"`
}

// AgentStateUpdate describes the current state of an agent.
type AgentStateUpdate struct {
	Name     string                 `json:"name"`
	ID       string                 `json:"id,omitempty"`
	Status   string                 `json:"status"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
}

// AgentMessage is a single message within an agent's conversation.
type AgentMessage struct {
	Role     string `json:"role"`
	Content  string `json:"content"`
	ToolName string `json:"toolName,omitempty"`
}

// AgentHandle is a process registration handle for per-agent abort/steer.
type AgentHandle struct {
	PID         int
	StdinWrite  func(message string) bool
	ParentAgent string
}

// AgentSpec is an LLM-visible agent definition. Mirrors the markdown
// frontmatter shape (name, description, model, tools, parent, systemPrompt).
// Specs are registered at runtime via Context.RegisterAgentSpec so an
// extension's `capability_match` handler can promote a draft into a live,
// named specialist that the Agent tool can immediately dispatch.
type AgentSpec struct {
	Name         string   `json:"name"`
	Description  string   `json:"description,omitempty"`
	Model        string   `json:"model,omitempty"`
	Tools        []string `json:"tools,omitempty"`
	Parent       string   `json:"parent,omitempty"`
	SystemPrompt string   `json:"systemPrompt,omitempty"`
}

// EngineCommandListing describes a single slash command exposed by a session's
// extensions. Consumers use this to populate a routing-hint cache so they can
// short-circuit local template lookups for command names the extensions own.
// Carried inside engine_command_registry events whose payload is always a
// complete snapshot of the session's current command set (see AGENTS.md
// snapshot-contract rules — consumers REPLACE local state, not merge).
type EngineCommandListing struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// StatusFields are the fields emitted by engine_status events.
type StatusFields struct {
	Label             string             `json:"label"`
	State             string             `json:"state"`
	SessionID         string             `json:"sessionId,omitempty"`
	Team              string             `json:"team,omitempty"`
	Model             string             `json:"model"`
	ContextPercent    int                `json:"contextPercent"`
	ContextWindow     int                `json:"contextWindow"`
	TotalCostUsd      float64            `json:"totalCostUsd,omitempty"`
	PermissionDenials []PermissionDenial `json:"permissionDenials,omitempty"`
	// ExtensionName is a friendly display name broadcast by the extension via
	// ext/emit engine_status. The engine preserves it across its own status
	// transitions so clients can show "Chief of Staff [idle]" instead of a
	// GUID compound key. Empty means no extension name was broadcast.
	ExtensionName string `json:"extensionName,omitempty"`
	// BackgroundAgents is the number of background dispatch agents still running
	// when the parent LLM turn ends. When > 0, the engine is "idle" (the parent
	// isn't running) but background work is in progress. Clients use this to keep
	// the tab status active and the interrupt button visible.
	BackgroundAgents int `json:"backgroundAgents,omitempty"`
}

// --- Engine Events ---

// EngineEvent is a tagged union of all engine-emitted events.
// Populate the fields relevant to the specific Type.
type EngineEvent struct {
	Type string `json:"type"`

	// engine_agent_state
	Agents []AgentStateUpdate `json:"agents"`

	// engine_status
	Fields *StatusFields `json:"fields,omitempty"`

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

	// engine_dead
	ExitCode   *int     `json:"exitCode,omitempty"`
	Signal     *string  `json:"signal,omitempty"`
	StderrTail []string `json:"stderrTail,omitempty"`

	// engine_permission_request
	QuestionID      string          `json:"questionId,omitempty"`
	PermToolName    string          `json:"permToolName,omitempty"`
	PermToolDesc    string          `json:"permToolDescription,omitempty"`
	PermToolInput   map[string]any  `json:"permToolInput,omitempty"`
	PermOptions     []PermissionOpt `json:"permOptions,omitempty"`

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
	EarlyStopRequestID            string `json:"earlyStopRequestId,omitempty"`
	EarlyStopRunID                string `json:"earlyStopRunId,omitempty"`
	EarlyStopModel                string `json:"earlyStopModel,omitempty"`
	EarlyStopTurnNumber           int    `json:"earlyStopTurnNumber,omitempty"`
	EarlyStopStopReason           string `json:"earlyStopStopReason,omitempty"`
	EarlyStopCumulativeOutput     int    `json:"earlyStopCumulativeOutput,omitempty"`
	EarlyStopBudget               int    `json:"earlyStopBudget,omitempty"`
	EarlyStopThresholdPct         int    `json:"earlyStopThresholdPct,omitempty"`
	EarlyStopContinuationCount    int    `json:"earlyStopContinuationCount,omitempty"`
	EarlyStopMaxContinuations     int    `json:"earlyStopMaxContinuations,omitempty"`
	EarlyStopLastContinuationDelta int    `json:"earlyStopLastContinuationDelta,omitempty"`
	EarlyStopWouldContinue        bool   `json:"earlyStopWouldContinue,omitempty"`
	EarlyStopIsSubagent           bool   `json:"earlyStopIsSubagent,omitempty"`

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
	DispatchAgent        string  `json:"dispatchAgent,omitempty"`
	DispatchTask         string  `json:"dispatchTask,omitempty"`
	DispatchModel        string  `json:"dispatchModel,omitempty"`
	DispatchSessionID    string  `json:"dispatchSessionId,omitempty"`
	DispatchExitCode     int     `json:"dispatchExitCode,omitempty"`
	DispatchElapsed      float64 `json:"dispatchElapsed,omitempty"`
	DispatchCost         float64 `json:"dispatchCost,omitempty"`
	DispatchInputTokens  int     `json:"dispatchInputTokens,omitempty"`
	DispatchOutputTokens int     `json:"dispatchOutputTokens,omitempty"`
	DispatchToolCount    int     `json:"dispatchToolCount,omitempty"`
}

// MessageEndUsage reports token usage at the end of a message.
type MessageEndUsage struct {
	InputTokens    int     `json:"inputTokens"`
	OutputTokens   int     `json:"outputTokens"`
	ContextPercent int     `json:"contextPercent"`
	Cost           float64 `json:"cost"`
}

// --- Run Options ---

// RunOptions configures a Claude run.
type RunOptions struct {
	Prompt             string          `json:"prompt"`
	ProjectPath        string          `json:"projectPath"`
	SessionID          string          `json:"sessionId,omitempty"`
	AllowedTools       []string        `json:"allowedTools,omitempty"`
	SuppressTools      []string        `json:"suppressTools,omitempty"`
	MaxTurns           int             `json:"maxTurns,omitempty"`
	MaxBudgetUsd       float64         `json:"maxBudgetUsd,omitempty"`
	SystemPrompt       string          `json:"systemPrompt,omitempty"`
	Model              string          `json:"model,omitempty"`
	HookSettingsPath   string          `json:"hookSettingsPath,omitempty"`
	AddDirs            []string        `json:"addDirs,omitempty"`
	PermissionModeCli  string          `json:"permissionModeCli,omitempty"`
	AppendSystemPrompt string          `json:"appendSystemPrompt,omitempty"`
	Source             string          `json:"source,omitempty"`
	McpConfig          string          `json:"mcpConfig,omitempty"`
	MaxTokens          int             `json:"maxTokens,omitempty"`
	Thinking           *ThinkingConfig `json:"thinking,omitempty"`
	MaxRetries         int             `json:"maxRetries,omitempty"`
	FallbackChain      []string        `json:"fallbackChain,omitempty"`
	Persistent         bool            `json:"persistent,omitempty"`
	PlanMode           bool            `json:"planMode,omitempty"`
	PlanModeTools      []string        `json:"planModeTools,omitempty"`
	PlanFilePath       string          `json:"planFilePath,omitempty"`
	PlanModePrompt     string          `json:"planModePrompt,omitempty"`
	// PlanModeSparseReminder is the harness-supplied text for the sparse
	// plan-mode reminder injected periodically during plan-mode runs.
	// Empty (the default) means the engine builds the reminder via
	// buildPlanModeSparseReminder. When non-empty, the engine forwards this
	// string verbatim instead. Parallel override path to PlanModePrompt:
	// both are additive omitempty fields; third-party harnesses that don't
	// set either inherit the engine defaults unchanged.
	// See docs/protocol/client-commands.md for the three-layer precedence
	// (RunOptions field → plan_mode_prompt hook → engine default).
	PlanModeSparseReminder string          `json:"planModeSparseReminder,omitempty"`
	PlanModeReentry    bool            `json:"planModeReentry,omitempty"`
	// ImplementationPhase tells the engine that this run is the "implement"
	// half of a plan-then-implement flow — the user has already approved a
	// plan and the model should execute it directly without proposing
	// another plan-mode entry. When set, the engine skips injecting the
	// EnterPlanMode sentinel tool entirely, so the model never sees the
	// option and cannot re-propose plan mode mid-run.
	//
	// Replaces the prior mechanism, which was a harness prepending a
	// "You are implementing a user-approved plan. Do not re-enter plan
	// mode..." preamble to the user prompt and the EnterPlanMode tool's
	// docstring instructing the model to recognize those phrases. That
	// substring-matching approach was brittle (translation-sensitive,
	// easy to bypass with paraphrasing) and bled UI/harness policy into
	// engine-visible prompt text. The boolean is the mechanical
	// equivalent: harness sets the flag, engine acts on it.
	//
	// Third-party harnesses doing implement-then-execute flows should
	// set this to true on the implementation run. The engine has no
	// opinion on what counts as "implementation"; that's the harness's
	// call.
	ImplementationPhase     bool         `json:"implementationPhase,omitempty"`
	// EnterPlanModeDescription is the harness-supplied prompt text for the
	// EnterPlanMode sentinel tool injected during auto-mode runs. When this
	// field is empty (the default), the engine falls back to a one-line
	// neutral fallback: "Switch the current session into plan mode."
	// When the harness supplies a non-empty string, the engine forwards it
	// verbatim as the tool's description so the model sees the harness's
	// framing — e.g. the conditions under which plan mode is appropriate,
	// the rules that apply once enabled, and any policy text the harness
	// wants the model to follow.
	//
	// Per ADR-004 (Move EnterPlanMode prose to harness): the engine ships
	// only the sentinel mechanism (tool injection + runloop interception);
	// the policy prose that tells the model *when* to enter plan mode and
	// *what* the rules are belongs in the harness. The Ion desktop client
	// is the reference harness implementation and ships its prose as the
	// ENTER_PLAN_MODE_DESCRIPTION constant in
	// desktop/src/main/prompt-pipeline.ts; it has no special status — any
	// harness supplies its own. See ADR-001 (parent boundary) and ADR-002
	// (the same pattern applied to early-stop continuation).
	//
	// Forward-compat: when the harness wants the engine default (a TUI
	// might prefer minimal framing, for instance), it leaves this empty.
	// The engine never imposes its own opinionated default beyond the
	// one-line fallback.
	EnterPlanModeDescription string       `json:"enterPlanModeDescription,omitempty"`
	CompactThreshold             float64  `json:"compactThreshold,omitempty"`
	CompactTargetPercent         float64  `json:"compactTargetPercent,omitempty"`
	CompactMicroKeepTurns        int      `json:"compactMicroKeepTurns,omitempty"`
	CompactMinKeepTurns          int      `json:"compactMinKeepTurns,omitempty"`
	CompactEstimationPadding     float64  `json:"compactEstimationPadding,omitempty"`
	CompactEnabled               *bool    `json:"compactEnabled,omitempty"`
	CompactSummaryEnabled        *bool    `json:"compactSummaryEnabled,omitempty"`
	CompactSummaryModel          string   `json:"compactSummaryModel,omitempty"`
	CompactSummaryMaxTokens      int      `json:"compactSummaryMaxTokens,omitempty"`
	CompactMemoryEnabled         *bool    `json:"compactMemoryEnabled,omitempty"`
	CompactMemoryModel           string   `json:"compactMemoryModel,omitempty"`
	CompactMemoryUpdateThreshold int      `json:"compactMemoryUpdateThreshold,omitempty"`
	CompactMemoryUpdateMinTurns  int      `json:"compactMemoryUpdateMinTurns,omitempty"`
	CompactMemoryMaxTokens       int      `json:"compactMemoryMaxTokens,omitempty"`
	// MaxToolResultChars caps the character count of any single tool result
	// for this run. Results exceeding this limit are persisted to disk and
	// replaced with a preview. Zero means "inherit from engine.json or
	// built-in default". Negative disables the cap entirely for this run.
	MaxToolResultChars           int      `json:"maxToolResultChars,omitempty"`
	SuppressSystemMessages  bool         `json:"suppressSystemMessages,omitempty"`
	DisablePlanModeReminder bool         `json:"disablePlanModeReminder,omitempty"`
	DisableTurnLimitWarning bool         `json:"disableTurnLimitWarning,omitempty"`
	DisableMaxTokenContinue bool         `json:"disableMaxTokenContinue,omitempty"`
	CapabilityTools         []LlmToolDef `json:"-"` // capability tools injected by session manager
	CapabilityPrompt        string       `json:"-"` // capability prompt content injected by session manager
	WebSearchMode           string       `json:"-"` // "auto", "client", or "server", propagated from config

	// --- Early-stop continuation (Claude-Code-style "keep working" nudge) ---
	//
	// The engine watches output-token usage across the run. When the model
	// emits end_turn / stop below `EarlyStopThresholdPct` of the configured
	// budget, the engine injects a continuation user message and re-runs the
	// turn. Defaults ship on with a sensible budget; harness engineers can
	// disable, retune, or override per-run via these fields.
	//
	// Resolution order (highest priority last): built-in defaults <
	// engine.json `earlyStopContinue` block < RunOptions fields below <
	// `before_early_stop_decision` hook return value at runtime.
	//
	// Field stability: additive only (per CLAUDE.md contract rules). Zero
	// values mean "inherit from a lower layer"; pointer fields exist so that
	// "explicitly false / explicitly zero" can be distinguished from "unset".

	// EarlyStopEnabled is the per-run override. Pointer (not bool) so nil
	// means "use engine.json default", `&false` disables for this run, and
	// `&true` forces on (e.g. for a subagent that the harness specifically
	// wants nudged).
	EarlyStopEnabled *bool `json:"earlyStopEnabled,omitempty"`

	// EarlyStopBudget is the output-token target for the run. Zero means
	// "use the engine.json default"; a negative value disables the feature
	// for this run.
	EarlyStopBudget int `json:"earlyStopBudget,omitempty"`

	// EarlyStopThresholdPct is the completion threshold (percent of budget).
	// Zero means "use the default" (90).
	EarlyStopThresholdPct int `json:"earlyStopThresholdPct,omitempty"`

	// EarlyStopMaxContinuations caps the number of continuation nudges per
	// run. Zero means "use the default" (3).
	EarlyStopMaxContinuations int `json:"earlyStopMaxContinuations,omitempty"`

	// EarlyStopDiminishingDelta is the per-continuation output-token delta
	// below which the engine considers the agent to be making diminishing
	// progress and stops nudging. Zero means "use the default" (500 tokens).
	EarlyStopDiminishingDelta int `json:"earlyStopDiminishingDelta,omitempty"`

	// DisableEarlyStopContinue mirrors the existing per-injection disable
	// flags (DisablePlanModeReminder etc.). When true, the continuation
	// _message_ is suppressed even if the engine would otherwise decide to
	// continue. Rarely useful on its own — prefer EarlyStopEnabled = &false
	// to disable the whole loop. Kept for parity with the existing pattern.
	DisableEarlyStopContinue bool `json:"disableEarlyStopContinue,omitempty"`

	// IsSubagent marks a child agent run dispatched by the Agent tool. The
	// early-stop continuation is **off by default for subagents** even when
	// the global feature is on — a sub-agent is summoned for a tight remit
	// and should not be poked to keep working. Harness can still force it on
	// with `EarlyStopEnabled = &true`.
	IsSubagent bool `json:"isSubagent,omitempty"`

	// Attachments are pre-encoded images supplied by the client alongside the
	// text prompt. When non-empty the backend appends one image content block
	// per attachment to the user message, in addition to the text block.
	Attachments []ImageAttachment `json:"attachments,omitempty"`
}

// EarlyStopContinueConfig holds the engine-wide defaults for the early-stop
// continuation feature. Lives under `earlyStopContinue` in ~/.ion/engine.json.
// All fields are pointers so the merge layer can tell "not set in this file"
// from "explicitly zero". Resolved against built-in defaults in
// EarlyStopDefaults() before per-run overrides apply.
type EarlyStopContinueConfig struct {
	// Enabled is the global kill switch. When nil, the built-in default
	// (true) wins. Set to false in engine.json to disable the feature for
	// every run on this machine.
	Enabled *bool `json:"enabled,omitempty"`

	// Budget is the global output-token target. Zero means "use default" (8000).
	Budget int `json:"budget,omitempty"`

	// ThresholdPct is the global completion threshold percent. Zero means
	// "use default" (90).
	ThresholdPct int `json:"thresholdPct,omitempty"`

	// MaxContinuations caps the number of continuation nudges per run. Zero
	// means "use default" (3).
	MaxContinuations int `json:"maxContinuations,omitempty"`

	// DiminishingDelta is the per-continuation token delta below which the
	// engine declares diminishing returns. Zero means "use default" (500).
	DiminishingDelta int `json:"diminishingDelta,omitempty"`
}

// EarlyStopDefaults returns the built-in defaults for the early-stop
// continuation feature. Defaults to OFF: the engine provides the mechanism
// (cumulative output-token tracking, before_early_stop_decision /
// early_stop_continued hooks, re-run-turn machinery) but ships no opinion
// about whether to nudge or what text to nudge with. A harness consumer
// must opt in — either through engine.json (`earlyStopContinue.enabled =
// true`) for a config-level toggle, or by wiring a
// before_early_stop_decision handler that returns ForceContinue and a
// ContinueMessage. The numeric tuning knobs (budget, thresholdPct,
// maxContinuations, diminishingDelta) are calibration values that only
// take effect when something higher up the resolution chain has enabled
// the feature; the 8000-token budget matches one substantial multi-step
// turn and harness engineers should retune per agent.
func EarlyStopDefaults() EarlyStopContinueConfig {
	enabled := false
	return EarlyStopContinueConfig{
		Enabled:          &enabled,
		Budget:           8000,
		ThresholdPct:     90,
		MaxContinuations: 3,
		DiminishingDelta: 500,
	}
}

// StoredSessionInfo is metadata for a saved conversation on disk.
type StoredSessionInfo struct {
	SessionID    string  `json:"sessionId"`
	Model        string  `json:"model"`
	CreatedAt    int64   `json:"createdAt"`
	MessageCount int     `json:"messageCount"`
	TotalCost    float64 `json:"totalCost"`
	FirstMessage string  `json:"firstMessage"`
	LastMessage  string  `json:"lastMessage"`
	CustomTitle  string  `json:"customTitle,omitempty"`
}

// SessionMessage is a flattened message for client display.
type SessionMessage struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	ToolName  string `json:"toolName,omitempty"`
	ToolID    string `json:"toolId,omitempty"`
	ToolInput string `json:"toolInput,omitempty"`
	Timestamp int64  `json:"timestamp"`
	Internal  bool   `json:"internal,omitempty"`
}

// PermissionDenialEntry is the wire format for permission denials in ResultEvent.
type PermissionDenialEntry struct {
	ToolName  string `json:"tool_name"`
	ToolUseID string `json:"tool_use_id"`
}

// PermissionDenial records a tool invocation that was denied.
// Wire format uses camelCase to match the NormalizedEvent JSON convention.
type PermissionDenial struct {
	ToolName  string         `json:"toolName"`
	ToolUseID string         `json:"toolUseId"`
	ToolInput map[string]any `json:"toolInput,omitempty"`
}

// EnrichedError carries detailed context about a failed run.
type EnrichedError struct {
	Message              string             `json:"message"`
	StderrTail           []string           `json:"stderrTail"`
	StdoutTail           []string           `json:"stdoutTail,omitempty"`
	ExitCode             *int               `json:"exitCode"`
	ElapsedMs            int64              `json:"elapsedMs"`
	ToolCallCount        int                `json:"toolCallCount"`
	SawPermissionRequest bool               `json:"sawPermissionRequest,omitempty"`
	PermissionDenials    []PermissionDenial `json:"permissionDenials,omitempty"`
}
