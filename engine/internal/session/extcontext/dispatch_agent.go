package extcontext

import (
	"context"
	"fmt"
	"sync"
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

		start := time.Now()

		utils.LogWithFields(utils.LevelInfo, "server", "starting dispatch", map[string]any{"model": opts.Name, "truncate": truncate(opts.Task, 80), "model_2": opts.Model, "count": len(opts.SystemPrompt), "background": opts.Background, "plan_mode": opts.PlanMode, "session_key": sa.SessionKey()})

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
			startCtx := NewExtContext(sa)
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
						tcCtx := NewExtContext(sa, ExtContextOpts{
							Depth:      childDepth,
							DispatchId: agentID,
							Registry:   registry,
						})
						result, _ := childExtHost.FireToolCall(tcCtx, extension.ToolCallInfo{
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
		utils.LogWithFields(utils.LevelInfo, "session", "child run config: source=dispatch", map[string]any{"model": dispatchDefaultModel, "session_key": sa.SessionKey(), "model_2": model})

		// Wire AgentSpawner so the child can dispatch grandchildren via the
		// engine Agent tool (see dispatch_child_spawner.go for rationale).
		childCfg.AgentSpawner = BuildChildAgentSpawner(sa, registry, childDepth, agentID)

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
		var childDone sync.WaitGroup
		childDone.Add(1)
		// childDoneOnce guards childDone.Done() against double-invocation:
		// emitExit can fire on both the error path and the cancel path, and a
		// negative WaitGroup counter is fatal.
		var childDoneOnce sync.Once

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
		// Parent selection: when the caller supplied opts.ParentCtx (the
		// orchestrator's Agent tool passes its per-tool-call context), derive
		// from it so cancelling that call cancels this dispatch. The tool-call
		// context is itself derived from the session, so a session abort still
		// cascades. When nil, fall back to the session cancellation root --
		// the prior behavior for extension-initiated dispatches.
		dispatchParentCtx := sa.RootContext()
		if opts.ParentCtx != nil {
			dispatchParentCtx = opts.ParentCtx
		}
		ctx, cancelFn := context.WithCancel(dispatchParentCtx)
		var recalled bool
		var recallReason string

		child.OnNormalized(func(_ string, ev types.NormalizedEvent) {
			// Report child liveness to the parent run's progress watchdog.
			// A genuine child event proves the dispatch is alive; the parent
			// run is parked in the deadline-exempt Agent tool call and emits
			// no progress of its own, so without this it could be flagged as
			// stalled once the self-emitted ToolStalledEvent advisory stopped
			// counting as progress. See sessionAccessor.BumpParentProgress.
			sa.BumpParentProgress()

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
			lifecycleMu.Unlock()

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
		})
		child.OnExit(func(_ string, _ *int, _ *string, _ string) {
			childDoneOnce.Do(childDone.Done)
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
			opts.PlanFilePath = sa.AllocatePlanFilePath()
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
		childReqID := fmt.Sprintf("%s-%s", key, agentID)

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
			background:       opts.Background,
			childReqID:       childReqID,
			extensionName:    sa.ExtensionName(),
			extensionVersion: sa.ExtensionVersion(),
		})

		// runChild encapsulates the child backend start + wait + result
		// building logic. It is called directly for foreground dispatches
		// and in a goroutine for background dispatches.
		runChild := func() *extension.DispatchAgentResult {
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
				// Normal completion.
			case <-ctx.Done():
				// Recall: cancel the child backend and wait for it to drain.
				utils.LogWithFields(utils.LevelInfo, "server", "recall context cancelled", map[string]any{"model": opts.Name, "recall_reason": recallReason, "session_id": key})
				child.Cancel(childReqID)
				<-doneCh
				recalled = true
			}

			elapsed := time.Since(start).Seconds()

			// Flush any trailing buffered transcript text and stop the
			// activity emitter's coalesce timer now that the child is done.
			activity.Close()

			// Cleanup child extension.
			if childExtHost != nil {
				childExtHost.Dispose()
			}

			// Deregister from the dispatch registry (both foreground and background).
			if registry != nil {
				registry.Deregister(agentID)
				// Re-emit engine_status with the updated BackgroundAgents count so
				// the parent session clears its "waiting on background agent" state.
				// handleRunExit sampled bgCount BEFORE Deregister ran; nothing
				// re-emits after, leaving a stale BackgroundAgents:1 (or N) as the
				// last value the client sees. This call is the correction.
				sa.EmitDispatchCountStatus("dispatch_deregister")
			}

			// Build the result.
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

			// Update agent state with terminal status and conversation ID.
			sa.UpdateAgentStateByID(agentID, func(state *types.AgentStateUpdate) {
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
					existing, _ := state.Metadata["conversationIds"].([]interface{})
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

			// Fire agent_end on the parent extension group.
			if extGroup := sa.ExtGroup(); extGroup != nil && !extGroup.IsEmpty() {
				utils.LogWithFields(utils.LevelInfo, "server", "firing agent_end", map[string]any{"key": key, "model": agentName, "run_id": agentID, "exit_code": exitCode})
				endCtx := NewExtContext(sa)
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

			return result
		}

		if opts.Background {
			// Register in the dispatch registry for recall support, child-run
			// steering, and the carry-forward allowlist. See registerDispatch.
			registerDispatch(registry, agentID, opts.Name, func() {
				recallReason = "recall_agent"
				cancelFn()
			}, child, key, currentDispatchId, childDepth, childReqID, opts.AllowedSubAgents)

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
							childDepth, currentDispatchId,
						)
					}
				}()
				result := runChild()

				// Fire the appropriate callback.
				if recalled {
					if opts.OnRecall != nil {
						opts.OnRecall(extension.RecallInfo{
							DispatchID: agentID,
							Reason:     recallReason,
							Elapsed:    result.Elapsed,
							ToolCount:  toolCount,
						})
					}
				} else if childErr != nil || result.ExitCode != 0 {
					if opts.OnError != nil {
						opts.OnError(extension.DispatchError{
							DispatchID: agentID,
							Message:    result.Output,
							ExitCode:   result.ExitCode,
							Elapsed:    result.Elapsed,
						})
					}
				} else {
					if opts.OnComplete != nil {
						opts.OnComplete(*result)
					}
				}
			}()

			utils.LogWithFields(utils.LevelInfo, "server", "background dispatch started", map[string]any{"model": opts.Name, "session_id": key})

			// Return a stub result immediately.
			return &extension.DispatchAgentResult{
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
		}, child, key, currentDispatchId, childDepth, childReqID, opts.AllowedSubAgents)

		defer cancelFn() // clean up the context
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

