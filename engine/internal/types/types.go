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
	// ProjectDirectory identifies the source Project that supplies project-level
	// policy when WorkingDirectory is a worktree. Empty preserves the historical
	// working-directory lookup.
	ProjectDirectory string          `json:"projectDirectory,omitempty"`
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

	// Pinned marks this session as reap-exempt: the engine's orphaned-session
	// reaper will never automatically stop it when all owning connections
	// disconnect. Intended for headless daemon sessions that host long-lived
	// extensions with schedules and hooks but have no persistent UI owner
	// (e.g. a background orchestrator started at engine launch). A pinned
	// session is still stopped by an explicit stop_session command or a full
	// engine shutdown. The flag is opt-in; ordinary sessions (desktop tabs,
	// short-lived CLI prompts) should leave it false so the leak-prevention
	// reaper continues to protect them.
	Pinned bool `json:"pinned,omitempty"`

	// ToolGate is the client's opt-in declaration that it wants to be
	// consulted (engine_tool_gate_request / tool_gate_response) before tool
	// calls execute in this session. Nil means no gating — the default for
	// every consumer that does not ask. See types/tool_gate.go.
	ToolGate *ToolGateConfig `json:"toolGate,omitempty"`

	// ClientWorkspaceContext is a client-supplied workspace descriptor that
	// the engine routes through system_inject and context_inject hooks in
	// place of its own worktree-registry-derived context. Nil means the
	// engine derives context from its own registry (unchanged default).
	// A per-prompt override on ClientCommand takes precedence over this
	// session-level value.
	ClientWorkspaceContext *ClientWorkspaceContext `json:"clientWorkspaceContext,omitempty"`

	// RunRecovery overrides the engine-wide RunRecoveryConfig for this
	// session. Nil means inherit from EngineRuntimeConfig. A session that
	// sets Enabled=false disables journaling for its runs regardless of
	// the global setting.
	RunRecovery *RunRecoveryConfig `json:"runRecovery,omitempty"`
}

// Per-prompt thinking-effort sentinels carried on
// ClientCommand.ThinkingEffort / PromptOverrides.ThinkingEffort.
//
// These are WIRE values a client sends, not fields on ThinkingConfig. The
// engine maps them onto a ThinkingConfig in session.buildRunOptions:
//
//	"off"      → no thinking directive (clears any default)
//	"adaptive" → ThinkingConfig{Enabled:true} with NO Effort, so a
//	             self-regulating model picks its own depth
//	<level>    → ThinkingConfig{Enabled:true, Effort:<level>}
//
// The level ladder is "low" < "medium" < "high" < "xhigh" < "max". The engine
// does NOT hardcode which levels exist per model: a level is accepted only when
// the model advertises it in ThinkingEfforts (see providers.resolveThinking),
// so a provider or gateway can introduce a new rung by declaring it. The
// constants below name only the two non-level sentinels, which carry engine
// semantics rather than being passed through to a provider.
//
// ThinkingEffortAdaptive exists because pinning an explicit effort on a model
// whose ThinkingMode is "adaptive" overrides the model's own per-turn judgment
// on EVERY turn, including trivial ones. That is a latency regression rather
// than a quality win, so a client needs a way to say "reason, but decide the
// depth yourself" that is distinct from both "off" and a pinned level.
const (
	ThinkingEffortOff      = "off"
	ThinkingEffortAdaptive = "adaptive"
)

// ThinkingConfig controls extended thinking for API-backend runs.
type ThinkingConfig struct {
	Enabled bool `json:"enabled"`
	// Effort is the cross-provider reasoning level: "low" | "medium" | "high".
	// It is the forward-compatible control that the whole provider landscape
	// has converged on (Anthropic adaptive `effort`, OpenAI `reasoning_effort`,
	// Gemini `thinkingConfig` budget mapped from the level). Precedence with
	// the legacy BudgetTokens field:
	//   - Enabled && Effort != "" ⇒ effort-based resolution (preferred path).
	//   - Enabled && Effort == "" ⇒ adaptive/legacy path: an "adaptive" model
	//     self-regulates depth (no output_config emitted), and a "budget"
	//     model falls back to BudgetTokens. This is the shape a client
	//     requests with thinkingEffort:"adaptive".
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
	Label     string `json:"label"`
	State     string `json:"state"`
	SessionID string `json:"sessionId,omitempty"`
	Team      string `json:"team,omitempty"`
	Model     string `json:"model"`
	// ContextPercent is context-window occupancy as a percentage. UNBOUNDED:
	// values above 100 are emitted verbatim and mean the conversation holds
	// more tokens than the window it is measured against (the normal case
	// when a conversation accumulated under a large-window model and the
	// operator then selects a smaller one). Consumers that render this into
	// a fixed-width bar clamp at their own display layer.
	ContextPercent int `json:"contextPercent"`
	// ContextWindow is the context window in tokens of the model the engine
	// actually used, i.e. the denominator ContextPercent was computed against.
	ContextWindow int `json:"contextWindow"`
	// ContextTokens is the absolute context-window occupancy in tokens —
	// the numerator behind ContextPercent. Published so a consumer can
	// recompute the percentage against a different model's window without
	// an engine round-trip (there is no command to change an idle session's
	// model, so a client-side model picker must own that arithmetic).
	// Cache-aware: input + cache_read + cache_creation.
	ContextTokens int `json:"contextTokens,omitempty"`
	// ContextEffectiveLimit is the usable input capacity after the engine
	// reserves output and compaction-summary tokens. ContextPercent continues
	// to describe raw-window occupancy for backward compatibility.
	ContextEffectiveLimit int `json:"contextEffectiveLimit,omitempty"`
	// RunCostUsd is the cumulative cost of the most recent run in USD. It
	// represents the sum of all turns in the run (cache-aware, descendants
	// included). Replaces the former totalCostUsd field; the rename makes
	// the scope unambiguous — "run" not "conversation".
	RunCostUsd float64 `json:"runCostUsd,omitempty"`
	// CompletionReason is present only on idle status translated directly from
	// TaskCompleteEvent. Empty preserves compatibility with older emitters.
	CompletionReason TaskCompletionReason `json:"completionReason,omitempty"`
	// ConversationCostUsd is the cumulative cost of the entire conversation
	// (this session + all descendant dispatches) in USD. Computed on demand
	// via the cost.ConversationCost dispatch-tree walk.
	ConversationCostUsd float64            `json:"conversationCostUsd,omitempty"`
	PermissionDenials   []PermissionDenial `json:"permissionDenials,omitempty"`
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
	// BackgroundShells is the number of background bash commands (Bash with
	// run_in_background + notify_on_complete) the session is still waiting on.
	// The shell counterpart to BackgroundAgents: when > 0 the orchestrator may
	// be idle while real work is in flight, and the engine holds the session
	// open until the commands finish. Zero when no notifying commands are
	// outstanding. Commands started WITHOUT notify_on_complete are not counted
	// — nothing is waiting on them.
	BackgroundShells int `json:"backgroundShells,omitempty"`
	// ActiveBackgroundTasks is the complete snapshot of every live background
	// Bash process owned by this session. Unlike BackgroundShells, it includes
	// tasks that do not notify on completion, so clients can render and stop
	// every active process and reconcile after reconnect.
	ActiveBackgroundTasks []BackgroundTaskState `json:"activeBackgroundTasks,omitempty"`
	// ActivePolls is the complete snapshot of every session-owned Poll.
	ActivePolls []PollState `json:"activePolls,omitempty"`
	// PollsWaiting is the count of polls holding the session open.
	PollsWaiting int `json:"pollsWaiting,omitempty"`
	// HasPendingWork is true when the engine has accepted work that prevents a
	// session from being terminal, even if the foreground orchestrator is idle.
	// It includes live dispatches, notifying shells, queued prompts, durable
	// completion deliveries, queued background completions, and parked runs.
	HasPendingWork bool `json:"hasPendingWork,omitempty"`
	// RunEpoch counts the runs this session has accepted for dispatch, as of
	// the instant this snapshot was built. It starts at zero for a session
	// that has never dispatched, increments once per accepted prompt, and
	// never decreases for the life of the session.
	//
	// It exists so a consumer can order a status snapshot against its own
	// prompt. A status event is a complete snapshot that any of several
	// asynchronous sites may build — the heartbeat, ReconcileState, the
	// post-start_session handshake, QuerySessionStatus — so one can be built
	// in the window after a client sent a prompt but before the engine
	// assigned run identity to it. Such a snapshot honestly reports
	// state=idle. Without an ordering signal a consumer cannot distinguish
	// that pre-dispatch idle from the idle that ends a run, and reads a stale
	// snapshot as a completion.
	//
	// The contract for a consumer: record the epoch you last observed, send
	// the prompt, and treat any subsequent snapshot whose epoch has not
	// advanced past that value as describing the state BEFORE your prompt.
	// Such a snapshot is never a completion of it.
	//
	// Scope is one live session, not one conversation. A session recreated by
	// StartSession — an engine restart, or a resume after StopSession —
	// begins again at zero, so the value can DECREASE across a session
	// boundary. A consumer that observes a decrease is looking at a new
	// session and must rebase its recorded value rather than treat the
	// snapshot as stale, or it would discard every status the new session
	// emits. A decrease is never evidence of ordering within one session,
	// because within one session the counter only rises.
	//
	// A counter rather than a run identifier, because the ordering question
	// is what a consumer actually needs and an identifier cannot answer it:
	// the engine mints its run ID internally and a client mints its own
	// request ID independently, so the two are never comparable.
	//
	// Omitted when zero, so a session that has never dispatched is
	// indistinguishable on the wire from an emitter that predates the field.
	// A consumer treats absent as zero.
	RunEpoch int64 `json:"runEpoch,omitempty"`
	// NumTurns is the number of LLM turns completed in the most recent run.
	// Stamped from TaskCompleteEvent.NumTurns in translateToEngineEvent; zero
	// on idle and heartbeat status events that have no associated run.
	NumTurns int `json:"numTurns,omitempty"`
	// ConversationTurns is the conversation-lifetime prompt count: the number
	// of real user prompts across the whole conversation, not just the most
	// recent run. Stamped from TaskCompleteEvent.ConversationTurns in
	// translateToEngineEvent; zero on idle and heartbeat status events that
	// have no associated run. Consumers render this as the drawer "Turns"
	// (lifetime), whereas NumTurns is the per-run round-trip count.
	ConversationTurns int `json:"conversationTurns,omitempty"`
}

// BackgroundTaskState is one active session-owned background Bash process.
type BackgroundTaskState struct {
	TaskID           string `json:"taskId"`
	ToolID           string `json:"toolId,omitempty"`
	Command          string `json:"command"`
	StartedAt        int64  `json:"startedAt"`
	NotifyOnComplete bool   `json:"notifyOnComplete,omitempty"`
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
//   - HasInflightRun, BackgroundAgentCount, and BackgroundShellCount let
//     consumers distinguish "the LLM turn is running" from "the LLM turn
//     ended but dispatched agents or background shell commands are still
//     running" without re-deriving it from inst.agentStates. Today's
//     renderer keeps a separate `anyInstanceHasRunningChildren` projection
//     just to recover this.
//
// Contract stability note: this type is additive. Once published it
// follows the same backwards-compatibility rules as every other shared
// type — new fields are zero-default and additive, no field is removed
// or renamed without a major version. See CLAUDE.md "Contract stability".
type SessionStatus struct {
	// Key is the opaque, harness-chosen session key. The engine treats
	// it as an opaque identifier and never parses its structure. Always set.
	Key string `json:"key"`
	// State is the authoritative running/idle/etc state computed by
	// Manager.currentSessionStatus. Mirrors StatusFields.State values
	// exactly so this field is a drop-in for any consumer that reads
	// StatusFields.State today. Values: "idle", "running",
	// "starting", "compacting", "dead", "failed". "idle" and
	// "running" are emitted today; the other values are reserved for
	// future phases. (A parked human-wait question reports "idle" —
	// nothing is running while the user decides; the retained
	// PermissionDenials on the same snapshot carry the question.)
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
	// BackgroundShellCount is the number of background bash commands the
	// session is still waiting on. Same semantics as
	// StatusFields.BackgroundShells — the shell counterpart to
	// BackgroundAgentCount, so a consumer reading only this event can tell a
	// parked session (idle orchestrator, commands in flight) from a plain
	// idle one without re-deriving it.
	BackgroundShellCount int `json:"backgroundShellCount,omitempty"`
	// ActiveBackgroundTasks mirrors StatusFields.ActiveBackgroundTasks and
	// includes non-notifying session-owned Bash tasks as well.
	ActiveBackgroundTasks []BackgroundTaskState `json:"activeBackgroundTasks,omitempty"`
	// HasPendingWork mirrors StatusFields.HasPendingWork so consumers that read
	// only engine_session_status can distinguish a terminal idle from waiting.
	HasPendingWork bool `json:"hasPendingWork,omitempty"`
	// RunEpoch mirrors StatusFields.RunEpoch — see that field for the full
	// ordering contract. Carried here because engine_session_status is the
	// designated successor to engine_status: a consumer that reads only this
	// event needs the same ability to tell a snapshot built before its prompt
	// from the one that ends the resulting run. Omitting it would reintroduce
	// the false-completion defect the moment the legacy event retires.
	RunEpoch int64 `json:"runEpoch,omitempty"`
	// PermissionDenialsPending mirrors StatusFields.PermissionDenials.
	// Same retention contract — unresolved AskUserQuestion / ExitPlanMode
	// entries surface here so a re-attaching consumer sees them.
	PermissionDenialsPending []PermissionDenial `json:"permissionDenialsPending,omitempty"`
	// Model is the model the most recent run resolved to. Empty when
	// the session has never dispatched a prompt.
	Model string `json:"model,omitempty"`
	// ContextPercent is the most recent context-window usage percent.
	// UNBOUNDED — see StatusFields.ContextPercent for the full semantics.
	ContextPercent int `json:"contextPercent,omitempty"`
	// ContextWindow is the model's context window in tokens.
	ContextWindow int `json:"contextWindow,omitempty"`
	// ContextTokens is the absolute context-window occupancy in tokens.
	// Mirrors StatusFields.ContextTokens — the numerator a consumer needs
	// to recompute the percentage against a different model's window.
	ContextTokens int `json:"contextTokens,omitempty"`
	// ContextEffectiveLimit mirrors StatusFields.ContextEffectiveLimit.
	ContextEffectiveLimit int `json:"contextEffectiveLimit,omitempty"`
	// Matches StatusFields.RunCostUsd semantics — run-scoped, cache-aware,
	// descendants included.
	RunCostUsd float64 `json:"runCostUsd,omitempty"`
	// ConversationCostUsd is the cumulative cost of the entire conversation
	// (this session + all descendant dispatches) in USD.
	ConversationCostUsd float64 `json:"conversationCostUsd,omitempty"`
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
	// EntryID / UserEntryID mirror UsageEvent: the canonical persisted entry
	// ids of the assistant message this end closes and of the run-opening
	// user turn. Consumers re-key live rows to these ids so history reloads
	// (SessionMessage.ID) dedup against them. Both optional and additive.
	EntryID     string `json:"entryId,omitempty"`
	UserEntryID string `json:"userEntryId,omitempty"`
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
// about whether to nudge or what text to nudge with. A continuation consumes
// the operator's tokens and pre-empts their choice to accept a stopped run and
// decide what to do next, so the engine must never enable it by default. A
// harness consumer must opt in — either through engine.json
// (`earlyStopContinue.enabled = true`) for a config-level toggle, or by wiring
// a before_early_stop_decision handler that returns ForceContinue and a
// ContinueMessage. The numeric tuning knobs (budget, thresholdPct,
// maxContinuations, diminishingDelta) are calibration values that only take
// effect when something higher up the resolution chain has enabled the
// feature; the 8000-token budget matches one substantial multi-step turn and
// harness engineers should retune per agent.
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
	// ID is the canonical row id, stable across reloads: the persisted tree
	// entry id for the first row an entry produces, "<entryId>:<n>" (n = row
	// ordinal within the entry, starting at 1) for subsequent rows. All
	// consumers share this id-space — a history reload dedups against live
	// rows re-keyed via the message_end entryId — so no client needs to
	// invent local identities for persisted rows. Additive (omitempty):
	// absent from rows produced by engines predating the field.
	ID        string `json:"id,omitempty"`
	Role      string `json:"role"`
	Content   string `json:"content"`
	ToolName  string `json:"toolName,omitempty"`
	ToolID    string `json:"toolId,omitempty"`
	ToolInput string `json:"toolInput,omitempty"`
	Timestamp int64  `json:"timestamp"`
	Internal  bool   `json:"internal,omitempty"`
	// IsError carries the persisted tool_result error flag on tool-role rows
	// so reloaded history keeps failed tool state instead of coercing every
	// result to success. Additive (omitempty).
	IsError bool `json:"isError,omitempty"`
	// BackgroundTaskID correlates a tool-role row with the asynchronous task
	// that produced it (Bash background task ID or Agent dispatch ID).
	// Additive (omitempty): absent for synchronous tool results.
	BackgroundTaskID string `json:"backgroundTaskId,omitempty"`
	// SlashCommand / SlashArgs / SlashSource carry the raw slash-command
	// invocation when this user turn originated from a slash command the engine
	// resolved and expanded. Content holds the raw invocation for display; the
	// LLM-visible expanded body lives in the .llm.jsonl, not here. Consumers
	// render a command pill from these fields. Empty for ordinary messages.
	SlashCommand        string `json:"slashCommand,omitempty"`
	SlashArgs           string `json:"slashArgs,omitempty"`
	SlashSource         string `json:"slashSource,omitempty"`
	SlashModelAlias     string `json:"slashModelAlias,omitempty"`
	SlashModelEffective string `json:"slashModelEffective,omitempty"`
	// SlashFrontmatter is complete command frontmatter preserved with this
	// invocation. It includes keys only an extension understands.
	SlashFrontmatter map[string]any `json:"slashFrontmatter,omitempty"`

	// ImplementationPhase records that this user turn began the implementation
	// half of a plan-then-implement flow. It is copied from the durable
	// MessageData provenance field during history flattening. Empty/false for
	// ordinary prompts and rows persisted before this additive field existed.
	ImplementationPhase bool `json:"implementationPhase,omitempty"`

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
	// MarkerMachineAuthored lets historical clients suppress a transport marker
	// when its adjacent delivery was engine-authored background work.
	MarkerMachineAuthored bool `json:"markerMachineAuthored,omitempty"`

	// BackgroundWork carries structured metadata for an engine-owned completion
	// input. Its Content is the exact model-facing payload on this same row.
	BackgroundWork *BackgroundWorkInfo `json:"backgroundWork,omitempty"`

	// InjectionKind classifies an engine-side injected user turn on historical
	// reload. See InjectionKind (injection_kind.go) for the enumerated set.
	// Empty means an ordinary user turn with no special classification.
	// Additive (omitempty): absent on legacy rows, which correctly read as
	// ordinary turns. Propagated from MessageData.InjectionKind by flattenEntries.
	InjectionKind string `json:"injectionKind,omitempty"`

	// MachineAuthored reports whether an engine-side actor authored this turn
	// rather than a user, derived from InjectionKind. Carried on reload so a
	// consumer's history filter and its live-event filter can read the SAME
	// field and cannot disagree — a kind suppressed live but not on reload
	// makes the transcript change shape when history rehydrates, which is the
	// exact divergence this field removes.
	//
	// Absent on rows persisted before this field existed. Consumers that must
	// classify those rows fall back to the kind, which is still present.
	MachineAuthored bool `json:"machineAuthored,omitempty"`

	// Attachments carries engine-produced image references replayed on
	// historical reload. Set (on a tool-role row) when flattenEntries encounters
	// image blocks persisted alongside a tool result, or (on an assistant-role
	// row) for a provider-generated image. Each entry references an on-disk file
	// under the conversation's images/ directory — never base64 on the wire,
	// matching the live ImageContentEvent contract. Empty for ordinary rows.
	//
	// This is the reload counterpart to the live image path: during a run the
	// engine emits an ImageContentEvent per image and clients attach it to the
	// owning message; on reload that event is gone (it is not persisted), so the
	// engine replays the same reference here from the persisted image block.
	Attachments []SessionMessageAttachment `json:"attachments,omitempty"`
}

// SessionMessageAttachment is a single image reference carried on a
// SessionMessage during historical reload. The JSON field names match the
// client attachment shape (desktop Attachment, iOS MessageAttachment) so the
// existing history-load mappers surface it without a translation layer. Path is
// the on-disk location under the conversation's images/ directory; the engine
// never puts base64 on the wire.
type SessionMessageAttachment struct {
	ID          string `json:"id"`
	Type        string `json:"type"` // "image"
	Name        string `json:"name"`
	Path        string `json:"path"`
	MediaType   string `json:"mimeType,omitempty"`
	ContentHash string `json:"contentHash,omitempty"`
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
