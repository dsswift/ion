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
	ProfileID        string          `json:"profileId"`
	Extensions       []string        `json:"extensions"`
	WorkingDirectory string          `json:"workingDirectory"`
	SessionID        string          `json:"sessionId,omitempty"`
	Model            string          `json:"model,omitempty"`
	MaxTokens        int             `json:"maxTokens,omitempty"`
	Thinking         *ThinkingConfig `json:"thinking,omitempty"`
	SystemHint       string          `json:"systemHint,omitempty"`

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

	// ForceNewConversation requests a brand-new conversation for this session
	// key even when the durable binding store holds a prior conversationId for
	// it. Without this flag, a StartSession with an empty SessionID resumes the
	// bound conversation (restart resilience, issue #230). A client that wants
	// to start fresh on a reused key (e.g. the user clicking "new conversation"
	// on an existing tab) sets this to true: the engine mints a new id and
	// replaces the stored binding, so the old conversation is no longer
	// auto-resumed for this key. An explicit non-empty SessionID still takes
	// precedence over both this flag and the binding store. (#231)
	ForceNewConversation bool `json:"forceNewConversation,omitempty"`

	// ParentConversationID records that a freshly-minted conversation for this
	// session descends from a prior one. It is written as the new conversation
	// file's `parentId` when the run creates a fresh file (used with
	// ForceNewConversation, or an explicit unsaved SessionID, for a client-driven
	// checkpoint cut such as a desktop "clear context" that starts a new
	// conversation for an existing tab). Ignored when resuming an existing
	// conversation. Additive and non-breaking — an absent value leaves parentId
	// empty as before.
	ParentConversationID string `json:"parentConversationId,omitempty"`
}

// ThinkingConfig controls extended thinking for API-backend runs.
type ThinkingConfig struct {
	Enabled      bool `json:"enabled"`
	// Effort is the cross-provider reasoning level: "low" | "medium" | "high".
	// It is the forward-compatible control that the whole provider landscape
	// has converged on (Anthropic adaptive `effort`, OpenAI `reasoning_effort`,
	// Gemini `thinkingConfig` budget mapped from the level). Precedence with
	// the legacy BudgetTokens field:
	//   - Enabled && Effort != "" ⇒ effort-based resolution (preferred path).
	//   - Enabled && Effort == "" ⇒ legacy budget path (back-compat only; used
	//     for older models whose capability mode is "budget").
	//   - !Enabled ⇒ no thinking directive emitted, regardless of other fields.
	// The provider body-builders translate (mode, effort, budget) via the
	// shared resolveThinking helper; see engine/internal/providers.
	Effort       string `json:"effort,omitempty"`
	BudgetTokens int    `json:"budgetTokens,omitempty"`
	// StreamDeltas gates per-token engine_thinking_delta emission on the
	// engine wire (issue #158). Pointer-bool: nil/absent ⇒ ON (default).
	// Block-boundary events (engine_thinking_block_start / _end) always emit
	// regardless of this flag, so disabling deltas keeps the liveness signal
	// and the block summary. A headless harness that never wants reasoning
	// text on its socket sets this to false.
	StreamDeltas *bool `json:"streamDeltas,omitempty"`
	// Persist gates retention of reasoning TEXT in conversation history
	// (.tree.jsonl / .llm.jsonl). Pointer-bool: nil/absent ⇒ ON (default).
	// When off, the persisted thinking block carries no text (bare
	// {"type":"thinking"}), matching the pre-#158 behavior. This NEVER affects
	// provider re-submission — SanitizeMessages strips thinking on the
	// submission path regardless, because Anthropic rejects re-submitted
	// thinking. Persisting is for display-only (historical "show thinking").
	Persist *bool `json:"persist,omitempty"`
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

// SlashCommandListing is one entry in the engine's filesystem slash-command
// discovery feed (the .md/skill templates across the conventional roots).
// Distinct from EngineCommandListing (extension-registered commands published
// via engine_command_registry): this surface covers the template/skill side so
// a consumer's autocomplete menu unions the two without re-walking the
// filesystem itself.
type SlashCommandListing struct {
	Name         string `json:"name"`
	Description  string `json:"description,omitempty"`
	ArgumentHint string `json:"argumentHint,omitempty"`
	// Source is one of "ion" | "claude" | "skill" — where the template lives.
	Source string `json:"source,omitempty"`
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

// SessionStatus is the Phase 3 typed status payload that consolidates
// every "is this session running" signal into one engine-owned snapshot.
// Emitted via the engine_session_status event variant alongside the
// legacy engine_status during the transition window. Phase 4 of the
// state-management overhaul removes the legacy event.
//
// Why a typed snapshot replaces the field-on-EngineEvent shape:
//
//   - Authoritative state computation lives in exactly one place
//     (Manager.currentSessionStatus). The wire payload is the
//     verbatim output of that function plus the auxiliary fields that
//     vary mid-run (context %, cost, model). Consumers therefore can
//     never disagree with the engine — they receive exactly what the
//     engine computed.
//
//   - StateSince and LastEmittedAt give every consumer a freshness
//     contract. A cache that needs to decide "is the running indicator
//     I'm showing fresh enough to trust?" reads LastEmittedAt; a cache
//     that needs to render "running for 3m 12s" reads StateSince.
//     Without these, every consumer had to maintain its own clock.
//
//   - HasInflightRun and BackgroundAgentCount let consumers
//     distinguish "the LLM turn is running" from "the LLM turn ended
//     but dispatched agents are still running" without re-deriving it
//     from inst.agentStates. Today's renderer keeps a separate
//     `anyInstanceHasRunningChildren` projection just to recover this.
//
// Contract stability note: this type is additive. Once published it
// follows the same backwards-compatibility rules as every other shared
// type — new fields are zero-default and additive, no field is removed
// or renamed without a major version. See CLAUDE.md "Contract stability".
type SessionStatus struct {
	// Key is the session key (tabId or tabId:instanceId). Always set.
	Key string `json:"key"`
	// State is the authoritative running/idle/etc state computed by
	// Manager.currentSessionStatus. Mirrors StatusFields.State values
	// exactly so this field is a drop-in for any consumer that reads
	// StatusFields.State today. Values: "idle", "running",
	// "starting", "waiting_user", "compacting", "dead", "failed".
	// Only "idle" and "running" are emitted today; the other values
	// are reserved for future phases.
	State string `json:"state"`
	// StateSince is the unix-ms timestamp at which the session entered
	// the current State. Zero means "unknown / not tracked yet".
	StateSince int64 `json:"stateSince,omitempty"`
	// LastEmittedAt is the unix-ms timestamp at which the engine last
	// emitted any session-status event for this key. Consumers use it
	// to detect engine silence (>2× heartbeat interval suggests the
	// transport is unhealthy or the engine has died). Always set on
	// outbound events.
	LastEmittedAt int64 `json:"lastEmittedAt"`
	// HasInflightRun is true iff the backend has a live run for this
	// key. Mirrors the Phase 1 cross-check on Manager.currentSessionStatus.
	HasInflightRun bool `json:"hasInflightRun,omitempty"`
	// BackgroundAgentCount is the number of background dispatch agents
	// still running. Same semantics as StatusFields.BackgroundAgents.
	BackgroundAgentCount int `json:"backgroundAgentCount,omitempty"`
	// PermissionDenialsPending mirrors StatusFields.PermissionDenials.
	// Same retention contract — unresolved AskUserQuestion / ExitPlanMode
	// entries surface here so a re-attaching consumer sees them.
	PermissionDenialsPending []PermissionDenial `json:"permissionDenialsPending,omitempty"`
	// Model is the model the most recent run resolved to. Empty when
	// the session has never dispatched a prompt.
	Model string `json:"model,omitempty"`
	// ContextPercent is the most recent context-window usage percent.
	ContextPercent int `json:"contextPercent,omitempty"`
	// ContextWindow is the model's context window in tokens.
	ContextWindow int `json:"contextWindow,omitempty"`
	// TotalCostUsd is the cumulative cost of the conversation in USD.
	TotalCostUsd float64 `json:"totalCostUsd,omitempty"`
	// SessionID is the conversation id (matches the file basename in
	// ~/.ion/conversations/<id>.tree.jsonl).
	SessionID string `json:"sessionId,omitempty"`
	// ExtensionName mirrors StatusFields.ExtensionName.
	ExtensionName string `json:"extensionName,omitempty"`
}

// MessageEndUsage reports token usage at the end of a message.
type MessageEndUsage struct {
	InputTokens    int     `json:"inputTokens"`
	OutputTokens   int     `json:"outputTokens"`
	ContextPercent int     `json:"contextPercent"`
	Cost           float64 `json:"cost"`
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
	// SlashCommand / SlashArgs / SlashSource carry the raw slash-command
	// invocation when this user turn originated from a slash command the engine
	// resolved and expanded. Content holds the raw invocation for display; the
	// LLM-visible expanded body lives in the .llm.jsonl, not here. Consumers
	// render a command pill from these fields. Empty for ordinary messages.
	SlashCommand string `json:"slashCommand,omitempty"`
	SlashArgs    string `json:"slashArgs,omitempty"`
	SlashSource  string `json:"slashSource,omitempty"`

	// Marker payload fields (additive, omitempty). Set only when Role=="system"
	// and this row represents a persisted marker entry (compaction, plan, steer)
	// replayed by flattenEntries on historical reload. Clients format from these
	// structured fields using their existing formatters — the engine emits data,
	// not display strings. MarkerKind discriminates the three marker families.
	MarkerKind string `json:"markerKind,omitempty"` // "compaction" | "plan" | "steer"

	// Compaction marker fields (MarkerKind=="compaction"): mirror CompactionData.
	MarkerMessagesBefore int    `json:"markerMessagesBefore,omitempty"`
	MarkerMessagesAfter  int    `json:"markerMessagesAfter,omitempty"`
	MarkerClearedBlocks  int    `json:"markerClearedBlocks,omitempty"`
	MarkerStrategy       string `json:"markerStrategy,omitempty"`
	MarkerMicroOnly      bool   `json:"markerMicroOnly,omitempty"`
	MarkerSummary        string `json:"markerSummary,omitempty"`

	// Plan marker fields (MarkerKind=="plan"): mirror PlanMarkerData.
	MarkerPlanOperation string `json:"markerPlanOperation,omitempty"` // "created" | "updated"
	MarkerPlanFilePath  string `json:"markerPlanFilePath,omitempty"`
	MarkerPlanSlug      string `json:"markerPlanSlug,omitempty"`

	// Steer marker fields (MarkerKind=="steer"): mirror SteerMarkerData.
	MarkerMessageLength int `json:"markerMessageLength,omitempty"`
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
