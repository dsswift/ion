package extcontext

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ExitCodeRecalled is the exit code used when a dispatch is cancelled via
// RecallAgent. Distinct from 0 (success) and 1 (error) so consumers can
// distinguish recall from failure.
const ExitCodeRecalled = 2

// BuildDispatchAgentFunc returns the DispatchAgent closure that creates a
// child session within the engine with optional extension loading, system
// prompt injection, and event streaming.
//
// When opts.Background is true, the dispatch returns a stub result immediately
// and runs the child session in a goroutine. The terminal outcome is delivered
// via opts.OnComplete, opts.OnError, or opts.OnRecall callbacks.
//
// Phase 2 lifecycle callbacks (OnToolStart, OnToolEnd, OnToolError, OnUsage,
// OnTextDelta) fire from the existing OnNormalized handler during dispatch,
// parsing event types once and delivering structured data.
//
// Phase 3 telemetry events (engine_dispatch_start, engine_dispatch_end) are
// emitted on the parent session's event stream when a dispatch begins and ends.
func BuildDispatchAgentFunc(sa SessionAccessor, registry *DispatchRegistry) func(extension.DispatchAgentOpts) (*extension.DispatchAgentResult, error) {
	return func(opts extension.DispatchAgentOpts) (*extension.DispatchAgentResult, error) {
		start := time.Now()

		utils.Log("Dispatch", fmt.Sprintf(
			"starting dispatch agent=%q task=%q model=%q sysPromptLen=%d background=%v planMode=%v session=%s",
			opts.Name, truncate(opts.Task, 80), opts.Model, len(opts.SystemPrompt), opts.Background, opts.PlanMode, sa.SessionKey(),
		))

		// Determine model and project path.
		model := opts.Model
		if model == "" {
			if cfg := sa.EngineConfig(); cfg != nil {
				model = cfg.DefaultModel
			}
		}
		projectPath := opts.ProjectPath
		if projectPath == "" {
			projectPath = sa.WorkingDirectory()
		}

		// --- Agent state management ---
		// Create or update an agent state entry in the parent session's
		// registry so the agent panel shows the dispatch. This mirrors
		// what prompt_agent_spawner does for LLM-initiated Agent tool calls.
		agentID := fmt.Sprintf("dispatch-%s-%d", opts.Name, start.UnixMilli())
		agentName := opts.Name
		key := sa.SessionKey()

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
			},
		})
		sa.EmitAgentSnapshot("dispatch_start")

		// Fire agent_start on the parent extension group so the extension's
		// roster row flips to running.
		if extGroup := sa.ExtGroup(); extGroup != nil && !extGroup.IsEmpty() {
			utils.Log("Dispatch", fmt.Sprintf("firing agent_start key=%s name=%s id=%s", key, agentName, agentID))
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

		// Create child backend matching the parent session's backend type.
		child := sa.NewChildBackend()
		var childCfg *backend.RunConfig

		childExtHost := loadChildExtension(sa, &opts, model, projectPath)
		if childExtHost != nil {
			childCfg = &backend.RunConfig{
				Hooks: backend.RunHooks{
					OnToolCall: func(info backend.ToolCallInfo) (*backend.ToolCallResult, error) {
						tcCtx := NewExtContext(sa)
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
		}

		// Thread the engine's DefaultModel into the child run config so the
		// runloop fallback (runloop.go:57) fires when the child's model
		// doesn't resolve to a provider. Without this, dispatched children
		// hard-fail with "no provider found" when the requested model is
		// an unconfigured tier alias. Mirrors the spawner-side fix in
		// prompt_agent_spawner.go. See plan §1 "Secondary path note".
		var dispatchDefaultModel string
		if engCfg := sa.EngineConfig(); engCfg != nil {
			dispatchDefaultModel = engCfg.DefaultModel
		}
		if childCfg == nil {
			childCfg = &backend.RunConfig{DefaultModel: dispatchDefaultModel}
		} else if childCfg.DefaultModel == "" {
			childCfg.DefaultModel = dispatchDefaultModel
		}
		utils.Log("Session", fmt.Sprintf("child run config: defaultModelThreaded=%q source=dispatch sessionKey=%s requestedModel=%q", dispatchDefaultModel, sa.SessionKey(), model))

		// Shared mutable state for the event handler closure.
		var totalCost float64
		var totalInputTokens, totalOutputTokens int
		var totalCacheReadTokens, totalCacheCreationTokens int
		var childSessionID string
		var resultText string
		var childErr error
		var childDone sync.WaitGroup
		childDone.Add(1)

		// Phase 2: Lifecycle callback accumulators.
		var toolCount int
		var accumulatedText string
		// Per-turn cumulative usage tracking (only grows).
		var cumulativeInputTokens, cumulativeOutputTokens int
		var cumulativeCost float64
		// Track active tool names by ID for structured callbacks.
		toolNames := make(map[string]string)

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
		ctx, cancelFn := context.WithCancel(sa.RootContext())
		var recalled bool
		var recallReason string

		child.OnNormalized(func(_ string, ev types.NormalizedEvent) {
			ee := sa.TranslateEvent(ev, 0)
			if ee.Type != "" {
				if opts.OnEvent != nil {
					opts.OnEvent(ee)
				}
			}

			// Phase 2: Structured lifecycle callbacks.
			fireLifecycleCallbacks(&opts, ev, agentID, toolNames, &toolCount, &accumulatedText,
				&cumulativeInputTokens, &cumulativeOutputTokens, &cumulativeCost)

			// Live progress forwarding for the agent panel.
			switch e := ev.Data.(type) {
			case *types.TextChunkEvent:
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
				progressMu.Lock()
				lastEmitTime = time.Now()
				textAccum = ""
				progressMu.Unlock()
				emitProgress(fmt.Sprintf("Using %s...", e.ToolName))
			}

			// Track plan mode state from child events.
			switch pe := ev.Data.(type) {
			case *types.PlanModeChangedEvent:
				if pe.PlanFilePath != "" {
					childPlanFilePath = pe.PlanFilePath
					utils.Debug("Dispatch", fmt.Sprintf(
						"child plan file path updated agent=%q planFilePath=%q session=%s",
						opts.Name, childPlanFilePath, sa.SessionKey(),
					))
				}
			case *types.PlanProposalEvent:
				childPlanExited = true
				if pe.PlanFilePath != "" {
					childPlanFilePath = pe.PlanFilePath
				}
				utils.Debug("Dispatch", fmt.Sprintf(
					"child plan exited agent=%q planFilePath=%q session=%s",
					opts.Name, childPlanFilePath, sa.SessionKey(),
				))
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
			childDone.Done()
		})
		child.OnError(func(_ string, err error) {
			childErr = err
		})

		runOpts := types.RunOptions{
			Prompt:      opts.Task,
			Model:       model,
			ProjectPath: projectPath,
			// Derive the child run from the session cancellation root so a
			// session abort cascades to in-process child runs (ApiBackend).
			// Process-backed children (CliBackend) are additionally reaped
			// by PID kill in the manager's abortAllDescendants; threading
			// the parent here makes the in-process backends consistent with
			// the unified tree rather than orphaned on Background.
			ParentCtx: sa.RootContext(),
		}
		if opts.SystemPrompt != "" {
			runOpts.AppendSystemPrompt = opts.SystemPrompt
		}
		if opts.SessionID != "" {
			runOpts.SessionID = opts.SessionID
		}
		if opts.MaxTurns > 0 {
			runOpts.MaxTurns = opts.MaxTurns
		}
		if opts.PlanMode {
			runOpts.PlanMode = true
			if opts.PlanFilePath != "" {
				runOpts.PlanFilePath = opts.PlanFilePath
			}
			if len(opts.PlanModeTools) > 0 {
				runOpts.PlanModeTools = opts.PlanModeTools
			}
		}

		key = sa.SessionKey()
		childReqID := fmt.Sprintf("%s-dispatch-%s", key, opts.Name)

		// Phase 3: Emit dispatch_start telemetry on the parent session.
		sa.Emit(types.EngineEvent{
			Type:              "engine_dispatch_start",
			DispatchAgent:     opts.Name,
			DispatchTask:      opts.Task,
			DispatchModel:     model,
			DispatchSessionID: childReqID,
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
				utils.Log("Dispatch", fmt.Sprintf(
					"recall context cancelled agent=%q reason=%q session=%s",
					opts.Name, recallReason, key,
				))
				child.Cancel(childReqID)
				<-doneCh
				recalled = true
			}

			elapsed := time.Since(start).Seconds()

			// Cleanup child extension.
			if childExtHost != nil {
				childExtHost.Dispose()
			}

			// Deregister from the dispatch registry (background dispatches only).
			if opts.Background && registry != nil {
				registry.Deregister(opts.Name)
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
				Output:                   output,
				ExitCode:                 exitCode,
				Elapsed:                  elapsed,
				Cost:                     totalCost,
				InputTokens:              totalInputTokens,
				OutputTokens:             totalOutputTokens,
				CacheReadInputTokens:     totalCacheReadTokens,
				CacheCreationInputTokens: totalCacheCreationTokens,
				SessionID:                childSessionID,
				PlanFilePath:             childPlanFilePath,
				PlanExited:               childPlanExited,
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
					existing, _ := state.Metadata["conversationIds"].([]interface{})
					state.Metadata["conversationIds"] = append(existing, childSessionID)
					state.Metadata["conversationId"] = childSessionID
				}
				// Update the current dispatch entry in the structured dispatches array.
				agents.UpdateDispatchEntry(state.Metadata, agentID, state.Status, elapsed, childSessionID)
			})
			sa.EmitAgentSnapshot("dispatch_end")

			// Fire agent_end on the parent extension group.
			if extGroup := sa.ExtGroup(); extGroup != nil && !extGroup.IsEmpty() {
				utils.Log("Dispatch", fmt.Sprintf("firing agent_end key=%s name=%s id=%s status=%d", key, agentName, agentID, exitCode))
				endCtx := NewExtContext(sa)
				extGroup.FireAgentEnd(endCtx, extension.AgentInfo{
					Name: agentName,
					Task: opts.Task,
				})
			}

			// Phase 3: Emit dispatch_end telemetry on the parent session.
			sa.Emit(types.EngineEvent{
				Type:                "engine_dispatch_end",
				DispatchAgent:       opts.Name,
				DispatchExitCode:    exitCode,
				DispatchElapsed:     elapsed,
				DispatchCost:        totalCost,
				DispatchInputTokens: totalInputTokens,
				DispatchOutputTokens: totalOutputTokens,
				DispatchToolCount:   toolCount,
			})

			utils.Log("Dispatch", fmt.Sprintf(
				"dispatch complete agent=%q exitCode=%d elapsed=%.2fs cost=%.6f tools=%d session=%s",
				opts.Name, exitCode, elapsed, totalCost, toolCount, key,
			))

			return result
		}

		if opts.Background {
			// Register in the dispatch registry for recall support.
			if registry != nil {
				registry.Register(opts.Name, func() {
					recallReason = "recall_agent"
					cancelFn()
				}, child, key)
			}

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
						recoverBackgroundDispatchPanic(
							sa, registry, opts, key, agentID, agentName, r,
						)
					}
				}()
				result := runChild()

				// Fire the appropriate callback.
				if recalled {
					if opts.OnRecall != nil {
						opts.OnRecall(extension.RecallInfo{
							Reason:    recallReason,
							Elapsed:   result.Elapsed,
							ToolCount: toolCount,
						})
					}
				} else if childErr != nil || result.ExitCode != 0 {
					if opts.OnError != nil {
						opts.OnError(extension.DispatchError{
							Message:  result.Output,
							ExitCode: result.ExitCode,
							Elapsed:  result.Elapsed,
						})
					}
				} else {
					if opts.OnComplete != nil {
						opts.OnComplete(*result)
					}
				}
			}()

			utils.Log("Dispatch", fmt.Sprintf(
				"background dispatch started agent=%q session=%s", opts.Name, key,
			))

			// Return a stub result immediately.
			return &extension.DispatchAgentResult{
				SessionID: childReqID,
			}, nil
		}

		// Foreground (synchronous) dispatch.
		defer cancelFn() // clean up the context
		result := runChild()

		if childErr != nil {
			return result, childErr
		}
		return result, nil
	}
}

// loadChildExtension loads the child extension if specified in opts. Returns
// the Host (nil if no extension or load failed). Modifies opts.SystemPrompt
// in-place if the extension provides additional system prompt content.
func loadChildExtension(sa SessionAccessor, opts *extension.DispatchAgentOpts, model, projectPath string) *extension.Host {
	if opts.ExtensionDir == "" {
		return nil
	}

	childExtHost := extension.NewHost()
	if cfg := sa.EngineConfig(); cfg != nil && cfg.Timeouts != nil {
		childExtHost.SetRPCTimeout(cfg.Timeouts.ExtensionRpc())
	}
	extCfg := &extension.ExtensionConfig{
		ExtensionDir:     opts.ExtensionDir,
		Model:            model,
		WorkingDirectory: projectPath,
	}
	if err := childExtHost.Load(opts.ExtensionDir, extCfg); err != nil {
		utils.Log("Session", "child extension load failed: "+err.Error())
		return nil
	}

	// Fire session_start on child extension.
	childCtx := NewExtContext(sa)
	_ = childExtHost.FireSessionStart(childCtx)

	// Wire before_agent_start for system prompt.
	basCtx := NewExtContext(sa)
	extSysPrompt, _, _ := childExtHost.FireBeforeAgentStart(basCtx, extension.AgentInfo{
		Name: opts.Name,
		Task: opts.Task,
	})
	if extSysPrompt != "" {
		if opts.SystemPrompt != "" {
			opts.SystemPrompt = opts.SystemPrompt + "\n\n" + extSysPrompt
		} else {
			opts.SystemPrompt = extSysPrompt
		}
	}

	return childExtHost
}

// startChild dispatches the child run on the appropriate backend. This
// centralizes the type-switch logic for ApiBackend/HybridBackend/generic.
func startChild(child backend.RunBackend, reqID string, runOpts types.RunOptions, cfg *backend.RunConfig) {
	switch c := child.(type) {
	case *backend.ApiBackend:
		if cfg != nil {
			c.StartRunWithConfig(reqID, runOpts, cfg)
		} else {
			c.StartRun(reqID, runOpts)
		}
	case *backend.HybridBackend:
		if cfg != nil {
			c.StartRunWithConfig(reqID, runOpts, cfg)
		} else {
			c.StartRun(reqID, runOpts)
		}
	default:
		child.StartRun(reqID, runOpts)
	}
}

// fireLifecycleCallbacks processes a NormalizedEvent and fires the
// appropriate Phase 2 structured lifecycle callbacks on the opts. Mutates
// the tracking state (toolNames, toolCount, accumulatedText, cumulative
// counters) as a side effect.
func fireLifecycleCallbacks(
	opts *extension.DispatchAgentOpts,
	ev types.NormalizedEvent,
	agentID string,
	toolNames map[string]string,
	toolCount *int,
	accumulatedText *string,
	cumulativeInputTokens, cumulativeOutputTokens *int,
	cumulativeCost *float64,
) {
	switch e := ev.Data.(type) {
	case *types.ToolCallEvent:
		*toolCount++
		toolNames[e.ToolID] = e.ToolName
		if opts.OnToolStart != nil {
			opts.OnToolStart(extension.DispatchToolStartInfo{
				ToolName: e.ToolName,
				ToolID:   e.ToolID,
			})
		}

	case *types.ToolResultEvent:
		name := toolNames[e.ToolID]
		delete(toolNames, e.ToolID)
		if e.IsError {
			if opts.OnToolError != nil {
				opts.OnToolError(extension.DispatchToolErrorInfo{
					ToolName: name,
					ToolID:   e.ToolID,
					Content:  e.Content,
				})
			}
		} else {
			if opts.OnToolEnd != nil {
				opts.OnToolEnd(extension.DispatchToolEndInfo{
					ToolName: name,
					ToolID:   e.ToolID,
					Content:  e.Content,
				})
			}
		}

	case *types.UsageEvent:
		turnInput := 0
		turnOutput := 0
		if e.Usage.InputTokens != nil {
			turnInput = *e.Usage.InputTokens
		}
		if e.Usage.OutputTokens != nil {
			turnOutput = *e.Usage.OutputTokens
		}
		*cumulativeInputTokens += turnInput
		*cumulativeOutputTokens += turnOutput
		// Cost is not carried on UsageEvent, so cumulative cost tracks from
		// TaskCompleteEvent only. For per-turn reporting we pass what we have.
		if opts.OnUsage != nil {
			opts.OnUsage(extension.DispatchUsageInfo{
				InputTokens:           turnInput,
				OutputTokens:          turnOutput,
				CumulativeInputTokens: *cumulativeInputTokens,
				CumulativeOutputTokens: *cumulativeOutputTokens,
				CumulativeCost:        *cumulativeCost,
			})
		}

	case *types.TextChunkEvent:
		*accumulatedText += e.Text
		if opts.OnTextDelta != nil {
			opts.OnTextDelta(extension.DispatchTextDeltaInfo{
				Delta:       e.Text,
				Accumulated: *accumulatedText,
			})
		}

	case *types.TaskCompleteEvent:
		// Update cumulative cost from the authoritative source.
		*cumulativeCost = e.CostUsd

	case *types.PlanProposalEvent:
		if opts.OnPlanProposal != nil {
			info := extension.DispatchPlanProposalInfo{
				Name:          opts.Name,
				AgentID:       agentID,
				PlanFilePath:  e.PlanFilePath,
				PlanSlug:      e.PlanSlug,
				PlanRequested: opts.PlanMode,
			}
			opts.OnPlanProposal(info)
			utils.Log("Dispatch", fmt.Sprintf(
				"plan proposal callback fired agent=%q planSlug=%q requested=%v",
				opts.Name, e.PlanSlug, opts.PlanMode,
			))
		}
	}
}

// truncate shortens s to at most maxLen characters, appending "…" if truncated.
func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "…"
}
