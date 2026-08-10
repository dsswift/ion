// Package extcontext builds extension.Context values from a SessionAccessor
// interface, decoupling the extension wiring from concrete session internals.
package extcontext

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
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
	WorkingDirectory() string
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
	// DispatchRegistry returns the session's dispatch registry. Required by
	// the context paths that build an extension.Context without already
	// holding one in scope (extension-tool dispatch, the LLM-call hook
	// context). Never returns nil for a live session; a test accessor may.
	DispatchRegistry() *DispatchRegistry

	EngineConfig() *types.EngineRuntimeConfig

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

// ExtContextOpts holds optional configuration for NewExtContext. All fields
// default to zero values, which produce a root-level (depth 0) context.
//
// The DispatchRegistry is deliberately NOT a member here: it is a required
// positional parameter of NewExtContext. It used to be an optional field, and
// omitting it silently produced a context whose DispatchAgent could not
// register anything — see the NewExtContext doc comment for what that cost.
type ExtContextOpts struct {
	// Depth is the dispatch depth of the agent that will own this context.
	// 0 for the orchestrator (root), 1 for a direct dispatch, etc.
	Depth int
	// DispatchId is the dispatch ID of the agent that owns this context.
	// Empty for the orchestrator at depth 0.
	DispatchId string
	// SuspendFn is the closure wired to ctx.Suspend for dispatched children.
	// When non-nil, the ext/task_suspend RPC calls this to signal the child
	// backend to park the current LLM run. Nil at depth 0 (the orchestrator
	// cannot suspend its own run — it is not inside a dispatched context).
	SuspendFn func(awaitingDispatchIDs []string) error
}

// NewExtContext builds a fully-populated extension.Context by delegating all
// callbacks to the provided SessionAccessor.
//
// registry is REQUIRED and positional. It backs ctx.DispatchAgent's ability to
// reserve, register, deregister, and revive dispatches; a nil registry yields a
// context whose dispatch calls silently no-op every one of those steps, because
// each is `if registry != nil` guarded on the dispatch path.
//
// It is positional rather than an ExtContextOpts field on purpose. It was
// optional, and three call sites simply left it out — the two agent_start /
// agent_end contexts and the before_provider_request context. Those contexts
// get pushed onto the host's ctxStack for the duration of a blocking hook RPC,
// and ctxStack.Current() returns top-of-stack, so any concurrent
// ext/dispatch_agent RPC arriving inside that window resolved against the
// registry-less context. The dispatch then never reserved its ID, so
// handleRunExit's sweep deleted its still-running agent-state slot and every
// later UpdateStateByID landed nowhere: the agent rendered as permanently
// running, its parent was never revived, and the orchestrator sat idle with the
// work finished and undelivered. Making the parameter positional turns that
// omission into a compile error.
//
// When opts are provided, the context's DispatchAgent closure is depth-aware:
// it binds the given depth and dispatch ID so child dispatches inherit depth+1
// and cannot forge their ancestry.
func NewExtContext(sa SessionAccessor, registry *DispatchRegistry, opts ...ExtContextOpts) *extension.Context {
	var depth int
	var dispatchId string
	var suspendFn func(awaitingDispatchIDs []string) error
	for _, o := range opts {
		depth = o.Depth
		dispatchId = o.DispatchId
		suspendFn = o.SuspendFn
	}

	// A nil registry is an invariant violation, not a supported mode: it
	// disables dispatch reservation, deregistration, and child-completion
	// revival while leaving every call site silently successful. Log at ERROR
	// so the condition is greppable rather than inferred from a downstream
	// "no slot found" storm. Mirrors the ctxStack.Push session guard.
	if registry == nil {
		utils.LogWithFields(utils.LevelError, "session.extcontext", "newextcontext: nil dispatch registry (dispatch reserve/deregister/revive will silently no-op on this context)", map[string]any{
			"session_id": sa.SessionKey(), "count": depth, "run_id": dispatchId,
		})
	}

	// At depth 0 there is no dispatched run to suspend, but the ROOT session
	// can still park — on its outstanding background bash commands. Wire
	// ctx.Suspend to the root park path so an extension can end the
	// orchestrator's turn deliberately, the same capability the engine
	// exercises automatically at the turn boundary. Before this, depth 0
	// rejected suspend outright because the capability did not exist.
	if suspendFn == nil {
		suspendFn = func(awaitingDispatchIDs []string) error {
			if len(awaitingDispatchIDs) > 0 {
				return fmt.Errorf("suspend with awaitingDispatchIds is only available inside a dispatched run")
			}
			if !sa.ParkSelfMainLoop() {
				return fmt.Errorf("suspend unavailable: no active run to park, or no outstanding background commands to park on")
			}
			return nil
		}
	}

	ctx := &extension.Context{
		SessionKey:     sa.SessionKey(),
		ConversationID: sa.ConversationID(),
		// Run identity: both empty when no run is in flight (session_start, a
		// schedule or webhook delivery), which is the honest encoding — there
		// is no transaction to correlate against.
		RunID:   sa.RunID(),
		TraceID: sa.TraceID(),
		// Dispatch identity travels on the context so every hook fired in a
		// child session (session_start included, whose payload is nil) can
		// discriminate root (Depth 0) from dispatched children (Depth > 0).
		Depth:      depth,
		DispatchId: dispatchId,
		Cwd:        sa.WorkingDirectory(),
		Emit: func(ev types.EngineEvent) {
			if ev.Type == "engine_agent_state" {
				// Cache extension-emitted agent states, then re-emit a merged
				// snapshot that includes engine-managed entries (dispatch state
				// with task, conversationId, progress). Forwarding the raw
				// extension event would overwrite engine-managed entries on
				// the desktop due to the complete-snapshot contract.
				sa.CacheExtAgentStates(ev.Agents)
				sa.EmitAgentSnapshot("ext_emit_merged")
				return
			}
			sa.Emit(ev)
		},
		Abort: func() { sa.SendAbort() },
		RegisterAgent: func(name string, handle types.AgentHandle) {
			sa.RegisterAgent(name, handle)
		},
		DeregisterAgent: func(name string) {
			sa.DeregisterAgent(name)
		},
		RegisterAgentSpec: func(spec types.AgentSpec) {
			if spec.Name == "" {
				return
			}
			sa.RegisterAgentSpec(spec)
		},
		DeregisterAgentSpec: func(name string) {
			sa.DeregisterAgentSpec(name)
		},
		LookupAgentSpec: func(name string) (types.AgentSpec, bool) {
			return sa.LookupAgentSpec(name)
		},
		ResolveTier: func(name string) string {
			return sa.ResolveTier(name)
		},
		SuppressTool: func(name string) {
			sa.SuppressTool(name)
		},
		Elicit: func(info extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
			return sa.Elicit(info)
		},
		CallTool: func(toolName string, input map[string]interface{}) (string, bool, error) {
			return CallToolFromExtension(context.Background(), sa, toolName, input)
		},
		CallToolWithContext: func(toolName string, input map[string]interface{}, timeoutMs *float64) (string, bool, error) {
			callCtx := context.Background()
			if timeoutMs != nil && *timeoutMs > 0 {
				var cancel context.CancelFunc
				callCtx, cancel = context.WithTimeout(callCtx, time.Duration(*timeoutMs)*time.Millisecond)
				defer cancel()
			}
			return CallToolFromExtension(callCtx, sa, toolName, input)
		},
		// Pre-authenticated outbound HTTP: session-independent (token
		// minting needs no session state), wired here so Go SDK consumers
		// reach it through the same Context surface as everything else.
		HTTPRequest: func(params extension.OperatorHTTPRequestParams) (*extension.OperatorHTTPResponse, error) {
			return extension.DoOperatorHTTPRequest(context.Background(), params)
		},
		SendPrompt: func(text string, model string, bashAllowlistAdditions []string) error {
			return sa.SendPrompt(text, model, bashAllowlistAdditions)
		},
		SendPromptPayload: func(payload extension.SendPromptPayload) error {
			return sa.SendPromptWithKind(payload.Text, payload.Model, payload.BashAllowlistAdditions, payload.Kind)
		},
		Suspend: suspendFn,
		SearchHistory: func(query string, maxResults int) ([]extension.HistoryMatch, error) {
			matches := sa.SearchHistory(query, maxResults)
			return matches, nil
		},
		GetSessionMemory: func() (string, error) {
			return sa.GetSessionMemory(), nil
		},
		SetSessionMemory: func(content string) error {
			sa.SetSessionMemory(content)
			return nil
		},
		SetPlanMode: func(enabled bool, source string) {
			sa.SetPlanMode(enabled, source)
		},
		GetPlanMode: func() (bool, string) {
			return sa.GetPlanModeState()
		},
	}

	// Wire process lifecycle management.
	if reg := sa.ProcRegistry(); reg != nil {
		ctx.RegisterProcess = func(name string, pid int, task string) error {
			return reg.Register(name, pid, task)
		}
		ctx.DeregisterProcess = func(name string) {
			reg.Deregister(name)
		}
		ctx.ListProcesses = func() []extension.ProcessInfo {
			return reg.List()
		}
		ctx.TerminateProcess = func(name string) error {
			return reg.Terminate(name)
		}
		ctx.CleanStaleProcesses = func() int {
			return reg.CleanStale()
		}
	}

	// Wire engine-native agent dispatch.
	ctx.DispatchAgent = BuildDispatchAgentFunc(sa, registry, depth, dispatchId)

	// Wire recall support for background dispatches.
	if registry != nil {
		ctx.RecallAgent = func(name string, opts extension.RecallAgentOpts) (bool, error) {
			reason := opts.Reason
			if reason == "" {
				reason = "recall_agent"
			}
			found := registry.Recall(name, reason)
			return found, nil
		}
	}

	// Wire steer support for background dispatches.
	if registry != nil {
		ctx.SteerDispatch = func(dispatchID, message string) (extension.SteerDispatchResult, error) {
			outcome := registry.SteerByID(dispatchID, message)
			return extension.SteerDispatchResult{
				Delivered: outcome == SteerOutcomeDelivered,
				Outcome:   string(outcome),
			}, nil
		}
		ctx.SteerDispatchByName = func(name, message string) (extension.SteerDispatchResult, error) {
			outcome := registry.SteerByName(name, message)
			return extension.SteerDispatchResult{
				Delivered: outcome == SteerOutcomeDelivered,
				Outcome:   string(outcome),
			}, nil
		}

		// Wire dispatch-state listing: exposes the live registry snapshot to
		// extensions so they can inspect running dispatches without polling
		// engine_agent_state events. Always available when a registry is wired;
		// returns an empty slice (not nil) when no dispatches are active.
		ctx.ListDispatchState = func() ([]extension.DispatchStateEntry, error) {
			snap := registry.Snapshot()
			entries := make([]extension.DispatchStateEntry, len(snap))
			for i, s := range snap {
				entries[i] = extension.DispatchStateEntry{
					DispatchID:          s.DispatchID,
					Name:                s.Name,
					Status:              s.Status,
					ParentDispatchID:    s.ParentDispatchID,
					Depth:               s.Depth,
					StartedAt:           s.StartedAt.UTC().Format(time.RFC3339Nano),
					ElapsedMs:           s.ElapsedMs,
					ToolCount:           s.ToolCount,
					LastWork:            s.LastWork,
					LastActivityMs:      s.LastActivityMs,
					ChildConversationID: s.ChildConversationID,
					PendingChildren:     s.PendingChildren,
				}
			}
			return entries, nil
		}
	}

	// Wire self-steer: deliver a message to the run that OWNS this context,
	// letting the engine pick steer-vs-send based on that run's live state.
	// This is the mechanism that lets a background dispatch's completion reach
	// its dispatching agent without polling — a live owning run is steered
	// mid-turn; an idle one receives a fresh prompt.
	//
	// Depth-aware resolution:
	//   - depth 0 (orchestrator): the owning run is the session's main loop.
	//     Try the main-loop steer; if there is no live main run, fall back to
	//     SendPrompt (a normal new prompt on the idle session).
	//   - depth N (a dispatched agent's own context): the owning run is THIS
	//     dispatch's child run, addressed by dispatchId through the registry's
	//     SteerByID. If the child run is not live (SteerByID returns no_run),
	//     fall back to SendPrompt so the message is not lost.
	//
	// "steered" outcome ⇒ injected onto a live run's steer channel.
	// "sent" outcome    ⇒ delivered as a fresh prompt (owning run was idle).
	//
	// The kind is threaded through EVERY arm. It used to be threaded through
	// none of them: SteerSelf took no kind, and its idle fallback called the
	// three-arg SendPrompt, which hardcodes an empty kind. A harness delivering
	// a completion or a check-in through steerSelf was therefore structurally
	// unable to classify the turn, and an idle session rendered the injection
	// as a user bubble. Both the live arm (steer channel) and the idle arm
	// (fresh prompt) now carry it.
	ctx.SteerSelf = func(message string) (extension.SteerDispatchResult, error) {
		return steerSelfWithKind(sa, registry, depth, dispatchId, message, "")
	}
	ctx.SteerSelfWithKind = func(message, kind string) (extension.SteerDispatchResult, error) {
		return steerSelfWithKind(sa, registry, depth, dispatchId, message, kind)
	}

	// Wire the lightweight one-shot inference primitive. Always available
	// (no nil check needed at call sites) because the closure itself
	// handles every error path with a typed return value. Same accessor
	// powers DispatchAgent and LLMCall — provider routing, hook firing,
	// and event emission go through the same plumbing.
	ctx.LLMCall = BuildLLMCallFunc(sa)

	// Wire resource subsystem operations.
	ctx.DeclareResource = func(decl types.ResourceDeclaration) error {
		broker := sa.ResourceBroker()
		if broker == nil {
			return fmt.Errorf("resource broker not available")
		}
		host := &resource.FuncProducerHost{}
		return broker.RegisterProducer(decl.Kind, host, decl)
	}

	ctx.PublishResource = func(kind string, delta types.ResourceDelta) error {
		// Always publish to the session broker first — producers and subscribers
		// are registered there regardless of whether the item is workspace-scoped
		// (conversationId == "") or conversation-scoped. Skipping the session
		// broker for workspace-scoped items was the bug: delta routed only to the
		// global broker while all subscribers sat on the session broker, yielding
		// recipients=0.
		broker := sa.ResourceBroker()
		if broker == nil {
			return fmt.Errorf("resource broker not available")
		}
		if err := broker.Publish(kind, delta); err != nil {
			return err
		}
		// Also fan out to the global broker so global subscribers receive the
		// delta. Per-session subscriptions often fail (producer only exists on
		// the extension's session broker), so the global broker is the reliable
		// delivery path for all resource kinds.
		if gb := sa.GlobalResourceBroker(); gb != nil {
			gb.PublishDirect(kind, delta)
		}
		return nil
	}

	ctx.HandleResourceQuery = func(kind string, handler func(types.ResourceFilter) ([]types.ResourceItem, error)) {
		broker := sa.ResourceBroker()
		if broker == nil {
			return
		}
		broker.SetQueryHandler(kind, handler)
	}

	ctx.Notify = func(opts types.NotifyOpts) error {
		if opts.Title == "" {
			return fmt.Errorf("notification title is required")
		}
		sa.BroadcastNotification(opts)
		return nil
	}

	ctx.Intercept = func(opts extension.InterceptOpts) error {
		if opts.Title == "" {
			return fmt.Errorf("intercept title is required")
		}
		sa.BroadcastIntercept(opts)
		return nil
	}

	ctx.ListSessions = func() ([]extension.SessionListEntry, error) {
		return sa.ListAllSessions(), nil
	}

	ctx.SendToSession = func(targetKey string, kind string, payload map[string]interface{}) error {
		return sa.SendToSession(sa.SessionKey(), targetKey, kind, payload)
	}

	ctx.FireSchedule = func(jobID string) error {
		return sa.FireSchedule(sa.SessionKey(), jobID)
	}

	ctx.GetScheduleStatus = func(jobID string) ([]extension.ScheduleStatusEntry, error) {
		return sa.GetScheduleStatus(sa.SessionKey(), jobID)
	}

	ctx.RunOnceCheck = func(operationID string, debounceMs int64) (bool, string) {
		execute, reason := sa.RunOnceCheck(operationID, debounceMs)
		return execute, reason
	}

	ctx.RunOnceComplete = func(operationID string, failed bool) {
		sa.RunOnceComplete(operationID, failed)
	}

	// Populate extension config if available.
	if eg := sa.ExtGroup(); eg != nil && !eg.IsEmpty() {
		ctx.Config = &extension.ExtensionConfig{
			WorkingDirectory: sa.WorkingDirectory(),
		}
	}

	// Wire agent discovery.
	ctx.DiscoverAgents = BuildDiscoverAgentsFunc(sa)

	return ctx
}

// steerSelfWithKind is the shared body behind ctx.SteerSelf and
// ctx.SteerSelfWithKind. One implementation, so the kindless alias cannot drift
// from the kind-aware form — the two-implementations-of-one-thing hazard that
// produced the original defect.
//
// Depth-aware resolution:
//   - depth N (a dispatched agent's own context): the owning run is THIS
//     dispatch's child run, addressed by dispatchId through the registry.
//   - depth 0 (orchestrator): the owning run is the session's main loop.
//
// Both depths fall back to a fresh prompt when the owning run is not live, so
// the message is never silently dropped, and both carry the kind into that
// fallback.
func steerSelfWithKind(
	sa SessionAccessor,
	registry *DispatchRegistry,
	depth int,
	dispatchId string,
	message string,
	kind string,
) (extension.SteerDispatchResult, error) {
	if depth > 0 && registry != nil && dispatchId != "" {
		// Depth-N: steer this dispatch's own child run.
		outcome := registry.SteerByIDWithKind(dispatchId, message, kind)
		if outcome == SteerOutcomeDelivered {
			return extension.SteerDispatchResult{Delivered: true, Outcome: "steered"}, nil
		}
		// Child run not live (no_run / not_found / channel_full) — fall
		// back to a fresh prompt on the owning session so the completion
		// is never silently dropped.
		if err := sa.SendPromptWithKind(message, "", nil, kind); err != nil {
			return extension.SteerDispatchResult{Delivered: false, Outcome: string(outcome)}, err
		}
		return extension.SteerDispatchResult{Delivered: true, Outcome: "sent"}, nil
	}

	// Depth-0: steer the session's main loop when it is live, else send.
	if sa.SteerSelfMainLoopWithKind(message, kind) {
		return extension.SteerDispatchResult{Delivered: true, Outcome: "steered"}, nil
	}
	if err := sa.SendPromptWithKind(message, "", nil, kind); err != nil {
		return extension.SteerDispatchResult{Delivered: false, Outcome: "sent"}, err
	}
	return extension.SteerDispatchResult{Delivered: true, Outcome: "sent"}, nil
}
