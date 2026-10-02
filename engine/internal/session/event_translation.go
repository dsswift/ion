package session

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/cost"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// handleNormalizedEvent translates a NormalizedEvent into an EngineEvent
// and forwards it through the Manager's event callback.
func (m *Manager) handleNormalizedEvent(runID string, event types.NormalizedEvent) {
	key := m.keyForRun(runID)
	if key == "" {
		// No session resolves for this runID — the event cannot be routed and
		// is dropped. This is expected only AFTER a run's terminal point (the
		// binding is cleared in handleRunExit). A drop for a runID that is still
		// live is a routing defect: log it with the event type so a silent loss
		// is reconstructable from engine.log (this path was previously a silent
		// return — the blind spot that hid the dropped PlanModeChangedEvent).
		utils.LogWithFields(utils.LevelWarn, "session", "normalized event dropped: no session for run (post-exit is expected; mid-run indicates a routing defect)", map[string]any{"run_id": runID, "event_type": event.Type(), "data": event.Data})
		return
	}

	// The type only: every event passes here, and a body (a whole text chunk
	// or tool result) per line rotated engine.jsonl down to hours. TRACE
	// carries the body for a deep dive.
	utils.LogWithFields(utils.LevelDebug, "session", "normalized event", map[string]any{"key": key, "run_id": runID, "event_type": event.Type()})
	utils.TraceWithFields("session", "normalized event body", map[string]any{"key": key, "run_id": runID, "event_type": event.Type(), "data": event.Data})

	// conversation.* telemetry (issue #378, child 04): root-path counterpart
	// of the dispatched-child wiring (child 05). Unconditional — never gated
	// on s.extGroup, unlike the G34 tool-hook switch below — so a
	// conversation.* event fires for every root-owned Conversation regardless
	// of whether an extension is attached. See conversation_events.go.
	m.emitConversationEvents(key, runID, event)

	// Look up session once for all downstream hook firing.
	m.mu.RLock()
	s, sOk := m.sessions[key]
	m.mu.RUnlock()

	// Fire CLI backend turn lifecycle hooks BEFORE the translate/drop gate.
	// TaskUpdateEvent (assistant message complete) has no client-facing
	// EngineEvent translation and would be dropped by the ee.Type == ""
	// check below, but it is the signal for turn_end.
	m.fireCliTurnHooks(s, key, sOk, event)

	// Feed the delegated-run structured transcript recorder (nil-safe: only
	// native-session runs create one at dispatch). Before the translate/drop
	// gate for the same reason as the turn hooks — several of its inputs
	// (ToolCallUpdateEvent, ToolCallCompleteEvent) have no EngineEvent
	// translation.
	if sOk {
		m.mu.RLock()
		rec := s.cliTranscript
		m.mu.RUnlock()
		rec.record(event)
	}

	// A terminal ErrorEvent on a delegated-CLI run (the normalizer's
	// translation of the CLI's is_error result — e.g. "Autocompact is
	// thrashing…" before the process exits non-zero) marks this run's native
	// session as unresumable. handleRunExit consumes the flag: it skips the
	// cursor capture and invalidates the existing cursor for the kind, so the
	// next prompt bridges from Ion's transcript instead of resuming the same
	// saturated native session. pendingCliUserTurn is the "this run is
	// CLI-served" discriminator (set at dispatch for native-session backends
	// only).
	if _, isErr := event.Data.(*types.ErrorEvent); isErr {
		m.mu.Lock()
		if s2, ok2 := m.sessions[key]; ok2 && s2.pendingCliUserTurn != "" {
			s2.cliRunFailedTerminal = true
			utils.LogWithFields(utils.LevelWarn, "session", "terminal error on delegated-cli run; native cursor will be invalidated at exit", map[string]any{
				"key": key, "kind": s2.runCaps.Kind,
			})
		}
		m.mu.Unlock()
	}

	// Capture the conversation/session ID as early as possible. The API
	// backend emits a SessionInitEvent right after loadOrCreateConversation
	// so the session manager learns the ID before any tool call or dispatch
	// completes. Without this, s.conversationID is empty during the first
	// run, which causes dispatch persistence (appendConversationEntry) to
	// silently skip writing agent_dispatch entries.
	if init, ok := event.Data.(*types.SessionInitEvent); ok && init.SessionID != "" {
		m.mu.Lock()
		if s2, ok2 := m.sessions[key]; ok2 && s2.conversationID == "" {
			s2.conversationID = init.SessionID
			utils.LogWithFields(utils.LevelInfo, "session", "captured from sessioninitevent", map[string]any{"run_id": init.SessionID, "key": key})

			// If the root context lacks conversation_id (first-run path where
			// StartSession pre-minted a fresh ID before any conversation was
			// confirmed), re-arm the root so subsequent runLoop goroutines pick
			// up the confirmed ID via their ambient context. newSessionRootContext
			// re-threads all correlation IDs (including the just-set
			// conversationID) from a fresh Background root. We hold the manager
			// lock here (required for rootCtx mutation) and the new-run busy-guard
			// upstream guarantees no other run is dispatching, so the swap is safe.
			if s2.rootCtx != nil && utils.ConversationIDFromContext(s2.rootCtx) == "" {
				s2.newSessionRootContext()
			}

			// Initialize session memory for the newly created conversation.
			// On resumed sessions this is already done in StartSession; here
			// we cover the fresh-conversation path where the backend assigns
			// the conversation ID during the first run.
			memoryDisabled := m.config != nil && m.config.Compaction != nil &&
				m.config.Compaction.MemoryEnabled != nil && !*m.config.Compaction.MemoryEnabled
			if s2.sessionMemory == nil && !memoryDisabled {
				convDir := conversation.DefaultConversationsDir()
				sm := NewSessionMemory(init.SessionID, convDir, nil)
				sm.Start()
				s2.sessionMemory = sm
				utils.LogWithFields(utils.LevelInfo, "session", "created session memory for new", map[string]any{"run_id": init.SessionID, "key": key})
			}
		}
		m.mu.Unlock()
	}

	contextWindow := conversation.DefaultContext
	m.mu.RLock()
	if s, sOk2 := m.sessions[key]; sOk2 && s.lastContextWindow > 0 {
		contextWindow = s.lastContextWindow
	}
	m.mu.RUnlock()

	m.applyTemporaryAutoPlanCompletion(runID, key, event)

	ee := translateToEngineEvent(event, contextWindow)
	if ee.Type == "" {
		utils.LogWithFields(utils.LevelDebug, "session", "dropping unhandled normalized event type", map[string]any{"event_type": event.Type(), "data": event.Data})
		return
	}

	// The task_complete → engine_status translation stamps the
	// backend-reported sessionID (claude's UUID for the CLI backend) onto
	// Fields.SessionID. Substitute Ion's stable conversationID so the
	// client-facing session id is consistent with every other surface
	// (handleRunExit idle status, buildSessionStatusMirror, ListSessions)
	// and never leaks a claude UUID that has no Ion conversation file. For
	// the API backend the two values are equal, so this is a no-op there.
	// translateToEngineEvent is a pure function with no session access, so
	// the substitution must happen here where the manager holds the session.
	if ee.Type == "engine_status" && ee.Fields != nil {
		m.mu.RLock()
		if s2, ok2 := m.sessions[key]; ok2 && s2.conversationID != "" {
			if ee.Fields.SessionID != s2.conversationID {
				utils.LogWithFields(utils.LevelDebug, "session", "task_complete status: substituting ion for backend", map[string]any{"conversation_id": s2.conversationID, "session_id": ee.Fields.SessionID, "key": key})
			}
			ee.Fields.SessionID = s2.conversationID
		}
		m.mu.RUnlock()
		// A TaskCompleteEvent is a run-loop boundary, not proof that the
		// session is terminal. Rebuild its status from the live session inventory
		// so child dispatches, notifying shells, queued prompts, and delivery
		// outboxes cannot be hidden behind its legacy idle shape.
		if _, isTaskComplete := event.Data.(*types.TaskCompleteEvent); isTaskComplete {
			if live, exists := m.buildStatusFields(key); exists {
				live.RunCostUsd = ee.Fields.RunCostUsd
				live.ConversationCostUsd = ee.Fields.ConversationCostUsd
				live.ContextPercent = ee.Fields.ContextPercent
				live.ContextWindow = ee.Fields.ContextWindow
				live.ContextTokens = ee.Fields.ContextTokens
				live.Model = ee.Fields.Model
				live.CompletionReason = ee.Fields.CompletionReason
				live.NumTurns = ee.Fields.NumTurns
				live.ConversationTurns = ee.Fields.ConversationTurns
				ee.Fields = live
			}
		}
	}

	m.emit(key, ee)

	// Closes a pending manual-compact indicator on the CLI's own
	// compact_boundary frame — see manual_compact_indicator.go.
	m.closeManualCompactStdinOnNativeCompaction(key, event)

	// Record a turn-boundary park. TaskSuspendEvent carrying task IDs means
	// the run ended because this session still has background commands
	// running; the session must remember that so a completion can revive it.
	// Done here rather than in the pure translateToEngineEvent because it
	// needs the manager. Dispatch-driven suspends (AwaitingDispatchIDs) are
	// not parks in this sense — a live runChild goroutine owns their revival.
	if ts, ok := event.Data.(*types.TaskSuspendEvent); ok && len(ts.AwaitingTaskIDs) > 0 {
		m.markSessionParked(key, ts.AwaitingTaskIDs)
	}

	// Plan-mode side effects (reentry tracking, planFilePath sync, and the
	// delegated-CLI plan marker). Split into event_translation_plan_mode.go.
	m.applyPlanModeSideEffects(key, event)

	// Retain this run's provider accounting when it is delegated-CLI served,
	// so run exit can persist it onto the turn it copies into Ion's
	// transcript. See cli_turn_usage.go.
	m.captureCliTurnUsage(key, event)

	// Track last-known context usage on the session so subsequent
	// engine_status emissions carry the latest values.
	//
	// This is the OCCUPANCY path and the only per-turn writer of the
	// retained context state. ee.EndUsage here originates from a
	// *types.UsageEvent, whose InputTokens the backend already summed as
	// input + cache_read + cache_creation — i.e. what the model actually
	// carried. The guard is on InputTokens (do we have data?) rather than
	// on ContextPercent > 0: guarding on the percent discards a legitimate
	// post-compaction drop and lets a stale high value stick.
	if ee.EndUsage != nil && ee.EndUsage.InputTokens > 0 {
		m.mu.Lock()
		if s, ok2 := m.sessions[key]; ok2 {
			s.lastContextPct = ee.EndUsage.ContextPercent
			s.lastContextTokens = ee.EndUsage.InputTokens
			updateContextCapacityLocked(s, s.lastModel, s.lastContextWindow, s.config.MaxTokens)
		}
		m.mu.Unlock()
	}

	// G34: Fire tool_start/tool_end extension hooks and track tool inputs
	// for Agent tool_call dispatch.
	if sOk && s.extGroup != nil && !s.extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		switch e := event.Data.(type) {
		case *types.ToolCallEvent:
			s.extGroup.FireToolStart(ctx, extension.ToolStartInfo{ //nolint:errcheck // errors logged internally by fireVoid/s.fire
				ToolName: e.ToolName,
				ToolID:   e.ToolID,
			})
			// Track tool metadata for Agent tool_call hook
			m.mu.Lock()
			if s.cliToolMeta == nil {
				s.cliToolMeta = make(map[string]toolMeta)
				s.cliToolInputs = make(map[string]string)
				s.cliToolIndexID = make(map[int]string)
			}
			s.cliToolMeta[e.ToolID] = toolMeta{name: e.ToolName, index: e.Index}
			s.cliToolIndexID[e.Index] = e.ToolID
			s.cliLastToolID = e.ToolID
			m.mu.Unlock()

		case *types.ToolCallUpdateEvent:
			// Accumulate partial input for tool_call hook.
			// ToolCallUpdateEvent.ToolID is always "" from the normalizer because
			// content_block_delta events don't carry a toolID. Fall back to the
			// last-started tool so the input accumulates under the right key.
			m.mu.Lock()
			if s.cliToolInputs != nil {
				key := e.ToolID
				if key == "" {
					key = s.cliLastToolID
				}
				s.cliToolInputs[key] += e.PartialInput
			}
			m.mu.Unlock()

		case *types.ToolCallCompleteEvent:
			// Fire tool_call hook for Agent tool calls so extensions can see
			// which sub-agent is being dispatched.
			m.mu.Lock()
			toolID := s.cliToolIndexID[e.Index]
			meta := s.cliToolMeta[toolID]
			accumulated := s.cliToolInputs[toolID]
			delete(s.cliToolInputs, toolID)
			delete(s.cliToolMeta, toolID)
			delete(s.cliToolIndexID, e.Index)
			m.mu.Unlock()

			if meta.name == "Agent" && accumulated != "" {
				var input map[string]interface{}
				if json.Unmarshal([]byte(accumulated), &input) == nil {
					s.extGroup.FireToolCall(ctx, extension.ToolCallInfo{ //nolint:errcheck // errors logged internally by fireVoid/s.fire
						ToolName: "Agent",
						ToolID:   toolID,
						Input:    input,
					})
				}
			}

		case *types.ToolResultEvent:
			_ = e                       // suppress unused
			s.extGroup.FireToolEnd(ctx) //nolint:errcheck // errors logged internally by fireVoid/s.fire
		}
	}

	// Fire on_error extension hook
	if sOk && s.extGroup != nil && !s.extGroup.IsEmpty() {
		if errEv, ok := event.Data.(*types.ErrorEvent); ok {
			errCtx := m.newExtContext(s, key)
			s.extGroup.FireOnError(errCtx, extension.ErrorInfo{ //nolint:errcheck // errors logged internally by fireVoid/s.fire
				Message:       errEv.ErrorMessage,
				ErrorCode:     errEv.ErrorCode,
				Category:      classifyErrorCategory(errEv.ErrorCode),
				Retryable:     errEv.Retryable,
				RetryAfterMs:  errEv.RetryAfterMs,
				HttpStatus:    errEv.HttpStatus,
				PolicyFailure: errEv.PolicyFailure,
			})
		}
	}

	// TaskComplete also emits engine_message_end with usage
	if tc, ok := event.Data.(*types.TaskCompleteEvent); ok {
		// NOTE: tc.Usage is CUMULATIVE RUN BILLING (backend.cumulativeUsage
		// sums every turn's tokens), NOT context-window occupancy. It must
		// never write the retained context state — doing so is what made a
		// 227k-token conversation report 0% at idle, because a run whose
		// turns were almost entirely cache reads sums to a tiny cumulative
		// figure. Occupancy is written by the UsageEvent path above and
		// recomputed from disk by refreshContextUsage on run exit.
		//
		// retainedPct carries the session's occupancy percent onto this
		// event so the cost-bearing run-complete message_end still reports a
		// truthful context figure alongside its cumulative token counts.
		var retainedPct int
		m.mu.Lock()
		if s2, ok2 := m.sessions[key]; ok2 {
			if tc.CostUsd > 0 {
				s2.lastTotalCost = tc.CostUsd
			}
			s2.lastCompletionReason = tc.Reason
			retainedPct = s2.lastContextPct
			// Capture the final assistant text for delegated-CLI turn
			// persistence (see persistCliTurn in native_session.go). LastText
			// carries the last substantive text even when the final turn was
			// pure reasoning; fall back to Result. Only meaningful when a
			// native-session backend served this run (pendingCliUserTurn set).
			if s2.pendingCliUserTurn != "" {
				if tc.LastText != "" {
					s2.pendingCliAssistantText = tc.LastText
				} else {
					s2.pendingCliAssistantText = tc.Result
				}
				// Capture what the CLI reported for this run so persistCliTurn
				// can write it into the conversation header. The engine cannot
				// recompute these: the CLI values the run at its own rates, and
				// the per-turn accounting never reaches this process. Cumulative
				// figures, so assignment (not accumulation) is correct. See
				// pendingCliRunCostUsd in types.go for what CostUsd does and
				// does not mean.
				s2.pendingCliRunCostUsd = tc.CostUsd
				s2.pendingCliRunUsage = types.LlmUsage{
					InputTokens:              derefInt(tc.Usage.InputTokens),
					OutputTokens:             derefInt(tc.Usage.OutputTokens),
					CacheReadInputTokens:     derefInt(tc.Usage.CacheReadInputTokens),
					CacheCreationInputTokens: derefInt(tc.Usage.CacheCreationInputTokens),
				}
			}
			// Capture pending denials so ReconcileState can re-emit them
			// on the engine_status snapshot a re-attaching consumer
			// requests. Cleared on next prompt dispatch (see
			// prompt_dispatch.go). The full PermissionDenials slice
			// from the task_complete payload is retained verbatim;
			// consumer-side filtering or interpretation is out of
			// scope for the engine.
			//
			// Snapshot semantics: this assignment REPLACES whatever was
			// previously retained. The most recent task_complete is the
			// authoritative truth about what (if anything) is still blocked.
			// An empty PermissionDenials slice correctly clears the
			// retained state — a task that completed cleanly has no
			// outstanding denials to re-emit.
			s2.lastPermissionDenials = tc.PermissionDenials
			utils.LogWithFields(utils.LevelInfo, "session", "task_complete: retained permission_denials for reconcile", map[string]any{"key": key, "count": len(tc.PermissionDenials)})

			// Compute conversation-level cost once, under the lock, for both
			// consumers: the cached ConversationCostUsd that heartbeats,
			// host_death, and ReconcileState emit, and the aggregate_cost_usd
			// on run.complete telemetry below. Both want the same quantity —
			// this session plus every live descendant dispatch — so one disk
			// walk answers both and they cannot drift apart.
			convID := s2.conversationID
			var liveIDs []string
			if s2.dispatchRegistry != nil {
				liveIDs = s2.dispatchRegistry.LiveConvIDs()
			}
			convCost, _ := cost.ConversationCost(convID, liveIDs, "") //nolint:errcheck // ConversationCost logs internally, returns 0 on error

			// ConversationCost reads the header from disk, so what it returns
			// depends on whether this run's cost has been written yet — and
			// that differs by backend. An engine-owned run saved its per-turn
			// cost inside the runloop (runloop.go, UpdateCost then Save each
			// turn), so the walk above already counts it. A delegated-CLI run
			// has nothing on disk until persistCliTurn writes it at run exit,
			// which is after this event. Adding the CLI's reported total here
			// is exact, not an estimate: it is the same figure persistCliTurn
			// is about to save. Without it both figures below would silently
			// mean "including this run" for one backend and "excluding this
			// run" for the other.
			if s2.pendingCliUserTurn != "" {
				convCost += tc.CostUsd
			}
			s2.lastConvCost = convCost

			// Emit a run-level telemetry event. This is the one place every
			// backend's TaskCompleteEvent converges, so a single guarded
			// emission here gives uniform run-level coverage across all
			// backends. The per-call families (llm.call, tool.execute, ...)
			// come from each backend itself; for a delegated CLI that is
			// backend/delegated_telemetry.go. Additive only:
			// guarded on a non-nil collector, and the collector itself is a
			// no-op when telemetry is disabled. The model comes from
			// s2.lastModel (set in prompt_dispatch when the run started); the
			// cost/duration/turn/usage fields come straight from the event.
			if s2.telemetry != nil {
				// This session + all descendant dispatches, computed above.
				// The same value the cached ConversationCostUsd carries, and
				// the same walk ComputeAndEmitContextBreakdown uses.
				aggregateCost := convCost

				// dispatchDepth is 0 for all sessions that emit run.complete through
				// handleNormalizedEvent. Dispatched child agents run their backends
				// inline via child.OnNormalized and never reach this manager-level
				// event handler, so the manager-level emission is always depth 0.
				const dispatchDepth = 0

				payload := map[string]any{
					"model":                       s2.lastModel,
					"run_cost_usd":                tc.CostUsd,
					"aggregate_cost_usd":          aggregateCost,
					"dispatch_depth":              dispatchDepth,
					"duration_ms":                 tc.DurationMs,
					"num_turns":                   tc.NumTurns,
					"input_tokens":                derefInt(tc.Usage.InputTokens),
					"output_tokens":               derefInt(tc.Usage.OutputTokens),
					"cache_read_input_tokens":     derefInt(tc.Usage.CacheReadInputTokens),
					"cache_creation_input_tokens": derefInt(tc.Usage.CacheCreationInputTokens),
				}
				s2.telemetry.Event(telemetry.RunComplete, payload, stampPrincipalIdentity(withRunCorrelation(
					correlationCtxExt(key, s2.conversationID, s2.extensionName, s2.extensionVersion),
					s2.requestID, s2.runTraceID), s2))
				utils.LogWithFields(utils.LevelInfo, "session", "run.complete telemetry emitted", map[string]any{"key": key, "model": s2.lastModel, "cost_usd": tc.CostUsd, "aggregate_cost": aggregateCost, "turn": tc.NumTurns})

				// Context-economy telemetry (family 4c): emit a cache.savings
				// data point when the run used prompt caching, so consumers can
				// track the dollar savings from cache reads. Computed from the
				// model's input pricing and the cache-read token count. Nil-safe
				// via the guarded collector above.
				emitCacheSavings(s2.telemetry, s2.lastModel, tc.Usage, key, s2.conversationID, s2.extensionName, s2.extensionVersion, s2.requestID, s2.runTraceID, s2.principal.AttributionForTelemetry())
			}
		}
		m.mu.Unlock()
		m.emit(key, types.EngineEvent{
			Type: "engine_message_end",
			EndUsage: &types.MessageEndUsage{
				// InputTokens/OutputTokens are cumulative run billing; the
				// percent is the session's retained context occupancy. The
				// two are deliberately different quantities on this event —
				// see the NOTE above.
				InputTokens:    derefInt(tc.Usage.InputTokens),
				OutputTokens:   derefInt(tc.Usage.OutputTokens),
				ContextPercent: retainedPct,
				Cost:           tc.CostUsd,
			},
		})
	}
}
