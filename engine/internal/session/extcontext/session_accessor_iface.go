// session_accessor_iface.go holds the SessionAccessor interface — the seam
// between this package's extension-context construction and the concrete
// session internals that back it. Split out of extcontext.go, which crossed
// the 800-line file cap; the interface is the file's largest cohesive unit
// and the one that changes for its own reasons (a new capability a
// dispatched child needs from its parent session), independent of the
// NewExtContext wiring that consumes it.
package extcontext

import (
	"context"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// NewExtContext needs. The session package provides a concrete implementation
// that delegates to *Manager and *engineSession with appropriate locking.
type SessionAccessor interface {
	SessionKey() string
	ConversationID() string
	// RunID returns the requestID of the run in flight, or empty when the
	// session is idle. Published to extensions as Context.RunID.
	RunID() string
	// TraceID returns the W3C trace-id of the run in flight, or empty when
	// the session is idle. Published to extensions as Context.TraceID so a
	// consumer can parent its own spans to the engine's trace.
	TraceID() string
	// ExtensionName returns the hosting extension's friendly name, or empty
	// when the session is not extension-hosted. Used to attribute
	// dispatch.agent telemetry spans with "extension" context.
	ExtensionName() string
	// ExtensionVersion returns the hosting extension's manifest version, or
	// empty when the manifest carries no version or is absent. Used alongside
	// ExtensionName to attribute dispatch.agent spans with "extension_version".
	ExtensionVersion() string
	// AppContext returns the client-supplied application context for the
	// parent session — the surface (tab, pane) identity a consumer stamps
	// on its conversation.* events. Nil when the client supplied none, which
	// is every consumer that does not opt in. A dispatched child reports its
	// parent's value: the child runs inside the same client surface, so an
	// enterprise consumer attributing a sub-agent's tool call to a tab needs
	// the parent's identity, not a separate one the child never had.
	AppContext() map[string]string
	WorkingDirectory() string
	CurrentModel() string
	Emit(ev types.EngineEvent)
	SendAbort()

	// RootContext returns the session's cancellation root context. Every
	// cancellable operation built from this accessor (ctx.llmCall, agent
	// dispatch) derives its own context from this root so a session-level
	// abort cancels it. Async dispatch keeps this root rather than inheriting
	// a short-lived launching tool-call context. Implementations must never return nil — a
	// session with no root (test-constructed) returns context.Background()
	// so derive sites can call context.WithCancel(sa.RootContext())
	// unconditionally.
	RootContext() context.Context
	SendPrompt(text string, model string, bashAllowlistAdditions []string) error
	// SendPromptWithKind is the Kind-aware variant of SendPrompt. It threads
	// the Kind classification into PromptInjectedEvent.Kind so consumers can
	// inspect the semantic type of the injection (e.g. "agent_completion" for
	// machine-to-machine dispatch callbacks). Callers that do not need Kind
	// should use SendPrompt; this method exists so the ext/send_prompt
	// active-hook path can pass Kind without changing SendPrompt's signature.
	SendPromptWithKind(text string, model string, bashAllowlistAdditions []string, kind string) error
	// SteerSelfMainLoop attempts to steer the session's OWN main run loop
	// (the depth-0 / orchestrator run) by injecting message onto its steer
	// channel. Returns true when the steer reached a live run; false when
	// there is no active main run (the caller then falls back to SendPrompt).
	// This is the depth-0 arm of ctx.SteerSelf — depth-N contexts steer their
	// dispatch's child run through the DispatchRegistry instead.
	SteerSelfMainLoop(message string) bool

	// SteerSelfMainLoopWithKind is the Kind-aware variant. The kind reaches
	// the backend's steer channel so a machine-originated steer is persisted
	// as machine-authored rather than as an unclassified user turn.
	SteerSelfMainLoopWithKind(message, kind string) bool

	// ParkSelfMainLoop parks the session's OWN main run loop (the depth-0 /
	// orchestrator run) on its outstanding background bash commands. Returns
	// true when a live main run was signalled to park; false when there is no
	// active run to park, or when nothing is outstanding to park on.
	//
	// This is the depth-0 arm of ctx.Suspend. A dispatched child suspends by
	// signalling its own backend run, which a live runChild goroutine then
	// revives; the root has no such goroutine, so parking it means ending the
	// run and letting a background-command completion start a new one.
	ParkSelfMainLoop() bool
	Elicit(info extension.ElicitationRequestInfo) (map[string]interface{}, bool, error)
	SuppressTool(name string)
	CacheExtAgentStates(agents []types.AgentStateUpdate)
	RegisterAgent(name string, handle types.AgentHandle)
	DeregisterAgent(name string)
	RegisterAgentSpec(spec types.AgentSpec)
	DeregisterAgentSpec(name string)
	LookupAgentSpec(name string) (types.AgentSpec, bool)
	LookupExtDisplayName(name string) string
	ExtGroup() *extension.ExtensionGroup
	ExtConfig() *extension.ExtensionConfig
	ProcRegistry() *extension.ProcessRegistry
	NewChildBackend() backend.RunBackend

	// BumpParentProgress refreshes the parent run's run-progress watchdog
	// clock. This matters only for explicit foreground waits; default async
	// dispatch leaves parent run independently progress-capable. No-op when there is no
	// active parent run or the backend does not support progress bumps. See
	// ApiBackend.BumpRunProgress and the run-progress watchdog for the full
	// rationale (the 1782012033034-37d617d3d9ab incident).
	BumpParentProgress()

	// EmitDispatchCountStatus re-samples the live dispatch count from the
	// registry and emits a fresh engine_status with the correct
	// BackgroundAgents value. Call this immediately after
	// registry.Deregister so the parent session clears its "waiting on
	// background agent" state. reason is a free-form observability label
	// (e.g. "dispatch_deregister"). No-op when the session or registry is
	// not available.
	EmitDispatchCountStatus(reason string)

	// PersistDispatchRegistered writes a `running` agent_dispatch record for
	// a freshly-registered dispatch into the parent conversation file. This
	// is the durability half of dispatch-loss detection: a dispatch that is
	// running when the engine process dies leaves this record behind, and
	// the next start's rehydration marks it lost (error + typed
	// engine_dispatch_lost + dispatch_lost hook) instead of the loss being
	// invisible. The terminal persist (persistTerminalDispatches) later
	// supersedes the record with the real outcome — the persistence layer is
	// status-aware, so registration-then-completion never reads as a loss.
	// Best-effort: failures are logged, never propagated (a dispatch must
	// not fail because its durability record could not be written).
	PersistDispatchRegistered(agentID, agentName, displayName, task, model, parentDispatchID string, depth int)

	// PersistDispatchTerminal writes the superseding terminal agent_dispatch
	// record for one dispatch, called immediately after its slot reaches
	// done/error/cancelled. This is the other half of the durability pair: the
	// run-exit sweep (persistTerminalDispatches) only runs when the parent
	// exits a run, so a dispatch that completes while the parent is parked had
	// no durable outcome until the parent's NEXT run exit — and if the engine
	// died first, the next start read the stale `running` record and reported a
	// cleanly-completed dispatch as lost. Best-effort, same as the
	// registration write: failures log and never propagate.
	PersistDispatchTerminal(agentID string)
	// DispatchRegistry returns the session's dispatch registry. Required by
	// the context paths that build an extension.Context without already
	// holding one in scope (extension-tool dispatch, the LLM-call hook
	// context). Never returns nil for a live session; a test accessor may.
	DispatchRegistry() *DispatchRegistry

	EngineConfig() *types.EngineRuntimeConfig
	// EngineBuildIdentity is the running engine binary identity. Child extension
	// hosts use it during their init handshake to reject stale SDK runtimes.
	EngineBuildIdentity() string

	// ClaudeCompat reports the parent session's Claude-compatibility setting.
	// It lives on the session-level config (EngineConfig.ClaudeCompat), not on
	// the machine-wide EngineRuntimeConfig, so it needs its own accessor. The
	// dispatch path threads it into the child RunOptions (nested descent gate)
	// and into the dispatch context-policy cascade (default compat).
	ClaudeCompat() bool

	// GetDispatchContextDefaults returns the session-level default context
	// policy (level 3 of the four-level dispatch context cascade), or nil when
	// no extension has set one. The real accessor delegates to the extension
	// Host's session-scoped state; the dispatch injection path uses it to seed
	// the cascade below any per-dispatch override.
	GetDispatchContextDefaults() *extension.ContextPolicy

	ResolveTier(name string) string
	PermissionCheck(toolName string, input map[string]interface{}) (decision string, reason string)
	McpConnections() []*mcp.Connection

	// SearchHistory searches the active conversation's history for content
	// that may have been compacted. Returns nil when no conversation is active.
	SearchHistory(query string, maxResults int) []extension.HistoryMatch

	// GetSessionMemory returns the current session memory content.
	// Returns empty string when session memory is not active.
	GetSessionMemory() string

	// SetSessionMemory replaces the session memory with custom content
	// and persists it to disk. Extensions can use this to provide their
	// own summarization strategies.
	SetSessionMemory(content string)

	// TranslateEvent converts a NormalizedEvent to an EngineEvent. The
	// implementation lives in the session package (translateToEngineEvent)
	// so test coverage is unchanged.
	TranslateEvent(ev types.NormalizedEvent, contextWindow int) types.EngineEvent

	// SetPlanMode flips the session's plan mode state. source is a free-form
	// string for log observability (e.g. "extension", "slash_command").
	SetPlanMode(enabled bool, source string)

	// GetPlanModeState returns (planModeEnabled, planFilePath) for the session.
	GetPlanModeState() (bool, string)

	// AllocatePlanFilePath allocates a fresh, non-colliding plan-file path for
	// the given child model, ensuring the plans directory exists, and returns
	// it. It is the exported bridge to the session-package allocator
	// (allocateNewPlanFilePath); package extcontext cannot import package
	// session (session imports extcontext), so the dispatch path reaches the
	// allocator through this interface method rather than duplicating the slug
	// logic. The directory choice depends on which serving backend the model
	// resolves to: api-served models use ~/.ion/plans/; claude-code uses the
	// project working directory. Used by the plan-mode dispatch path to fill an
	// empty PlanFilePath the same way the root paths (RequestPlanModeEnter,
	// SendPrompt) do.
	AllocatePlanFilePath(model string) string

	// AppendOrUpdateAgentState creates a new agent state entry or updates
	// an existing one (matched by name). Returns the entry's ID.
	AppendOrUpdateAgentState(state types.AgentStateUpdate) string

	// UpdateAgentStateByID finds an agent state entry by its ID and applies
	// the updater function.
	UpdateAgentStateByID(id string, updater func(*types.AgentStateUpdate))

	// UpsertAgentStateByID finds an agent state entry by its ID and applies the
	// updater, or appends seed (then applies the updater) when no slot matches.
	// Used by the dispatch terminal transition so a slot swept during a
	// lifecycle gap is re-materialized as a terminal row instead of the terminal
	// update being lost.
	UpsertAgentStateByID(id string, seed types.AgentStateUpdate, updater func(*types.AgentStateUpdate))

	// EmitAgentSnapshot emits the current merged agent state snapshot as
	// an engine_agent_state event.
	EmitAgentSnapshot(reason string)

	// ResourceBroker returns the session's resource broker.
	ResourceBroker() *resource.Broker

	// GlobalResourceBroker returns the Manager-level broker for
	// workspace-scoped resources.
	GlobalResourceBroker() *resource.Broker

	// BroadcastNotification routes a notification from an extension through
	// the engine's emit pipeline so the relay can forward it with push flags.
	BroadcastNotification(opts types.NotifyOpts)

	// BroadcastIntercept routes an intercept signal from an extension through
	// the engine's emit pipeline to the target session's event stream.
	BroadcastIntercept(opts extension.InterceptOpts)

	// ListAllSessions returns info about all active sessions in the engine.
	ListAllSessions() []extension.SessionListEntry

	// SendToSession sends a structured message to another session of the
	// same extension type. Returns an error if the target doesn't exist,
	// has a different extension type, or has no session_message hook.
	SendToSession(senderKey, targetKey, kind string, payload map[string]interface{}) error

	// FireSchedule triggers an immediate fire of the named schedule job
	// on this session. Returns an error if the job is not found or the
	// scheduler is not wired.
	FireSchedule(sessionKey, jobID string) error

	// GetScheduleStatus returns status entries for registered schedule jobs
	// on this session. When jobID is non-empty, only the matching job is
	// returned. When jobID is empty, all jobs on the session's hosts are
	// returned.
	GetScheduleStatus(sessionKey, jobID string) ([]extension.ScheduleStatusEntry, error)

	// RunOnceCheck is the dedup coordinator for ctx.runOnce. It returns
	// Execute=true when this instance should run the operation (and the
	// engine has marked it as running). Returns Execute=false with a
	// reason when another instance is already running it or it ran
	// recently enough to be debounced.
	RunOnceCheck(operationID string, debounceMs int64) (execute bool, reason string)

	// RunOnceComplete records the completion of a runOnce operation.
	// failed=true clears the running flag without updating lastRun so
	// the next caller can retry immediately.
	RunOnceComplete(operationID string, failed bool)

	// Telemetry returns the session's telemetry collector, or nil when
	// telemetry is disabled. Used by the dispatch path to emit dispatch.agent
	// spans (family 4b). Nil-safe: callers guard on a nil return.
	Telemetry() *telemetry.Collector

	// ConversationEventsTelemetry returns the standalone conversation.*
	// telemetry collector (issue #378), or nil when conversation events are
	// disabled. This is a distinct collector from Telemetry() above — the two
	// families gate independently. The dispatch path (child 05) uses this to
	// build a *telemetry.ConversationEmitter for dispatched-child
	// conversation.* events; NewConversationEmitter is nil-safe on a nil
	// collector, so callers construct the emitter unconditionally and let it
	// no-op when disabled.
	ConversationEventsTelemetry() *telemetry.Collector

	// PluginSessionMessages returns the ephemeral LlmMessage values built from
	// all installed plugins' SessionStart hook output for this session. These
	// are <system-reminder>-wrapped user messages to be prepended to the
	// provider message slice on every turn, giving plugin instructions full
	// conversational attention weight. The slice is nil when no plugins are
	// installed or no SessionStart hooks produced output. Callers must not
	// mutate the returned slice.
	PluginSessionMessages() []types.LlmMessage

	// PluginTurnMessages fires all installed plugins' UserPromptSubmit hooks
	// with the given prompt (passed via stdin as Claude Code JSON protocol)
	// and returns the resulting <system-reminder>-wrapped user messages. Called
	// on each turn by the dispatch path to produce per-turn plugin reinforcement
	// messages. Returns nil when no plugins have UserPromptSubmit hooks.
	PluginTurnMessages(prompt string) []types.LlmMessage
}
