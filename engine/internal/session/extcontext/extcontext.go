// Package extcontext builds extension.Context values from a SessionAccessor
// interface, decoupling the extension wiring from concrete session internals.
package extcontext

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// degradedSteerPromptSender is an optional SessionAccessor refinement.
// sessionAccessor implements it so no-owning-run delivery persists a marker and
// emits engine_steer_degraded. Existing minimal accessors remain source
// compatible and use the ordinary classified prompt fallback.
type degradedSteerPromptSender interface {
	SendPromptDegradedSteer(text string, model string, bashAllowlistAdditions []string, kind string) error
}

func sendDegradedSteerPrompt(sa SessionAccessor, message, kind string) error {
	if sender, ok := sa.(degradedSteerPromptSender); ok {
		return sender.SendPromptDegradedSteer(message, "", nil, kind)
	}
	return sa.SendPromptWithKind(message, "", nil, kind)
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

	runID, traceID := sa.RunID(), sa.TraceID()
	if identity, ok := sa.(interface{ RunIdentity() (string, string) }); ok {
		runID, traceID = identity.RunIdentity()
	}
	ctx := &extension.Context{
		SessionKey:     sa.SessionKey(),
		ConversationID: sa.ConversationID(),
		// Run identity: both empty when no run is in flight (session_start, a
		// schedule or webhook delivery), which is the honest encoding — there
		// is no transaction to correlate against.
		RunID:   runID,
		TraceID: traceID,
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
		CallTool: func(toolName string, input map[string]interface{}) (*types.ToolResult, error) {
			return CallToolFromExtension(context.Background(), sa, toolName, input)
		},
		CallToolWithContext: func(toolName string, input map[string]interface{}, timeoutMs *float64) (*types.ToolResult, error) {
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
			if accessor, ok := sa.(interface {
				SendPromptPayload(extension.SendPromptPayload) error
			}); ok {
				return accessor.SendPromptPayload(payload)
			}
			return sa.SendPrompt(payload.Text, payload.Model, payload.BashAllowlistAdditions)
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

	if model := sa.CurrentModel(); model != "" {
		ctx.Model = modelRefFor(model)
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
	ctx.DispatchAgent = BuildDispatchAgentFunc(sa, registry, depth, dispatchId, workspaceCheckerFor(sa))

	// Wire compatibility name recall and exact-ID recall.
	wireRecallControls(ctx, registry, depth, dispatchId)

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
			snap := registry.OwnedSnapshot(dispatchId)
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
					WaitingOn:           mapDispatchWaitingOn(s.WaitingOn),
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
		return broker.RegisterProducerFor(decl.Kind, decl.Producer, host, decl)
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
		if err := broker.PublishFrom(kind, delta.Item.Producer, delta); err != nil {
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

	ctx.HandleResourceQuery = func(kind, producer string, handler func(types.ResourceFilter) ([]types.ResourceItem, error)) {
		broker := sa.ResourceBroker()
		if broker == nil {
			return
		}
		broker.SetQueryHandlerFor(kind, producer, handler)
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

// modelRefFor builds the model metadata exposed to extension hooks. Unknown
// models retain their ID with a zero context window, matching session behavior.
func modelRefFor(model string) *extension.ModelRef {
	ref := &extension.ModelRef{ID: model}
	if info := providers.GetModelInfo(model); info != nil {
		ref.ContextWindow = info.ContextWindow
	}
	return ref
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
		// A full channel proves the child run IS live; it simply could not
		// accept another buffered steer. Preserve that fact: the session prompt
		// fallback keeps the message from dropping, but is not a degraded
		// no-owning-run delivery and must not emit SteerDegradedEvent.
		if outcome == SteerOutcomeChannelFull {
			if err := sa.SendPromptWithKind(message, "", nil, kind); err != nil {
				return extension.SteerDispatchResult{Delivered: false, Outcome: string(outcome)}, err
			}
			return extension.SteerDispatchResult{Delivered: true, Outcome: "sent"}, nil
		}

		// no_run / not_found: no child run owns the context, so the fresh prompt
		// is a genuinely degraded steer delivery and receives its distinct signal
		// plus the persisted marker.
		if err := sendDegradedSteerPrompt(sa, message, kind); err != nil {
			return extension.SteerDispatchResult{Delivered: false, Outcome: string(outcome)}, err
		}
		return extension.SteerDispatchResult{Delivered: true, Outcome: "sent"}, nil
	}

	// Depth-0: steer the session's main loop when it is live, else send.
	if sa.SteerSelfMainLoopWithKind(message, kind) {
		return extension.SteerDispatchResult{Delivered: true, Outcome: "steered"}, nil
	}
	if err := sendDegradedSteerPrompt(sa, message, kind); err != nil {
		return extension.SteerDispatchResult{Delivered: false, Outcome: "sent"}, err
	}
	return extension.SteerDispatchResult{Delivered: true, Outcome: "sent"}, nil
}

func mapDispatchWaitingOn(waiting *DispatchWaitingOn) *extension.DispatchWaitingOn {
	if waiting == nil {
		return nil
	}
	return &extension.DispatchWaitingOn{
		TaskIDs:          append([]string(nil), waiting.TaskIDs...),
		ChildDispatchIDs: append([]string(nil), waiting.ChildDispatchIDs...),
	}
}
