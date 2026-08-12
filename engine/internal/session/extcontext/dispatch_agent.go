// @file-size-exception: core dispatch lifecycle; suspend loop added inline to minimize cross-file coupling
package extcontext

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// BuildDispatchAgentFunc returns the DispatchAgent closure. currentDepth is
// the owning agent's depth (0=orchestrator). currentDispatchId is the owning
// agent's dispatch ID (empty at depth 0). The child inherits depth+1.
//
// Background dispatch returns a stub immediately and runs in a goroutine;
// terminal outcome via OnComplete/OnError/OnRecall callbacks.
// Phase 2 lifecycle callbacks fire from OnNormalized; Phase 3 telemetry
// (engine_dispatch_start/end) emit on the parent session's event stream.
func BuildDispatchAgentFunc(sa SessionAccessor, registry *DispatchRegistry, currentDepth int, currentDispatchId string) func(extension.DispatchAgentOpts) (*extension.DispatchAgentResult, error) {
	return func(opts extension.DispatchAgentOpts) (*extension.DispatchAgentResult, error) {
		// --- Depth guard ---
		childDepth := currentDepth + 1
		var engineMaxDepth int
		if cfg := sa.EngineConfig(); cfg != nil {
			engineMaxDepth = cfg.MaxDispatchDepth
		}
		effectiveCap := resolveMaxDispatchDepth(opts.MaxDispatchDepth, engineMaxDepth)

		if childDepth >= effectiveCap {
			utils.LogWithFields(utils.LevelWarn, "server", "depth guard: blocked dispatch", map[string]any{"model": opts.Name, "child_depth": childDepth, "effective_cap": effectiveCap, "current_dispatch_id": currentDispatchId, "session_key": sa.SessionKey()})
			return nil, fmt.Errorf("%w: agent=%q would be depth %d (cap %d)", ErrDispatchDepthExceeded, opts.Name, childDepth, effectiveCap)
		}

		utils.LogWithFields(utils.LevelInfo, "server", "depth guard: allowed dispatch", map[string]any{"model": opts.Name, "child_depth": childDepth, "effective_cap": effectiveCap, "current_dispatch_id": currentDispatchId, "session_key": sa.SessionKey()})

		// --- Eligibility guard ---
		// Enforce the self-dispatch rail (an agent may not dispatch its own
		// name) and the DISPATCHER's carry-forward AllowedSubAgents allowlist
		// (resolved from currentDispatchId in the registry). Skipped at depth 0
		// (the orchestrator has no dispatcher entry). Logic lives in
		// dispatch_eligibility.go to keep this file under the 800-line cap.
		if err := checkDispatchEligibility(sa, registry, currentDispatchId, opts.Name); err != nil {
			return nil, err
		}

		// --- Enterprise agent-count gate (D-007) ---
		// MaxAgentsPerSession caps the number of concurrently-running dispatched
		// agents within a single session. The ceiling is sealed by EnforceEnterprise
		// before the merged config reaches here, so reading it once is sufficient.
		// registry.Count() returns the number of active (non-reserved, or reserved
		// but live) dispatch entries — the same population MaxAgentsPerSession is
		// intended to bound. This check is symmetric with the MaxSessions gate in
		// start_session.go: both read the sealed merged config and reject before
		// the new orchestration context is created.
		if registry != nil {
			if cfg := sa.EngineConfig(); cfg != nil && cfg.ResourceLimits != nil && cfg.ResourceLimits.MaxAgentsPerSession != nil {
				limit := *cfg.ResourceLimits.MaxAgentsPerSession
				active := registry.Count()
				if active >= limit {
					utils.LogWithFields(utils.LevelInfo, "session", "dispatch rejected by enterprise agent limit", map[string]any{"session_key": sa.SessionKey(), "agent": opts.Name, "active_agents": active, "limit": limit})
					return nil, fmt.Errorf("agent dispatch limit reached: enterprise policy allows a maximum of %d concurrent agent dispatches per session", limit)
				}
				utils.LogWithFields(utils.LevelDebug, "session", "enterprise agent limit check passed", map[string]any{"session_key": sa.SessionKey(), "agent": opts.Name, "active_agents": active, "limit": limit})
			}
		}

		start := time.Now()

		utils.LogWithFields(utils.LevelInfo, "server", "starting dispatch", map[string]any{"agent_name": opts.Name, "task_preview": truncate(opts.Task, 80), "model": opts.Model, "system_prompt_len": len(opts.SystemPrompt), "background": !opts.WaitForCompletion, "plan_mode": opts.PlanMode, "session_key": sa.SessionKey()})

		// Determine model and project path.
		model := opts.Model
		if model == "" {
			if cfg := sa.EngineConfig(); cfg != nil {
				model = cfg.DefaultModel
			}
		}
		projectPath := opts.ProjectPath
		projectPathSource := "opts" // logged below; both branches observable
		if projectPath == "" {
			projectPath = sa.WorkingDirectory()
			projectPathSource = "fallback"
		}

		// --- Agent state management ---
		// Create or update an agent state entry in the parent session's
		// registry so the agent panel shows the dispatch. This mirrors
		// what prompt_agent_spawner does for LLM-initiated Agent tool calls.
		agentID := fmt.Sprintf("dispatch-%s-%d-%s", opts.Name, start.UnixMilli(), conversation.NewConvSuffix())
		agentName := opts.Name
		key := sa.SessionKey()
		logDispatchWorkdir(agentName, projectPath, projectPathSource, agentID, childDepth, key)

		// Look up the spec to get a display name
		displayName := agentName
		if spec, ok := sa.LookupAgentSpec(agentName); ok && spec.Description != "" {
			displayName = spec.Description
		}
		// Fallback: inherit the display name from the extension's cached roster.
		// Extensions provide displayName via roster metadata, not via AgentSpec.
		if displayName == agentName {
			if dn := sa.LookupExtDisplayName(agentName); dn != "" {
				displayName = dn
			}
		}
		// Caller override: when the dispatcher supplied an explicit display
		// name (e.g. the orchestrator's Agent tool passes the call-site
		// description), honor it over the spec/roster resolution above.
		if opts.DisplayName != "" {
			displayName = opts.DisplayName
		}

		newDispatch := map[string]interface{}{
			"id":        agentID,
			"task":      opts.Task,
			"model":     model,
			"status":    "running",
			"startTime": start.Unix(),
		}
		// Reserve the dispatch ID in the registry BEFORE the running slot is
		// created and broadcast below. The slot becomes sweepable the moment it
		// exists; the full registration (registerDispatch) does not run until the
		// tail of dispatch setup (after loadChildExtension / tool wiring), which
		// can take seconds. A concurrent run-exit sweep in that window would snap
		// ActiveIDs without this dispatch and delete its live slot, orphaning
		// every later UpdateStateByID. Reserving here makes ActiveIDs cover the
		// slot for its entire running lifetime. registerDispatch upgrades this
		// placeholder in place (no collision warning). No-op when registry is nil.
		if registry != nil {
			registry.Reserve(agentID, agentName, currentDispatchId, childDepth)
			// Stamp the detached flag on the reservation immediately so the
			// parent's park set (ChildIDsOf) never counts a fire-and-forget
			// child, even in the window before registerDispatch upgrades the
			// placeholder. RegisterWithID preserves the flag across the
			// upgrade.
			if opts.Detached {
				registry.MarkDetached(agentID)
			}
		}
		// Persist the `running` durability record now, at registration — the
		// registry is process memory, so this on-disk record is the ONLY
		// thing that lets the next engine start detect that this dispatch
		// was in flight when the process died and announce the loss
		// (engine_dispatch_lost + dispatch_lost hook) instead of the
		// orchestrator polling an empty registry and guessing. The terminal
		// persist later supersedes it status-aware, so a normal completion
		// never reads as a loss. Best-effort by contract.
		sa.PersistDispatchRegistered(agentID, agentName, displayName, opts.Task, model, currentDispatchId, childDepth)
		sa.AppendOrUpdateAgentState(types.AgentStateUpdate{
			Name:   agentName,
			ID:     agentID,
			Status: "running",
			Metadata: map[string]interface{}{
				"displayName": displayName,
				"type":        "agent",
				"visibility":  "sticky",
				"invited":     true,
				"task":        opts.Task,
				"model":       model,
				"startTime":   start.Unix(),
				"dispatches":  []interface{}{newDispatch},
				// Nesting attribution so consumers can isolate nested
				// dispatches from root-level ones. childDepth is this agent's
				// depth (1=direct child of orchestrator, 2=grandchild, ...);
				// currentDispatchId is the parent dispatch's id (empty when the
				// orchestrator dispatched directly). The desktop/iOS main panels
				// filter to root-level agents (depth<=1) so a lead's specialists
				// appear only inside the lead's dispatch preview, not the main
				// conversation row. Mirrors the dispatchDepth/dispatchParentId
				// already carried on engine_dispatch_start telemetry below.
				"dispatchDepth":    childDepth,
				"dispatchParentId": currentDispatchId,
			},
		})
		sa.EmitAgentSnapshot("dispatch_start")

		// Fire agent_start on the parent extension group so the extension's
		// roster row flips to running.
		if extGroup := sa.ExtGroup(); extGroup != nil && !extGroup.IsEmpty() {
			utils.LogWithFields(utils.LevelInfo, "server", "firing agent_start", map[string]any{"key": key, "model": agentName, "run_id": agentID})
			startCtx := NewExtContext(sa, registry)
			extGroup.FireAgentStart(startCtx, extension.AgentInfo{
				Name: agentName,
				Task: opts.Task,
			})
		}

		// --- Live progress forwarding ---
		var (
			progressMu   sync.Mutex
			textAccum    string
			lastEmitTime time.Time
		)
		const progressInterval = 2 * time.Second
		const maxSnippetLen = 100

		emitProgress := func(work string) {
			if len(work) > maxSnippetLen {
				work = work[:maxSnippetLen]
			}
			sa.UpdateAgentStateByID(agentID, func(state *types.AgentStateUpdate) {
				if state.Metadata == nil {
					state.Metadata = map[string]interface{}{}
				}
				state.Metadata["lastWork"] = work
			})
			sa.EmitAgentSnapshot("dispatch_progress")
			// Mirror the snippet + liveness stamp onto the registry entry so
			// ext/list_dispatch_state answers "alive or wedged?" with real
			// data (Snapshot's LastWork / LastActivityMs). Same throttle
			// cadence as the agent-panel update above — no new hot path.
			// toolCount -1 = keep (the lifecycle counter owns it).
			if registry != nil {
				registry.UpdateActivity(agentID, -1, work)
			}
		}

		// Live intra-turn transcript forwarding. The emitter pushes the child's
		// tool calls, tool results, and streamed text to the parent session's
		// client stream as engine_dispatch_activity events so consumers can
		// present the live sub-agent transcript without waiting for completion.
		// Closed in runChild once the dispatch finishes (flushes trailing text).
		activity := NewDispatchActivityEmitter(sa.Emit, agentID, agentName)

		// Create child backend matching the parent session's backend type.
		child := sa.NewChildBackend()
		var childCfg *backend.RunConfig

		// childReqID is declared here (before childCfg is built) so the
		// suspendFn closure inside childCfg.Hooks.OnToolCall can reference it
		// by Go closure capture. The value is set later (line ~520) from the
		// session key and agentID, both of which are known by the time any
		// hook fires.
		var childReqID string

		// Inject context grounding (AGENTS.md/ION.md/CLAUDE.md) into the child
		// system prompt BEFORE the extension loads. The four-level policy
		// cascade (per-dispatch > session default > engine.json > built-in)
		// decides which layers are walked; content is prepended ahead of the
		// agent persona so grounding precedes role definition. The extension's
		// before_agent_start (fired inside loadChildExtension) may further
		// augment the prompt afterward.
		injectDispatchContext(agentName, projectPath, &opts, sa)

		childExtHost := loadChildExtension(sa, registry, &opts, model, projectPath, childDepth, agentID)
		if childExtHost != nil {
			childCfg = &backend.RunConfig{
				Hooks: backend.RunHooks{
					OnToolCall: func(info backend.ToolCallInfo) (*backend.ToolCallResult, error) {
						// Build the suspend closure for tool-call contexts so the
						// extension can call ctx.suspend() from inside a tool handler.
						// childReqID is declared later in this function (line ~507) but
						// the hook closure only fires after startChild() has bound the
						// run, so childReqID is populated by the time this runs.
						var suspendFn func(ids []string) error
						if sb, ok := child.(suspendableBackend); ok {
							capturedChild := sb
							suspendFn = func(ids []string) error {
								capturedChild.SignalSuspend(childReqID, ids)
								return nil
							}
						}
						tcCtx := NewExtContext(sa, registry, ExtContextOpts{
							Depth:      childDepth,
							DispatchId: agentID,
							SuspendFn:  suspendFn,
						})
						result, _ := childExtHost.FireToolCall(tcCtx, extension.ToolCallInfo{ //nolint:errcheck // best-effort; failure not actionable here
							ToolName: info.ToolName,
							ToolID:   info.ToolID,
							Input:    info.Input,
						})
						if result != nil && result.Block {
							return &backend.ToolCallResult{Block: true, Reason: result.Reason}, nil
						}
						return nil, nil
					},
				},
			}

			// Wire the child extension's registered tools into the child run.
			// Root sessions get this in wireExternalTools (prompt_runconfig.go);
			// the dispatch path previously omitted it, so a dispatched agent's
			// extension loaded (hooks fired, persona composed) but its tools —
			// including the harness's own dispatch tool — never appeared in the
			// child's tool list. That made the documented lead→specialist
			// delegation chain physically impossible: leads either did the work
			// themselves or fell back to the engine's built-in Agent tool with
			// none of the harness's tier/allowlist governance.
			wireChildExtensionTools(sa, registry, childExtHost, childCfg, childDepth, agentID)
		}

		// Thread DefaultModel so the runloop fallback fires when the child's
		// model doesn't resolve. Mirrors prompt_agent_spawner.go.
		var dispatchDefaultModel string
		if engCfg := sa.EngineConfig(); engCfg != nil {
			dispatchDefaultModel = engCfg.DefaultModel
		}
		if childCfg == nil {
			childCfg = &backend.RunConfig{DefaultModel: dispatchDefaultModel}
		} else if childCfg.DefaultModel == "" {
			childCfg.DefaultModel = dispatchDefaultModel
		}
		utils.LogWithFields(utils.LevelInfo, "session", "child run config: source=dispatch", map[string]any{"dispatch_default_model": dispatchDefaultModel, "session_key": sa.SessionKey(), "model": model})

		// Attribute background Bash tasks started by the dispatched child to
		// the parent session so StopSession kills them with the session.
		childCfg.BackgroundTaskOwner = sa.SessionKey()

		// Wire AgentSpawner so the child can dispatch grandchildren via the
		// engine Agent tool (see dispatch_child_spawner.go for rationale).
		childCfg.AgentSpawner = BuildChildAgentSpawner(sa, registry, childDepth, agentID)

		// Park-on-children: report this child's own live (non-detached)
		// dispatches at ITS turn boundary, so a lead that fire-and-forgets a
		// specialist and ends its turn parks (suspend shape) instead of
		// completing with work still in flight. The registry read is live —
		// the child dispatches mid-turn — and scoped to direct children
		// (ChildIDsOf; transitive liveness composes because each layer holds
		// its own parent open). Nil registry (tests) leaves the seam unwired
		// and the child completes exactly as before.
		if registry != nil {
			capturedRegistry := registry
			capturedAgentID := agentID
			childCfg.OutstandingChildDispatches = func() []string {
				return capturedRegistry.ChildIDsOf(capturedAgentID)
			}
			childCfg.PeekCompletedChildDispatches = func() ([]types.LlmMessage, func()) {
				results, acknowledge := capturedRegistry.PeekChildResults(capturedAgentID)
				return completedChildResultMessages(results), acknowledge
			}
		}

		// Wire OnInitialMessages so the child receives per-turn plugin
		// reinforcement (UserPromptSubmit hook output) the same way the root
		// session does. This ensures installed plugins affect dispatched agents
		// and their descendants, not just the orchestrator's root conversation.
		if len(sa.PluginSessionMessages()) > 0 || sa.PluginTurnMessages("") != nil {
			capturedSA := sa
			childCfg.Hooks.OnInitialMessages = func(runID string, prompt string) []types.LlmMessage {
				return capturedSA.PluginTurnMessages(prompt)
			}
		}

		// Wire ChildElicitFn so a dispatched child's AskUserQuestion blocks
		// and surfaces to the dispatcher via OnChildQuestion instead of
		// terminating the child run. When OnChildQuestion is nil the field is
		// left unset and the runloop falls through to the standard
		// terminate-the-run path.
		if opts.OnChildQuestion != nil {
			if childCfg == nil {
				childCfg = &backend.RunConfig{}
			}
			childCfg.ChildElicitFn = buildChildElicitFn(opts.OnChildQuestion, opts.Name, agentID, childDepth)
		}

		// Shared mutable state for the event handler closure.
		var totalCost float64
		var totalInputTokens, totalOutputTokens int
		var totalCacheReadTokens, totalCacheCreationTokens int
		var childSessionID string
		var resultText string
		var childErr error
		// suspendSig is set when the child run emits TaskSuspendEvent, meaning
		// the extension called ctx.suspend() or ctx.suspendUntilAll(). runChild
		// resets it before each LLM run so a previous suspend does not carry over.
		var suspendSig *types.TaskSuspendEvent
		// childExitCancelled is set by the OnExit callback when the child run
		// exited via an engine-initiated cancel that was NOT a recall (e.g.
		// the run-progress watchdog's "run stalled" kill). childExitCode
		// carries a non-zero exit code the same way. runChild maps both to a
		// non-zero result so the dispatcher sees an error, never a silent
		// success (root cause J). Atomics because OnExit fires on the child
		// backend's goroutine.
		var childExitCancelled atomic.Bool
		var childExitCode atomic.Int64
		var childDone sync.WaitGroup
		childDone.Add(1)
		// childDoneArmed guards childDone.Done() against double-invocation
		// (emitExit can fire on both the error path and the cancel path, and
		// a negative WaitGroup counter is fatal) while remaining re-armable
		// across suspend/revive iterations. A sync.Once cannot do this: it is
		// consumed by the FIRST run's exit, so the revived run's exit would
		// never release childDone and the dispatch would hang (the bug that
		// made every parked dispatch time out after its first revive).
		// runChild sets it to 1 (armed) each iteration; the OnExit callback
		// releases only on a 1→0 swap.
		var childDoneArmed atomic.Int32
		childDoneArmed.Store(1)
		// childToolServer is set at startChild time when this child routes to a
		// delegated-CLI backend and needs its ion tools bridged over MCP. It is
		// Stopped in the child's OnExit below so the per-child Unix socket does
		// not leak. Declared here so the OnExit closure (wired before startChild)
		// can reference it; it is populated by the time the run can exit.
		var childToolServer *backend.ToolServer

		// Estimated reasoning-token total for the child run (issue #158),
		// accumulated from the child's ThinkingBlockEndEvent stream. Surfaced
		// on DispatchAgentResult.ThinkingTokens / engine_dispatch_end so cost
		// and audit consumers can separate reasoning spend from user-facing
		// output. Estimate caveat: see ThinkingBlockEndEvent.TotalTokens.
		var totalThinkingTokens int

		// Phase 2: Lifecycle callback accumulators.
		var toolCount int
		var accumulatedText string
		// Per-turn cumulative usage tracking (only grows).
		var cumulativeInputTokens, cumulativeOutputTokens int
		var cumulativeCost float64
		// Track active tool names by ID for structured callbacks.
		toolNames := make(map[string]string)
		// lifecycleMu guards the Phase 2 lifecycle accumulators above
		// (toolNames, toolCount, accumulatedText, and the cumulative
		// usage/cost counters). The child's OnNormalized callback is invoked
		// concurrently: tool results are emitted from inside the parallel tool
		// errgroup (backend.executeTools runs each tool in its own goroutine,
		// and each goroutine routes its events through the same callback), so
		// when a child runs N tools in parallel, N goroutines enter the
		// callback at once. Without this lock the unsynchronized map writes in
		// fireLifecycleCallbacks trip Go's "concurrent map writes" fatal, which
		// bypasses recover() and hard-kills the engine process. Mirrors the
		// progressMu pattern below, which already guards the live-progress
		// accumulators in the same callback.
		var lifecycleMu sync.Mutex

		// Plan mode tracking.
		var childPlanFilePath string
		var childPlanExited bool

		// Cancellation context for background dispatch / recall support.
		// Derived from the session cancellation root (sa.RootContext())
		// rather than context.Background() so a session-level abort
		// cancels this dispatch's context alongside its explicit recall
		// path. The child agent typically runs as a separate process, so
		// the authoritative kill is still the OS-process reap in the
		// session manager's abortAllDescendants (killProcess by PID) — this
		// context cancel is the in-process half (it unblocks any
		// goroutine selecting on ctx.Done() here, e.g. background recall
		// wiring), keeping dispatch consistent with the unified tree.
		//
		// Only explicit foreground waits inherit a per-tool-call context.
		// Default asynchronous dispatches must survive their launching turn.
		dispatchParentCtx := sa.RootContext()
		if opts.WaitForCompletion && opts.ParentCtx != nil {
			dispatchParentCtx = opts.ParentCtx
		}
		ctx, cancelFn := context.WithCancel(dispatchParentCtx)
		var recalled bool
		var recallReason string

		child.OnNormalized(func(_ string, ev types.NormalizedEvent) {
			// Report child liveness to the run that is actually blocked on
			// this dispatch. Two cases (root cause I of the dispatch-lifecycle
			// incident):
			//
			//   - currentDispatchId == "": root dispatched this child. Root no
			//     longer blocks in Agent; its own run continues independently.
			//   - currentDispatchId != "": a dispatched parent may be waiting
			//     for child completion. Credit that parent's own backend run,
			//     never the root run, so its watchdog observes genuine progress.
			//
			// See
			// sessionAccessor.BumpParentProgress and
			// DispatchRegistry.BumpProgressForID.
			if currentDispatchId != "" && registry != nil {
				if !registry.BumpProgressForID(currentDispatchId) {
					// Parent dispatch gone or not bumpable (already
					// deregistered, or a delegated-CLI parent with no
					// in-process watchdog): fall back to the root bump so
					// the credit is never silently dropped on the floor.
					sa.BumpParentProgress()
				}
			} else {
				sa.BumpParentProgress()
			}

			ee := sa.TranslateEvent(ev, 0)
			if ee.Type != "" {
				if opts.OnEvent != nil {
					opts.OnEvent(ee)
				}
			}

			// Phase 2: Structured lifecycle callbacks. Guarded by lifecycleMu
			// because this callback runs concurrently across the parallel tool
			// errgroup (see lifecycleMu declaration); fireLifecycleCallbacks
			// mutates the shared accumulator map and scalars.
			lifecycleMu.Lock()
			fireLifecycleCallbacks(&opts, ev, agentID, toolNames, &toolCount, &accumulatedText,
				&cumulativeInputTokens, &cumulativeOutputTokens, &cumulativeCost)
			currentToolCount := toolCount
			lifecycleMu.Unlock()

			// Mirror the cumulative tool count + a liveness stamp onto the
			// registry entry (Snapshot's ToolCount / LastActivityMs) on tool
			// boundaries only — a natural throttle that avoids a registry
			// lock on every streamed text chunk. lastWork "" = keep (the
			// progress emitter owns the snippet).
			if registry != nil {
				switch ev.Data.(type) {
				case *types.ToolCallEvent, *types.ToolResultEvent:
					registry.UpdateActivity(agentID, currentToolCount, "")
				}
			}

			// Live progress forwarding for the agent panel.
			switch e := ev.Data.(type) {
			case *types.SessionInitEvent:
				// Capture the child's conversation ID the moment the child run
				// initializes — well before TaskCompleteEvent fires at the end.
				// The child emits SessionInitEvent early (runloop.go) and then
				// persists its conversation incrementally, so surfacing the id
				// now lets clients read and stream the live transcript while the
				// dispatch is still running instead of only after it completes.
				//
				// Fire exactly once: SessionInitEvent is emitted per child run,
				// and the terminal runChild update (below) overwrites the same
				// id idempotently with the final status/elapsed.
				if e.SessionID != "" && childSessionID == "" {
					childSessionID = e.SessionID
					// Tell the activity emitter the child conversation id so its
					// pushed deltas carry the reconcile key.
					activity.SetConversationID(childSessionID)
					if registry != nil {
						registry.SetChildConvID(agentID, childSessionID)
					}
					recordChildConvID(sa, agentID, childSessionID, opts.Name, start)
				}
			case *types.TextChunkEvent:
				// Push the streamed text to the live transcript (coalesced).
				activity.AccumulateText(e.Text)
				progressMu.Lock()
				textAccum += e.Text
				now := time.Now()
				shouldEmit := now.Sub(lastEmitTime) >= progressInterval
				snippet := textAccum
				if shouldEmit {
					lastEmitTime = now
					if len(snippet) > maxSnippetLen {
						snippet = snippet[len(snippet)-maxSnippetLen:]
					}
				}
				progressMu.Unlock()
				if shouldEmit {
					emitProgress(snippet)
				}
			case *types.ToolCallEvent:
				// Push the tool-call start to the live transcript.
				activity.HandleToolStart(e.ToolName, e.ToolID)
				progressMu.Lock()
				lastEmitTime = time.Now()
				textAccum = ""
				progressMu.Unlock()
				emitProgress(fmt.Sprintf("Using %s...", e.ToolName))
			case *types.ToolResultEvent:
				// Push the tool-result completion to the live transcript
				// (status-only; reconcile carries the full result body).
				activity.HandleToolEnd(e.ToolID, e.IsError)
			}

			// Track plan mode state from child events.
			switch pe := ev.Data.(type) {
			case *types.ThinkingBlockEndEvent:
				// Accumulate the child's estimated reasoning tokens. Redacted
				// blocks carry 0 (no readable text), so this naturally counts
				// only readable reasoning.
				totalThinkingTokens += pe.TotalTokens
			case *types.PlanModeChangedEvent:
				if pe.PlanFilePath != "" {
					childPlanFilePath = pe.PlanFilePath
					utils.LogWithFields(utils.LevelDebug, "server", "child plan file path updated", map[string]any{"model": opts.Name, "child_plan_file_path": childPlanFilePath, "session_key": sa.SessionKey()})
				}
			case *types.PlanProposalEvent:
				childPlanExited = true
				if pe.PlanFilePath != "" {
					childPlanFilePath = pe.PlanFilePath
				}
				utils.LogWithFields(utils.LevelDebug, "server", "child plan exited", map[string]any{"model": opts.Name, "child_plan_file_path": childPlanFilePath, "session_key": sa.SessionKey()})
			}

			// Capture final result, cost, and session ID from TaskCompleteEvent.
			if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
				resultText = tc.Result
				totalCost = tc.CostUsd
				if tc.Usage.InputTokens != nil {
					totalInputTokens = *tc.Usage.InputTokens
				}
				if tc.Usage.OutputTokens != nil {
					totalOutputTokens = *tc.Usage.OutputTokens
				}
				if tc.Usage.CacheReadInputTokens != nil {
					totalCacheReadTokens = *tc.Usage.CacheReadInputTokens
				}
				if tc.Usage.CacheCreationInputTokens != nil {
					totalCacheCreationTokens = *tc.Usage.CacheCreationInputTokens
				}
				if tc.SessionID != "" {
					childSessionID = tc.SessionID
				}
			}

			// Capture TaskSuspendEvent so runChild knows to park the dispatch.
			if ts, ok := ev.Data.(*types.TaskSuspendEvent); ok {
				suspendSig = ts
				utils.LogWithFields(utils.LevelInfo, "server", "child run suspended", map[string]any{
					"model":      opts.Name,
					"session_id": key,
					"awaiting":   len(ts.AwaitingDispatchIDs),
				})
			}
		})
		child.OnExit(func(_ string, code *int, signal *string, _ string) {
			// Capture the exit's code and signal BEFORE releasing runChild
			// (root cause J of the dispatch-lifecycle incident): a run the
			// engine cancelled (watchdog "run stalled", abort, any
			// engine-initiated cancel) exits code 0 with the "cancelled"
			// signal, and discarding that signal let runChild build a clean
			// ExitCode:0 result — the harness marked the dispatch done and
			// the orchestrator heard "[completed]" for a run the engine
			// itself had just killed. Map a non-recall cancel to childErr so
			// the OnError callback fires with the reason instead. A non-zero
			// exit CODE is the same signal-loss family: a backend that
			// reports failure through the exit code alone (without an
			// OnError callback) must not read as success either.
			//
			// "suspended" is the park-exit signal (drainSuspend /
			// parkForChildDispatches) — expected, not an error; suspendSig
			// makes runChild park. Recall cancels are handled by the
			// recalled flag (runChild's ctx.Done branch), not here.
			switch {
			case signal != nil && *signal == "cancelled":
				childExitCancelled.Store(true)
				utils.LogWithFields(utils.LevelWarn, "server", "child run exited via engine cancel (not recall); will surface as error", map[string]any{
					"model": opts.Name, "run_id": childReqID, "session_id": key,
				})
			case code != nil && *code != 0:
				childExitCode.Store(int64(*code))
				utils.LogWithFields(utils.LevelWarn, "server", "child run exited non-zero; will surface as error", map[string]any{
					"model": opts.Name, "run_id": childReqID, "status": *code, "session_id": key,
				})
			default:
				sigStr := ""
				if signal != nil {
					sigStr = *signal
				}
				utils.LogWithFields(utils.LevelDebug, "server", "child run exited", map[string]any{
					"model": opts.Name, "run_id": childReqID, "reason": sigStr,
				})
			}
			if childDoneArmed.CompareAndSwap(1, 0) {
				childDone.Done()
			}
		})
		child.OnError(func(_ string, err error) {
			childErr = err
		})

		// When plan mode is requested without an explicit plan-file path (the
		// normal case — a dispatch says planMode:true and lets the engine pick
		// the filename), allocate a fresh path the same way the root paths do
		// (RequestPlanModeEnter / SendPrompt). Without this the child run gets
		// PlanMode=true with PlanFilePath="" and the plan-mode write guard
		// rejects every write ("Only the plan file () is writable") while
		// ExitPlanMode reports plan mode inactive — the agent can author a plan
		// it cannot persist. Setting opts.PlanFilePath before assembly keeps
		// buildDispatchRunOptions a pure assembler; the populated path also
		// flows into the child's PlanModeChangedEvent (runloop_setup.go) so the
		// client learns the real path.
		if opts.PlanMode && opts.PlanFilePath == "" {
			opts.PlanFilePath = sa.AllocatePlanFilePath(opts.Name)
			utils.LogWithFields(utils.LevelInfo, "server", "dispatch plan mode: allocated plan file path", map[string]any{"model": opts.Name, "plan_file_path": opts.PlanFilePath, "child_depth": childDepth, "session_key": sa.SessionKey()})
		}

		// Assemble the child run options. Extracted to buildDispatchRunOptions
		// (dispatch_runopts.go) to keep this file under the 800-line cap. Thread
		// the parent session's ClaudeCompat so the child's nested-descent loader
		// applies the same Ion-vs-Claude gate as the parent.
		runOpts := buildDispatchRunOptions(&opts, model, projectPath, dispatchParentCtx, sa.ClaudeCompat(), sa)

		key = sa.SessionKey()
		// The child run id must be unique per dispatch INSTANCE. Derive it from
		// agentID, which already carries a per-dispatch uniqueness suffix
		// (dispatch-<name>-<millis>-<NewConvSuffix()>, built above). Deriving it
		// from name + UnixMilli() alone is NOT unique: two dispatches of the same
		// agent name that start in the same millisecond collide on the run id,
		// the child backend reuses one conversation for both, and one dispatch
		// entry is left without its own conversationId. agentID's NewConvSuffix()
		// guarantees distinctness even for same-millisecond concurrent dispatches.
		childReqID = fmt.Sprintf("%s-%s", key, agentID)

		// Phase 3: Emit dispatch_start telemetry on the parent session and open
		// the dispatch.agent span (family 4b). Both are folded into beginDispatch
		// (dispatch_agent_span.go) to keep this file under the file-size cap. The
		// returned span is ended in runChild's terminal path (or the background
		// goroutine's panic-recovery path). Nil span ⇒ telemetry disabled.
		dispatchSpan := beginDispatch(sa, dispatchSpanStart{
			agentID:          agentID,
			parentDispatchId: currentDispatchId,
			name:             opts.Name,
			task:             opts.Task,
			model:            model,
			childDepth:       childDepth,
			background:       !opts.WaitForCompletion,
			childReqID:       childReqID,
			extensionName:    sa.ExtensionName(),
			extensionVersion: sa.ExtensionVersion(),
		})

		// When this child routes to a delegated-CLI backend, its RunConfig is
		// dropped at dispatch (the CLI path ignores it), so the child would be
		// tool-orphaned: no extension tools (emit_briefing etc.) and no
		// ion_agent, unable to dispatch grandchildren. Wire a per-child tool
		// server from the already-built childCfg — extension tools routed via
		// its McpToolRouter, ion_agent via its AgentSpawner (grandchildren at
		// depth+1) — and attach it to runOpts (McpConfig / CliMcpServers). No-op
		// for API-routed children (they consume the RunConfig directly). The
		// server is Stopped after runChild fully returns (both call sites below),
		// spanning any suspend/revive iterations.
		if ts, err := backend.BuildDelegatedChildToolServer(child, childReqID, childCfg, &runOpts); err != nil {
			utils.LogWithFields(utils.LevelWarn, "session", "dispatch: cli child tool-server wiring failed", map[string]any{"session_key": key, "agent": agentName, "error": err.Error()})
		} else {
			childToolServer = ts
		}

		// runChild encapsulates the child backend start + wait + result
		// building logic. It is called directly for foreground dispatches
		// and in a goroutine for background dispatches.
		runChild := func() *extension.DispatchAgentResult {
			for {
				// Reset per-iteration signals so a previous run's suspend or
				// cancel does not carry over into the revived run.
				suspendSig = nil
				childExitCancelled.Store(false)
				childExitCode.Store(0)

				// Re-arm childDone for this run iteration. The first iteration
				// was already Add(1)'d at declaration; subsequent iterations
				// after a suspend revive must Add(1) again because Done() was
				// already called by the previous run's OnExit.
				// Note: we reset the WaitGroup by decrement-then-increment only
				// after doneCh is consumed (the select below), so there is no
				// race with the concurrent Done() call.
				startChild(child, childReqID, runOpts, childCfg)

				// Wait for the child to finish, but also watch for context
				// cancellation (recall).
				doneCh := make(chan struct{})
				go func() {
					childDone.Wait()
					close(doneCh)
				}()

				select {
				case <-doneCh:
					// Normal completion (or suspend).
				case <-ctx.Done():
					// Recall: cancel the child backend and wait for it to drain.
					utils.LogWithFields(utils.LevelInfo, "server", "recall context cancelled", map[string]any{"model": opts.Name, "recall_reason": recallReason, "session_id": key})
					child.Cancel(childReqID)
					<-doneCh
					recalled = true
				}

				// If the run was suspended, park the dispatch and wait for
				// revive before looping. Registry arms reviveCh and tracks
				// pending children; sendPrompt signals reviveCh when all
				// conditions are met.
				if suspendSig != nil && !recalled {
					utils.LogWithFields(utils.LevelInfo, "server", "dispatch suspended, parking until revive", map[string]any{
						"model":    opts.Name,
						"awaiting": len(suspendSig.AwaitingDispatchIDs),
					})

					// Update agent state to "suspended" so the UI reflects idle.
					sa.UpdateAgentStateByID(agentID, func(state *types.AgentStateUpdate) {
						state.Status = "suspended"
						if state.Metadata == nil {
							state.Metadata = map[string]interface{}{}
						}
						state.Metadata["lastWork"] = "suspended — waiting for children"
					})
					sa.EmitAgentSnapshot("dispatch_suspend")

					// Arm the revive channel in the registry. A false return
					// means every awaited child already completed in the
					// window between the park emission and this arming
					// (their NotifyChildComplete fired against a nil
					// ReviveCh and will never fire again) — self-signal so
					// the select below takes the revive branch immediately
					// instead of parking forever on a satisfied wait.
					reviveCh := make(chan struct{}, 1)
					if registry != nil {
						if !registry.SetSuspendedState(agentID, reviveCh, suspendSig.AwaitingDispatchIDs) {
							reviveCh <- struct{}{}
						}
					}

					// Block until revived (or recalled).
					select {
					case <-reviveCh:
						// Revived — restart the LLM run as a RESUME, never a
						// replay. Two mutations on runOpts before the loop
						// re-enters startChild (root cause K, the
						// 1785418884327 incident — a revived lead replayed
						// its original task from the top, re-dispatched its
						// specialist, and looped indefinitely):
						//
						//  1. ConversationID pins the child's own
						//     conversation, so the revived run loads the
						//     history where the agent already did its
						//     pre-park work. On the first run this was empty
						//     (fresh conversation) unless the caller passed
						//     sessionId; childSessionID was captured from
						//     the run's SessionInitEvent.
						//  2. Prompt becomes the revive message: the awaited
						//     children's actual results (drained from the
						//     registry, recorded on every child terminal
						//     path), replacing the original task — which is
						//     already in the conversation history as turn 1.
						if childSessionID != "" {
							runOpts.ConversationID = childSessionID
						}
						var drained []ChildResultRecord
						if registry != nil {
							drained = registry.DrainChildResults(agentID)
						}
						runOpts.Prompt = buildReviveResumePrompt(drained)
						utils.LogWithFields(utils.LevelInfo, "server", "dispatch revived, resuming LLM run with child results", map[string]any{
							"model":           opts.Name,
							"session_id":      key,
							"conversation_id": runOpts.ConversationID,
							"count":           len(drained),
						})
						if registry != nil {
							registry.ClearSuspendedState(agentID)
						}
						// Re-arm childDone AND the release guard for the next
						// run. Order matters: the WaitGroup must be re-armed
						// before the guard flips to 1, or a stray late exit
						// could release a zero-count WaitGroup.
						childDone.Add(1)
						childDoneArmed.Store(1)
						// Update agent state back to "running".
						sa.UpdateAgentStateByID(agentID, func(state *types.AgentStateUpdate) {
							state.Status = "running"
							if state.Metadata != nil {
								state.Metadata["lastWork"] = "revived"
							}
						})
						sa.EmitAgentSnapshot("dispatch_revive")
						continue
					case <-ctx.Done():
						// Recalled while suspended.
						utils.LogWithFields(utils.LevelInfo, "server", "dispatch recalled while suspended", map[string]any{"model": opts.Name, "recall_reason": recallReason})
						recalled = true
						if registry != nil {
							registry.ClearSuspendedState(agentID)
						}
					}
				}

				// Normal exit (done, error, or recalled): break the loop.
				break
			}

			elapsed := time.Since(start).Seconds()

			// Flush any trailing buffered transcript text and stop the
			// activity emitter's coalesce timer now that the child is done.
			activity.Close()

			// NOTE: BOTH the child-extension dispose and the registry
			// deregistration are deliberately deferred until AFTER the terminal
			// agent-state transition below.
			//
			// Deregister removes the dispatch from ActiveIDs; if it ran here
			// (before the slot is marked terminal), a concurrent run-exit sweep
			// in the gap would delete the still-"running" slot and the terminal
			// UpdateStateByID would land nowhere. Marking the slot terminal
			// first (a terminal slot is never swept) closes that window. See the
			// Deregister block after EmitAgentSnapshot("dispatch_end").
			//
			// Dispose is subject to the same constraint for a less obvious
			// reason: it is SLOW on the failure path. disposeInternal kills the
			// subprocess and then waits for it to be reaped, capped by a 2s
			// safety net that real extensions hit routinely. Running it here
			// held the dispatch in "running" for those 2 seconds with the child
			// already finished — a wide, easily-lost race against any run-exit
			// sweep, paid on every single completion. The child process is
			// already dead by the time we get here; reaping it is cleanup, not a
			// precondition for reporting the outcome, so it now runs after the
			// terminal transition, Deregister, and the callbacks.

			// Build the result. An engine-initiated cancel that was not a
			// recall (childExitCancelled — e.g. the run-progress watchdog's
			// "run stalled" kill) or a non-zero exit code surfaces as
			// childErr so the result is a non-zero exit and OnError fires;
			// before this mapping the cancel's signal and the exit code were
			// discarded and the dispatcher received a clean "completion" for
			// a killed run (root cause J).
			if childErr == nil && !recalled {
				if childExitCancelled.Load() {
					childErr = fmt.Errorf("run cancelled by engine (not recalled): the child run was terminated before completing — likely the run-progress watchdog (run stalled) or a session abort; partial output: %.200s", resultText)
				} else if ec := childExitCode.Load(); ec != 0 {
					childErr = fmt.Errorf("child run exited with code %d; partial output: %.200s", ec, resultText)
				}
			}
			exitCode := 0
			output := resultText
			if recalled {
				exitCode = ExitCodeRecalled
				output = fmt.Sprintf("recalled: %s", recallReason)
			} else if childErr != nil {
				exitCode = 1
				output = childErr.Error()
			}

			result := &extension.DispatchAgentResult{
				Name:                     opts.Name,
				DispatchID:               agentID,
				Output:                   output,
				ExitCode:                 exitCode,
				Elapsed:                  elapsed,
				Cost:                     totalCost,
				InputTokens:              totalInputTokens,
				OutputTokens:             totalOutputTokens,
				ThinkingTokens:           totalThinkingTokens,
				CacheReadInputTokens:     totalCacheReadTokens,
				CacheCreationInputTokens: totalCacheCreationTokens,
				SessionID:                childSessionID,
				PlanFilePath:             childPlanFilePath,
				PlanExited:               childPlanExited,
				Depth:                    childDepth,
				ParentDispatchId:         currentDispatchId,
			}

			// A childErr synthesized from OnExit (engine cancel / non-zero
			// backend exit) is learned AFTER the child backend completed its final
			// conversation save. The parent result and agent-state row correctly
			// say "error", but without this append the child transcript ends on
			// ordinary assistant prose and looks successful when inspected. Persist
			// the same terminal error into the child conversation before publishing
			// the error state so status and history become true atomically from the
			// consumer's perspective. Recall is deliberately excluded: it is a
			// cancelled terminal state, not an error.
			if childErr != nil && !recalled {
				if childSessionID == "" {
					utils.LogWithFields(utils.LevelWarn, "server", "dispatch error has no child conversation; durable error row cannot be written", map[string]any{
						"session_id":  key,
						"dispatch_id": agentID,
						"model":       agentName,
						"error":       childErr.Error(),
					})
				} else if err := conversation.AppendDispatchError(childSessionID, agentID, childErr.Error()); err != nil {
					utils.LogWithFields(utils.LevelError, "server", "dispatch error persistence failed", map[string]any{
						"session_id":      key,
						"conversation_id": childSessionID,
						"dispatch_id":     agentID,
						"model":           agentName,
						"error":           err.Error(),
					})
				} else {
					utils.LogWithFields(utils.LevelInfo, "server", "dispatch error persisted to child conversation", map[string]any{
						"session_id":      key,
						"conversation_id": childSessionID,
						"dispatch_id":     agentID,
						"model":           agentName,
					})
				}
			}

			// Update agent state with terminal status and conversation ID.
			// Upsert (not plain update): after the birth-gap and death-gap fixes
			// the slot is always present here, but if some future lifecycle gap
			// ever leaves it swept, the terminal transition re-materializes the
			// slot as terminal rather than being silently dropped and stranding
			// the agent as "running". The seed is a minimal coherent row; when the
			// slot already exists it is ignored and the updater runs in place,
			// preserving the accumulated dispatches[]/conversationIds metadata.
			terminalSeed := types.AgentStateUpdate{
				Name:   agentName,
				ID:     agentID,
				Status: "running",
				Metadata: map[string]interface{}{
					"displayName":      displayName,
					"type":             "agent",
					"task":             opts.Task,
					"model":            model,
					"dispatchDepth":    childDepth,
					"dispatchParentId": currentDispatchId,
				},
			}
			sa.UpsertAgentStateByID(agentID, terminalSeed, func(state *types.AgentStateUpdate) {
				if state.Metadata == nil {
					state.Metadata = map[string]interface{}{}
				}
				if recalled {
					state.Status = "cancelled"
					state.Metadata["lastWork"] = "cancelled: " + recallReason
				} else if childErr != nil {
					state.Status = "error"
					state.Metadata["lastWork"] = childErr.Error()
				} else {
					state.Status = "done"
					lw := resultText
					if len(lw) > maxSnippetLen {
						lw = lw[:maxSnippetLen]
					}
					state.Metadata["lastWork"] = lw
				}
				state.Metadata["elapsed"] = elapsed
				if childSessionID != "" {
					// Append only if the early SessionInitEvent path (above) did
					// not already record this id, so conversationIds carries no
					// duplicate when the id was captured at dispatch start.
					existing, _ := state.Metadata["conversationIds"].([]interface{}) //nolint:errcheck // best-effort; failure not actionable here
					alreadyPresent := false
					for _, v := range existing {
						if s, ok := v.(string); ok && s == childSessionID {
							alreadyPresent = true
							break
						}
					}
					if !alreadyPresent {
						state.Metadata["conversationIds"] = append(existing, childSessionID)
					}
					state.Metadata["conversationId"] = childSessionID
				}
				// Update the current dispatch entry in the structured dispatches array.
				agents.UpdateDispatchEntry(state.Metadata, agentID, state.Status, elapsed, childSessionID)
			})
			sa.EmitAgentSnapshot("dispatch_end")

			// Record a non-detached asynchronous child's terminal result BEFORE
			// deregistration. The parent sees either a live child or this record
			// at every turn boundary, closing the completion/deregister race.
			if !opts.WaitForCompletion && !opts.Detached && registry != nil && currentDispatchId != "" {
				if !registry.RecordChildResult(currentDispatchId, ChildResultRecord{
					ChildID:  agentID,
					Name:     opts.Name,
					Output:   result.Output,
					ExitCode: result.ExitCode,
				}) {
					// Parent already ended or disappeared. Root fallback keeps a
					// non-detached result from becoming invisible.
					if root, ok := sa.(RootDispatchResultDelivery); ok {
						root.DeliverRootDispatchResult(*result)
					}
				}
			}

			// Deregister from the dispatch registry (both foreground and
			// background), now that the slot carries a terminal status. Deferred
			// to here (from before the terminal transition) so the dispatch stays
			// in ActiveIDs until its slot is terminal — a terminal slot is never
			// swept, so no run-exit clear can orphan it and the terminal update
			// above always landed on a real slot.
			if registry != nil {
				registry.Deregister(agentID)
				// Re-emit engine_status with the updated BackgroundAgents count so
				// the parent session clears its "waiting on background agent" state.
				// handleRunExit sampled bgCount BEFORE Deregister ran; nothing
				// re-emits after, leaving a stale BackgroundAgents:1 (or N) as the
				// last value the client sees. This call is the correction.
				sa.EmitDispatchCountStatus("dispatch_deregister")
			}

			// Fire agent_end on the parent extension group.
			if extGroup := sa.ExtGroup(); extGroup != nil && !extGroup.IsEmpty() {
				utils.LogWithFields(utils.LevelInfo, "server", "firing agent_end", map[string]any{"key": key, "model": agentName, "run_id": agentID, "exit_code": exitCode})
				endCtx := NewExtContext(sa, registry)
				extGroup.FireAgentEnd(endCtx, extension.AgentInfo{
					Name: agentName,
					Task: opts.Task,
				})
			}

			// Emit engine_dispatch_end and end the dispatch.agent span (family
			// 4b). Folded into finishDispatch (dispatch_agent_span.go).
			finishDispatch(sa, dispatchSpan, dispatchSpanEnd{
				name:                     opts.Name,
				agentID:                  agentID,
				parentDispatchId:         currentDispatchId,
				childDepth:               childDepth,
				elapsed:                  elapsed,
				exitCode:                 exitCode,
				cost:                     totalCost,
				inputTokens:              totalInputTokens,
				outputTokens:             totalOutputTokens,
				thinkingTokens:           totalThinkingTokens,
				cacheReadInputTokens:     totalCacheReadTokens,
				cacheCreationInputTokens: totalCacheCreationTokens,
				toolCount:                toolCount,
				childConversationID:      childSessionID,
				recalled:                 recalled,
			})

			utils.LogWithFields(utils.LevelInfo, "server", "dispatch complete", map[string]any{"model": opts.Name, "exit_code": exitCode, "elapsed": elapsed, "total_cost": totalCost, "tool_count": toolCount, "session_id": key})

			// Cleanup the child extension subprocess. Last, deliberately: see
			// the NOTE above the result construction. Dispose kills the child
			// host and waits on the reap (bounded at 2s), and every millisecond
			// of that wait used to sit between the child finishing and its slot
			// being marked terminal, which is exactly the window a run-exit
			// sweep can orphan the slot in. Everything a consumer observes —
			// terminal agent state, Deregister, agent_end, dispatch_end — has
			// already happened by this point, so a slow reap now delays nothing
			// but its own cleanup.
			if childExtHost != nil {
				childExtHost.Dispose()
			}

			return result
		}

		if !opts.WaitForCompletion {
			// Register in the dispatch registry for recall support, child-run
			// steering, and the carry-forward allowlist. See registerDispatch.
			registerDispatch(registry, agentID, opts.Name, func() {
				recallReason = "recall_agent"
				cancelFn()
			}, child, key, currentDispatchId, childDepth, childReqID, opts.AllowedSubAgents, opts.SubAgentPolicy)

			// Launch the child in a goroutine and return a stub immediately.
			//
			// The deferred recover() block is the safety backstop for the
			// "agent never reaches terminal status" failure mode. Today's
			// runChild path emits agent_end on every exit branch (normal
			// completion, child error, recall) — but any panic inside
			// runChild, startChild, the child OnNormalized callback, the
			// progress emitter, or the agent-state UpdateAgentStateByID
			// closure would otherwise kill this goroutine silently. No
			// agent_end fires, no dispatch_end telemetry is emitted, the
			// dispatch registry retains the agent name forever, and the
			// background_agents counter on engine_status stays positive
			// until the engine process restarts. The original incident
			// in conversation 1780874102870-12aee36b1e8d (see
			// docs/diagnoses or the plan file) is the textbook example.
			//
			// Recovery here synthesizes the same terminal transitions
			// that runChild's success/error/recall branches do: agent
			// status flips to "error", an agent_state snapshot fires,
			// agent_end fires on the parent extension group, and the
			// dispatch registry deregisters the name. The result is
			// that consumers see exactly the same lifecycle they would
			// for any other dispatch failure, with the panic message
			// available in lastWork for postmortem.
			go func() {
				defer cancelFn() // ensure context is cleaned up when goroutine exits
				defer func() {
					if r := recover(); r != nil {
						// End the dispatch.agent span on the panic path so a
						// background dispatch that panics still closes its span
						// (family 4b). runChild's normal end path is bypassed by
						// the panic, so this is the span's terminal edge here.
						endDispatchSpanPanic(dispatchSpan, r)
						recoverBackgroundDispatchPanic(
							sa, registry, opts, key, agentID, agentName, r,
							childDepth, currentDispatchId, childToolServer,
							func(result extension.DispatchAgentResult) {
								if opts.OnError != nil {
									opts.OnError(extension.DispatchError{
										Name:       opts.Name,
										DispatchID: result.DispatchID,
										Message:    result.Output,
										ExitCode:   result.ExitCode,
										Elapsed:    result.Elapsed,
									})
								}
							},
						)
					}
				}()
				result := runChild()
				// The dispatch is fully done (including any suspend/revive
				// iterations); release the per-child CLI tool-server socket.
				if childToolServer != nil {
					childToolServer.Stop()
				}

				// Notify the parent dispatch registry before optional callbacks. The
				// result was recorded before deregistration, so a parent now sees the
				// terminal record or wakes immediately regardless of observer behavior.
				if registry != nil && currentDispatchId != "" {
					registry.NotifyChildComplete(currentDispatchId, agentID)
				} else if !opts.Detached {
					if root, ok := sa.(RootDispatchResultDelivery); ok {
						root.DeliverRootDispatchResult(*result)
					} else {
						utils.LogWithFields(utils.LevelWarn, "server", "root dispatch completion has no session delivery seam", map[string]any{
							"session_key": key, "dispatch_id": agentID, "model": opts.Name,
						})
					}
				}

				// Callbacks observe terminal state only. Isolate failures so a
				// callback cannot re-panic this goroutine after owner delivery.
				if recalled {
					invokeDispatchCallback(func() {
						if opts.OnRecall != nil {
							opts.OnRecall(extension.RecallInfo{
								Name:       opts.Name,
								DispatchID: agentID,
								Reason:     recallReason,
								Elapsed:    result.Elapsed,
								ToolCount:  toolCount,
							})
						}
					}, key, agentID, "recall")
				} else if childErr != nil || result.ExitCode != 0 {
					invokeDispatchCallback(func() {
						if opts.OnError != nil {
							opts.OnError(extension.DispatchError{
								Name:       opts.Name,
								DispatchID: agentID,
								Message:    result.Output,
								ExitCode:   result.ExitCode,
								Elapsed:    result.Elapsed,
							})
						}
					}, key, agentID, "error")
				} else {
					invokeDispatchCallback(func() {
						if opts.OnComplete != nil {
							opts.OnComplete(*result)
						}
					}, key, agentID, "complete")
				}

			}()

			utils.LogWithFields(utils.LevelInfo, "server", "background dispatch started", map[string]any{"model": opts.Name, "session_id": key})

			// Return a stub result immediately.
			return &extension.DispatchAgentResult{
				Name:       opts.Name,
				DispatchID: agentID,
				SessionID:  childReqID,
			}, nil
		}

		// Foreground (synchronous) dispatch.
		// Register in the dispatch registry so foreground dispatches are
		// recallable, counted, and steerable, matching background behavior.
		registerDispatch(registry, agentID, opts.Name, func() {
			recallReason = "recall_agent"
			cancelFn()
		}, child, key, currentDispatchId, childDepth, childReqID, opts.AllowedSubAgents, opts.SubAgentPolicy)

		defer cancelFn() // clean up the context
		// Release the per-child CLI tool-server socket on every return path.
		defer func() {
			if childToolServer != nil {
				childToolServer.Stop()
			}
		}()
		result := runChild()

		if childErr != nil {
			return result, childErr
		}
		return result, nil
	}
}

// fireLifecycleCallbacks and truncate live in dispatch_lifecycle_callbacks.go,
// and loadChildExtension and startChild live in dispatch_child_setup.go (all
// same package) to keep this file under the 800-line cap.
