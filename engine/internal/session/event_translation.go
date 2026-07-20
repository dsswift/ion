package session

import (
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/backend"
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
		utils.LogWithFields(utils.LevelWarn, "session", "normalized event dropped: no key for type=%t (post-exit is expected; mid-run indicates a routing defect)", map[string]any{"run_id": runID, "data": event.Data})
		return
	}

	utils.LogWithFields(utils.LevelDebug, "session", "normalized event: type=%t", map[string]any{"key": key, "run_id": runID, "data": event.Data})

	// Look up session once for all downstream hook firing.
	m.mu.RLock()
	s, sOk := m.sessions[key]
	m.mu.RUnlock()

	// Fire CLI backend turn lifecycle hooks BEFORE the translate/drop gate.
	// TaskUpdateEvent (assistant message complete) has no client-facing
	// EngineEvent translation and would be dropped by the ee.Type == ""
	// check below, but it is the signal for turn_end.
	m.fireCliTurnHooks(s, key, sOk, event)

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

	ee := translateToEngineEvent(event, contextWindow)
	if ee.Type == "" {
		utils.LogWithFields(utils.LevelDebug, "session", "dropping unhandled normalized event type: %t", map[string]any{"data": event.Data})
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
				utils.LogWithFields(utils.LevelDebug, "session", "task_complete status: substituting ion for backend", map[string]any{"run_id": s2.conversationID, "run_id_1": ee.Fields.SessionID, "key": key})
			}
			ee.Fields.SessionID = s2.conversationID
		}
		m.mu.RUnlock()
	}

	m.emit(key, ee)

	// Track plan mode changes so re-entering plan mode triggers reentry
	// detection in SendPrompt. We do this here (rather than in the pure
	// translateToEngineEvent) because we need access to the session manager.
	if pmc, ok := event.Data.(*types.PlanModeChangedEvent); ok {
		if !pmc.Enabled {
			// Model called ExitPlanMode: record the exit so that if the
			// session is later re-entered into plan mode, the reentry
			// prompt fires.
			m.MarkPlanModeExited(key)
		} else if pmc.PlanFilePath != "" {
			// Model called EnterPlanMode: keep the manager's session state in
			// sync with the run's state so the next SendPrompt sees the correct
			// planFilePath and planMode flag. Without this the manager's view
			// diverges from the backend run's view across run boundaries.
			m.mu.Lock()
			if s2, ok2 := m.sessions[key]; ok2 {
				s2.planMode = true
				s2.planFilePath = pmc.PlanFilePath
				utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "event_translation: model entered plan mode", map[string]any{"key": key, "plan_file_path": pmc.PlanFilePath})
			}
			m.mu.Unlock()
		}
	}

	// Per ADR-003, the model calling ExitPlanMode surfaces as a
	// PlanProposalEvent{Kind:"exit"} (a workflow proposal), NOT a
	// PlanModeChangedEvent{Enabled:false} (a confirmed state change). The
	// CLI backend emits this on the model's ExitPlanMode tool call, and the
	// API backend emits it from interceptExitPlanMode. Record the exit so
	// reentry detection fires when plan mode is re-enabled — mirroring the
	// PlanModeChangedEvent{Enabled:false} branch above. Idempotent with the
	// SetPlanMode(false) user-approval chokepoint path (both set
	// hasExitedPlanMode=true).
	if pp, ok := event.Data.(*types.PlanProposalEvent); ok && pp.Kind == "exit" {
		m.MarkPlanModeExited(key)
	}

	// Track last-known context usage on the session so subsequent
	// engine_status emissions carry the latest values.
	if ee.EndUsage != nil && ee.EndUsage.ContextPercent > 0 {
		m.mu.Lock()
		if s, ok2 := m.sessions[key]; ok2 {
			s.lastContextPct = ee.EndUsage.ContextPercent
		}
		m.mu.Unlock()
	}

	// G34: Fire tool_start/tool_end extension hooks and track tool inputs
	// for Agent tool_call dispatch.
	if sOk && s.extGroup != nil && !s.extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		switch e := event.Data.(type) {
		case *types.ToolCallEvent:
			_ = s.extGroup.FireToolStart(ctx, extension.ToolStartInfo{
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
					_, _ = s.extGroup.FireToolCall(ctx, extension.ToolCallInfo{
						ToolName: "Agent",
						ToolID:   toolID,
						Input:    input,
					})
				}
			}

		case *types.ToolResultEvent:
			_ = e // suppress unused
			_ = s.extGroup.FireToolEnd(ctx)
		}
	}

	// Fire on_error extension hook
	if sOk && s.extGroup != nil && !s.extGroup.IsEmpty() {
		if errEv, ok := event.Data.(*types.ErrorEvent); ok {
			errCtx := m.newExtContext(s, key)
			_ = s.extGroup.FireOnError(errCtx, extension.ErrorInfo{
				Message:      errEv.ErrorMessage,
				ErrorCode:    errEv.ErrorCode,
				Category:     classifyErrorCategory(errEv.ErrorCode),
				Retryable:    errEv.Retryable,
				RetryAfterMs: errEv.RetryAfterMs,
				HttpStatus:   errEv.HttpStatus,
			})
		}
	}

	// TaskComplete also emits engine_message_end with usage
	if tc, ok := event.Data.(*types.TaskCompleteEvent); ok {
		var pct int
		if tc.Usage.InputTokens != nil {
			pct = *tc.Usage.InputTokens * 100 / contextWindow
			if pct > 100 {
				pct = 100
			}
		}
		m.mu.Lock()
		if s2, ok2 := m.sessions[key]; ok2 {
			if pct > 0 {
				s2.lastContextPct = pct
			}
			if tc.CostUsd > 0 {
				s2.lastTotalCost = tc.CostUsd
			}
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

			// Compute and cache conversation-level cost so heartbeats,
			// host_death, and ReconcileState can emit ConversationCostUsd
			// without a second disk walk. Computed here under the lock
			// alongside the aggregate already computed for run.complete
			// telemetry above.
			convID := s2.conversationID
			var liveIDs []string
			if s2.dispatchRegistry != nil {
				liveIDs = s2.dispatchRegistry.LiveConvIDs()
			}
			convCost, _ := cost.ConversationCost(convID, liveIDs, "")
			s2.lastConvCost = convCost

			// Emit a run-level telemetry event. This is the one place every
			// backend's TaskCompleteEvent converges, so a single guarded
			// emission here gives uniform run-level coverage across all
			// backends — including ClaudeCodeBackend, which emits no per-call
			// telemetry spans of its own (ApiBackend keeps its finer-grained
			// llm.call / tool.execute spans regardless). Additive only:
			// guarded on a non-nil collector, and the collector itself is a
			// no-op when telemetry is disabled. The model comes from
			// s2.lastModel (set in prompt_dispatch when the run started); the
			// cost/duration/turn/usage fields come straight from the event.
			if s2.telemetry != nil {
				// Compute aggregate cost: this session + all descendant dispatches.
				// Uses the same cost.ConversationCost walk as ComputeAndEmitContextBreakdown.
				// liveChildConvIDs is called outside the lock below; capture what we need here.
				convID := s2.conversationID
				var liveIDs []string
				if s2.dispatchRegistry != nil {
					liveIDs = s2.dispatchRegistry.LiveConvIDs()
				}
				// Release the lock before the disk-IO walk, then re-acquire to emit.
				// We hold it for the entire TaskComplete block anyway (the surrounding
				// m.mu.Lock is still held at this point), so we compute inline —
				// cost.ConversationCost is a best-effort disk walk that handles errors
				// by returning 0 + a debug log, never panics, and is the same path
				// already used by ComputeAndEmitContextBreakdown under the same lock.
				aggregateCost, _ := cost.ConversationCost(convID, liveIDs, "")

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
				s2.telemetry.Event(telemetry.RunComplete, payload, correlationCtxExt(key, s2.conversationID, s2.extensionName, s2.extensionVersion))
				utils.LogWithFields(utils.LevelInfo, "session", "run.complete telemetry emitted", map[string]any{"key": key, "model": s2.lastModel, "cost_usd": tc.CostUsd, "aggregate_cost": aggregateCost, "turn": tc.NumTurns})

				// Context-economy telemetry (family 4c): emit a cache.savings
				// data point when the run used prompt caching, so consumers can
				// track the dollar savings from cache reads. Computed from the
				// model's input pricing and the cache-read token count. Nil-safe
				// via the guarded collector above.
				emitCacheSavings(s2.telemetry, s2.lastModel, tc.Usage, key, s2.conversationID, s2.extensionName, s2.extensionVersion)
			}
		}
		m.mu.Unlock()
		m.emit(key, types.EngineEvent{
			Type: "engine_message_end",
			EndUsage: &types.MessageEndUsage{
				InputTokens:    derefInt(tc.Usage.InputTokens),
				OutputTokens:   derefInt(tc.Usage.OutputTokens),
				ContextPercent: pct,
				Cost:           tc.CostUsd,
			},
		})
	}
}

// handleRunExit is called when a backend run exits.
func (m *Manager) handleRunExit(runID string, code *int, signal *string, sessionID string) {
	key := m.keyForRun(runID)
	if key == "" {
		return
	}

	codeStr, sigStr := "nil", "nil"
	if code != nil {
		codeStr = fmt.Sprintf("%d", *code)
	}
	if signal != nil {
		sigStr = *signal
	}
	utils.LogWithFields(utils.LevelInfo, "session", "handlerunexit", map[string]any{"key": key, "run_id": runID, "code_str": codeStr, "sig_str": sigStr, "run_id_4": sessionID})

	var nextPrompt *pendingPrompt
	var bgCount int
	var ionConvID string
	var captureCursorKind string
	m.mu.Lock()
	// Authoritative terminal point: clear the runID -> key routing binding
	// under the lock, unconditionally (even if the session was already torn
	// down) so the binding can never leak. After this, a late event for the
	// same runID correctly resolves to "" and is dropped.
	m.unbindRunLocked(runID)
	if s, ok := m.sessions[key]; ok {
		s.requestID = ""
		// Ion's durable conversation-file identity, captured under the lock
		// for use in persistTerminalDispatches below. This is NOT the
		// backend-reported sessionID (which is claude's UUID for the CLI
		// backend and has no Ion files).
		ionConvID = s.conversationID
		// Preserve completed agent states (done/error/cancelled) so their
		// conversation history survives for post-run inspection and tab
		// persistence. Also preserve running states that correspond to active
		// background dispatches — those agents are legitimately still running.
		// Only clear running states that are stale (no live dispatch backing them).
		//
		// Preservation keys on BOTH the live dispatch IDs and names. The ID set
		// covers engine-managed dispatch slots at every depth (the agent-state
		// store keys those slots by their unique dispatch ID, and a nested
		// depth-2+ dispatch's name collapses under name-only keying, so it would
		// be swept and its terminal UpdateStateByID would land nowhere — the
		// "agent stuck running" defect). The name set covers extension-roster
		// rows that carry no engine dispatch ID. bgCount is the count of live
		// dispatch instances (by ID), not distinct names.
		if s.dispatchRegistry != nil {
			activeIDs := s.dispatchRegistry.ActiveIDs()
			activeNames := s.dispatchRegistry.ActiveNames()
			bgCount = len(activeIDs)
			if len(activeIDs) > 0 || len(activeNames) > 0 {
				utils.LogWithFields(utils.LevelInfo, "session", "handlerunexit: preserving live dispatch(es) by", map[string]any{"bg_count": bgCount, "run_id": activeIDs, "model": activeNames})
				s.agents.ClearRunningStatesExceptIDsOrNames(activeIDs, activeNames)
			} else {
				s.agents.ClearRunningStates()
			}
		} else {
			s.agents.ClearRunningStates()
		}
		// Decide whether to capture the backend-reported sessionID as a
		// native-session cursor — the backend-native resume handle for the
		// next run on the same kind (claude UUID / codex thread / ACP
		// session). The capture itself runs below, outside the lock, AFTER
		// persistTerminalDispatches (which advances the leaf the cursor is
		// tagged with) — see captureNativeSessionCursor in native_session.go.
		// CRITICAL: the native id is never written into s.conversationID.
		// conversationID is Ion's durable conversation-file identity;
		// overwriting it with a backend-native id corrupts compaction,
		// export, /clear, tree navigation, and the client-facing session id
		// (all keyed on the Ion id).
		//
		// Guards:
		//   - sessionID != s.conversationID: the API backend reports
		//     sessionID == conversationID; feeding the Ion conversation id to
		//     `claude --resume` (or ThreadResume) after a backend switch is a
		//     resume id the CLI has never seen, which fails.
		//   - runCaps recorded a native-session, resume-capable backend for
		//     this run: only those hand back a resumable native id.
		if sessionID != "" && sessionID != s.conversationID &&
			s.runCaps.ContextModel == backend.ContextModelNativeSession && s.runCaps.Resume {
			captureCursorKind = s.runCaps.Kind
			utils.LogWithFields(utils.LevelInfo, "session", "handlerunexit: native session id reported, capturing cursor", map[string]any{"run_id": sessionID, "key": key, "kind": captureCursorKind, "run_id_2": s.conversationID})
		} else {
			utils.LogWithFields(utils.LevelInfo, "session", "handlerunexit: no native session id to capture", map[string]any{"key": key, "reported_session_id": sessionID, "kind": s.runCaps.Kind})
		}
		if len(s.promptQueue) > 0 {
			next := s.promptQueue[0]
			s.promptQueue = s.promptQueue[1:]
			nextPrompt = &next
		}
	}
	m.mu.Unlock()

	// Persist any terminal dispatch entries to the conversation file.
	// This runs AFTER the backend's final save (which fires before OnExit)
	// so the load-append-save cycle won't be overwritten by a subsequent
	// backend save. Only terminal states (done/error/cancelled) with
	// dispatch metadata (task, agent type) are persisted. Keyed on Ion's
	// conversationID (the file basename) — never the backend-reported
	// sessionID, which for the CLI backend is claude's UUID with no Ion file.
	m.persistTerminalDispatches(key, ionConvID)

	// Persist this delegated-CLI turn (user prompt + assistant text) into Ion's
	// conversation store so Ion's transcript — the single source of truth —
	// actually contains CLI-served turns. Runs BEFORE flushPendingBinding so a
	// first-CLI-turn conversation has a backing file when the binding flush
	// checks conversation.Exists, and BEFORE the cursor capture so the cursor
	// is tagged at the post-turn leaf. No-op for engine-owned runs
	// (pendingCliUserTurn empty) and for runs with no conversation id.
	m.persistCliTurn(key, ionConvID)

	// Flush a deferred key->conversationId binding now that a run has exited
	// and the backend's final save has landed. A freshly pre-minted session
	// deferred its binding at StartSession (bindingPending) to avoid leaving a
	// phantom binding for a session that never saved. We only write the binding
	// if the conversation file actually exists — a run that exited without ever
	// producing a turn (no save) leaves bindingPending set and writes nothing,
	// so the next restart won't try to resume an empty id. (#230/#231)
	m.flushPendingBinding(key, ionConvID)

	// Capture the native-session cursor AFTER persistTerminalDispatches AND
	// persistCliTurn — both advance the conversation's leaf, and the cursor
	// must be tagged with the leaf as it stands at the end of all run-exit
	// writes or the very next same-provider turn would see a moved leaf and
	// re-bridge for nothing. Persists into the .tree.jsonl header (restart
	// resilience) and mirrors onto s.nativeSessions (see native_session.go).
	if captureCursorKind != "" {
		m.captureNativeSessionCursor(key, ionConvID, captureCursorKind, sessionID)
	}

	// Emit updated agent state snapshot after clearing running agents.
	// Completed agents (done/error/cancelled) are preserved so their
	// conversation history survives for post-run inspection. The merged
	// snapshot includes both extension-managed roster entries and any
	// retained engine-managed agents.
	//
	// Engine contract: `engine_agent_state` is a complete snapshot.
	// See docs/architecture/agent-state.md.
	m.mu.RLock()
	var runExitSnapshot []types.AgentStateUpdate
	if s, ok := m.sessions[key]; ok {
		runExitSnapshot = s.agents.MergedSnapshot()
	}
	m.mu.RUnlock()
	utils.LogWithFields(utils.LevelInfo, "session", "agent_snapshot_emitted reason=run_exit", map[string]any{"key": key, "count": len(runExitSnapshot)})
	m.emit(key, types.EngineEvent{
		Type:   "engine_agent_state",
		Agents: runExitSnapshot,
	})

	// Clear any stale working message before transitioning to idle
	m.emit(key, types.EngineEvent{Type: "engine_working_message", EventMessage: ""})

	// When background dispatches are still running, include the count so
	// clients can keep the tab status active and interrupt button visible
	// even though the parent LLM turn has ended.
	//
	// buildIdleStatusFields reads the retained context/cost state (pct, cw,
	// model, cost, sessionID) under m.mu and stamps bgCount directly. The
	// same helper is used by emitDispatchCountStatus so both emission sites
	// carry identical fields — preventing drift between the run-exit snapshot
	// and the post-deregister correction.
	m.mu.RLock()
	var exitSession *engineSession
	if s2, ok := m.sessions[key]; ok {
		exitSession = s2
	}
	m.mu.RUnlock()

	if bgCount > 0 {
		utils.LogWithFields(utils.LevelInfo, "session", "handlerunexit: emitting idle with", map[string]any{"bg_count": bgCount, "key": key})
	}
	var idleFields *types.StatusFields
	if exitSession != nil {
		idleFields = m.buildIdleStatusFields(exitSession, key, bgCount)
	} else {
		idleFields = &types.StatusFields{Label: key, State: "idle", BackgroundAgents: bgCount}
	}
	m.emit(key, types.EngineEvent{
		Type:   "engine_status",
		Fields: idleFields,
	})

	// Classify the exit. A cooperative cancel — code==0 with the "cancelled"
	// signal — is a CLEAN, recoverable exit, not a death: the run was
	// interrupted on purpose (user/auto abort, or a turn/tool hook cancelling
	// the run), the conversation is intact, and the session is immediately
	// reusable on the next prompt. Emitting engine_dead for it would overload
	// the event with a second, contradictory meaning and make a deliberately
	// interrupted run look like a crash (the 1782088921498-960b064fe896
	// incident, where the stuck-tab watchdog's abort produced a false "tab
	// died" for a perfectly recoverable run).
	//
	// engine_dead is reserved for ABNORMAL termination: a non-zero exit code,
	// or any signal other than the cooperative "cancelled" (e.g. SIGKILL,
	// SIGSEGV, or the watchdog's "cancelled-forced" hard kill). Those are real
	// deaths a consumer must surface. Narrowing engine_dead's trigger set is a
	// contract change ratified by ADR-013 (docs/architecture/adr/
	// 013-engine-dead-clean-cancel.md); see also ADR-003 for the precedent.
	cleanCancel := (code == nil || *code == 0) && signal != nil && *signal == "cancelled"
	abnormalExit := (code != nil && *code != 0) || (signal != nil && *signal != "cancelled")

	// Descendant teardown runs for ANY non-normal exit (clean cancel OR
	// abnormal death), independent of whether we emit engine_dead. A clean
	// cancel can arrive straight from the runloop (a turn_start / turn_end /
	// tool hook cancelling the run) WITHOUT flowing through SendAbort, so the
	// SendAbort-side abortAllDescendants is not guaranteed to have fired.
	// Reaping here ensures dispatched children never outlive a cancelled
	// parent regardless of the cancel's origin.
	if cleanCancel || abnormalExit {
		m.abortAllDescendants(key, fmt.Sprintf("parent run exit code=%s signal=%s", codeStr, sigStr))
	}

	if abnormalExit {
		utils.LogWithFields(utils.LevelWarn, "session", "emitting engine_dead", map[string]any{"key": key, "code_str": codeStr, "sig_str": sigStr})
		m.emit(key, types.EngineEvent{
			Type:     "engine_dead",
			ExitCode: code,
			Signal:   signal,
		})
	} else if cleanCancel {
		utils.LogWithFields(utils.LevelInfo, "session", "clean cancel (no engine_dead)", map[string]any{"key": key, "code_str": codeStr, "sig_str": sigStr})
	}

	// Auto-respawn any extension hosts whose subprocess died during the
	// run. Now that the run has finished we can rebuild safely without
	// mid-turn hook interleaving.
	m.respawnDeadExtensions(key)

	// Dispatch queued prompt outside the lock
	if nextPrompt != nil {
		utils.LogWithFields(utils.LevelDebug, "session", "dispatching queued prompt", map[string]any{"key": key})
		m.dispatchQueuedPrompt(key, nextPrompt)
	}
}

// dispatchQueuedPrompt re-submits a dequeued prompt on its own goroutine,
// forwarding the full *PromptOverrides captured at enqueue time. All 19
// override fields survive the queue round-trip because enqueueIfBusy stored
// a value copy. Dispatched off-lock and on a goroutine because SendPrompt
// re-acquires m.mu and may start a run.
func (m *Manager) dispatchQueuedPrompt(key string, next *pendingPrompt) {
	go func() {
		if err := m.SendPrompt(key, next.text, next.overrides); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "queued prompt failed", map[string]any{"error": err.Error()})
		}
	}()
}

// handleRunError is called when a backend run encounters an error.
// The error event is already emitted by ApiBackend.emitError via the
// NormalizedEvent pipeline (with structured ProviderError fields). This
// callback exists for logging and potential future coordination.
func (m *Manager) handleRunError(runID string, err error) {
	key := m.keyForRun(runID)
	if key == "" {
		return
	}
	utils.LogWithFields(utils.LevelError, "session", "handlerunerror", map[string]any{"key": key, "run_id": runID, "error": err.Error()})
	// Reap descendants so a dispatched child does not continue running
	// (and billing model time) after the parent loop has died.
	m.abortAllDescendants(key, fmt.Sprintf("parent run error: %s", err.Error()))
}

// classifyErrorCategory maps an error code to an extension ErrorCategory.
func classifyErrorCategory(code string) extension.ErrorCategory {
	switch code {
	case "rate_limit", "overloaded", "auth", "timeout", "network",
		"stale_connection", "invalid_model", "stream_truncated",
		"invalid_request", "prompt_too_long", "content_filter",
		"media_error", "pdf_error", "unknown":
		return extension.ErrorCategoryProvider
	default:
		return extension.ErrorCategoryProvider
	}
}
