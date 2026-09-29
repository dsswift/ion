// Run-exit and run-error handling for backend runs.
//
// Split from event_translation.go, which carries the normalized-event
// translation path. This file carries the other half of the same lifecycle:
// what the Manager does once a run has stopped producing events — clearing the
// run routing binding, preserving live dispatch states, capturing the
// native-session cursor, persisting terminal dispatch entries, and the error
// path's descendant reap.

package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

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
	utils.LogWithFields(utils.LevelInfo, "session", "handlerunexit", map[string]any{"key": key, "run_id": runID, "code_str": codeStr, "sig_str": sigStr, "session_id": sessionID})

	var nextPrompt *pendingPrompt
	var bgCount int
	var ionConvID string
	var exitSession *engineSession
	var captureCursorKind string
	var captureCursorToolSignature string
	var invalidateCursorKind string
	// skipDescendantReap is set when this exit was caused by an
	// orchestrator-scoped abort, which deliberately leaves background
	// dispatches running. Read from the session's one-shot marker under the
	// lock below and consumed by the reap decision further down.
	var skipDescendantReap bool
	// operatorStop reports that the operator asked for this run to stop, and
	// operatorScope is the scope they asked for. Read from the session's
	// one-shot marker under the lock below and consumed by the abort-marker
	// write further down, which is the first point after the backend's final
	// save where the entry survives.
	// manualCompactClosed — see consumeManualCompactRunExitLocked below.
	var operatorStop, manualCompactClosed bool
	var operatorScope AbortScope
	m.mu.Lock()
	// Authoritative terminal point: clear the runID -> key routing binding
	// under the lock, unconditionally (even if the session was already torn
	// down) so the binding can never leak. After this, a late event for the
	// same runID correctly resolves to "" and is dropped.
	m.unbindRunLocked(runID)
	if s, ok := m.sessions[key]; ok {
		m.clearTemporaryAutoPlanOnAbnormalExitLocked(s, key, runID, code, signal)
		// Keep the exact session instance that owned this run. Later recovery
		// cleanup runs outside this lock, so it must never clear a lifecycle
		// belonging to a replacement session with the same key.
		exitSession = s
		emitRunSpanLocked(s, key, runID, code, signal)
		s.clearRunIdentity()
		// Consume the orchestrator-scoped-abort marker. Matching on runID
		// means a marker left by an earlier run can never suppress this run's
		// reap; clearing it unconditionally when it matches makes it one-shot,
		// so the NEXT ordinary cancel on this session reaps normally.
		if s.orchestratorAbortRunID != "" && s.orchestratorAbortRunID == runID {
			skipDescendantReap = true
			s.orchestratorAbortRunID = ""
		}
		// Consume the operator-stop marker the same way, and for the same
		// reason: a stop recorded against an earlier run must never label this
		// run's exit as operator-initiated.
		if s.operatorAbortRunID != "" && s.operatorAbortRunID == runID {
			operatorStop = true
			operatorScope = s.operatorAbortScope
			s.operatorAbortRunID = ""
			s.operatorAbortScope = ""
		}
		// See manual_compact_indicator.go.
		manualCompactClosed = consumeManualCompactRunExitLocked(s, runID)
		// Ion's durable conversation-file identity, captured under the lock
		// for use in persistTerminalDispatches below. This is NOT the
		// backend-reported sessionID (which is claude's UUID for the CLI
		// backend and has no Ion files).
		ionConvID = s.conversationID
		// See preserveDispatchStatesLocked in run_exit_dispatch_preserve.go.
		bgCount = preserveDispatchStatesLocked(s)
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
			if s.cliRunFailedTerminal {
				// The CLI reported a terminal error before exiting (e.g. its
				// autocompactor thrashed until it gave up). Its native session
				// is saturated; a cursor pointing at it would make the next
				// prompt resume straight back into the failure. Skip capture
				// and invalidate whatever cursor this kind already has.
				invalidateCursorKind = s.runCaps.Kind
				utils.LogWithFields(utils.LevelWarn, "session", "handlerunexit: terminal cli failure, invalidating native cursor instead of capturing", map[string]any{"key": key, "kind": invalidateCursorKind, "reported_session_id": sessionID})
			} else {
				captureCursorKind = s.runCaps.Kind
				captureCursorToolSignature = s.runClientToolSignature
				utils.LogWithFields(utils.LevelInfo, "session", "handlerunexit: native session id reported, capturing cursor", map[string]any{"session_id": sessionID, "key": key, "kind": captureCursorKind, "conversation_id": s.conversationID})
			}
		} else {
			// Even with no fresh cursor reported, a terminally-failed CLI run
			// must not leave a PRIOR cursor armed — that cursor points at the
			// same saturated native session the failed run resumed.
			if s.cliRunFailedTerminal && s.runCaps.ContextModel == backend.ContextModelNativeSession {
				invalidateCursorKind = s.runCaps.Kind
				utils.LogWithFields(utils.LevelWarn, "session", "handlerunexit: terminal cli failure with no reported id, invalidating prior native cursor", map[string]any{"key": key, "kind": invalidateCursorKind})
			}
			utils.LogWithFields(utils.LevelInfo, "session", "handlerunexit: no native session id to capture", map[string]any{"key": key, "reported_session_id": sessionID, "kind": s.runCaps.Kind})
		}
		if len(s.promptQueue) > 0 {
			next := s.promptQueue[0]
			s.promptQueue = s.promptQueue[1:]
			nextPrompt = &next
		}
	}
	m.mu.Unlock()

	if manualCompactClosed {
		m.emit(key, manualCompactCloseEvent())
	}

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
		m.captureNativeSessionCursor(key, ionConvID, captureCursorKind, sessionID, captureCursorToolSignature)
	}
	// Invalidate the native cursor after a terminal CLI failure — the inverse
	// of capture, through the same persistence funnel, so the next prompt
	// bridges from Ion's transcript rather than resuming a saturated native
	// session. Runs at the same post-write point as capture for the same
	// leaf-tagging reason.
	if invalidateCursorKind != "" {
		m.invalidateNativeSessionCursor(key, ionConvID, invalidateCursorKind)
	}

	// Emit updated agent state snapshot after clearing running agents.
	// Completed agents (done/error/cancelled) are preserved so their
	// conversation history survives for post-run inspection. The merged
	// snapshot includes both extension-managed roster entries and any
	// retained engine-managed agents.
	//
	// Engine contract: `engine_agent_state` is a complete snapshot.
	// See docs/architecture/agent-state.md.
	// force=true: run exit is a terminal transition (see agent-state.md's
	// emitter guarantee), so it is never deduped or delayed.
	m.emitAgentSnapshotFor(key, agentSnapshotReasonRunExit, true)

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
	//
	// Refresh the retained context state from the persisted conversation
	// FIRST, so the idle snapshot below reports what is actually on disk
	// rather than whatever the last streamed event left behind. This is the
	// only recompute point between runs; without it a session whose backend
	// emits no usage events (the ACP backends) reports zero forever.
	m.refreshContextUsage(key, "run_exit")

	if bgCount > 0 {
		utils.LogWithFields(utils.LevelInfo, "session", "handlerunexit: emitting idle with", map[string]any{"bg_count": bgCount, "key": key})
	}
	var idleFields *types.StatusFields
	if fields, exists := m.buildStatusFields(key); exists {
		idleFields = fields
	} else {
		idleFields = &types.StatusFields{Label: key, State: "idle", BackgroundAgents: bgCount}
	}
	// The run identity has cleared, but queued user input may already have been
	// dequeued for dispatch. Preserve that handoff in the exit snapshot so a
	// consumer cannot see a false terminal gap before SendPrompt starts it.
	if nextPrompt != nil {
		idleFields.HasPendingWork = true
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
	// or any signal other than the cooperative "cancelled" / "suspended"
	// (e.g. SIGKILL, SIGSEGV, or the watchdog's "cancelled-forced" hard
	// kill). Those are real deaths a consumer must surface. Narrowing
	// engine_dead's trigger set is a contract change ratified by ADR-013
	// (docs/architecture/adr/013-engine-dead-clean-cancel.md); see also
	// ADR-003 for the precedent.
	//
	// "suspended" is the park-exit signal (drainSuspend /
	// parkForChildDispatches): the run ended deliberately at a turn boundary
	// with work still in flight, and something will revive it. It is neither
	// a death nor a cancel — descendants must NOT be reaped (the children
	// being awaited are exactly the descendants) and engine_dead must not
	// fire.
	cleanCancel := (code == nil || *code == 0) && signal != nil && *signal == "cancelled"
	suspendedExit := (code == nil || *code == 0) && signal != nil && *signal == "suspended"
	abnormalExit := (code != nil && *code != 0) || (signal != nil && *signal != "cancelled" && *signal != "suspended")

	// Descendant teardown runs for ANY non-normal exit (clean cancel OR
	// abnormal death), independent of whether we emit engine_dead. A clean
	// cancel can arrive straight from the runloop (a turn_start / turn_end /
	// tool hook cancelling the run) WITHOUT flowing through SendAbort, so the
	// SendAbort-side abortAllDescendants is not guaranteed to have fired.
	// Reaping here ensures dispatched children never outlive a cancelled
	// parent regardless of the cancel's origin.
	//
	// The one exception is an orchestrator-scoped abort, which cancelled this
	// run precisely so its background dispatches could keep running. Reaping
	// here would silently undo that scope, since a scoped abort is otherwise
	// indistinguishable from any other cancel at run exit.
	// Record the stop in the conversation before teardown. See
	// persistAbortMarker for why this point, and why an operator stop is
	// recorded regardless of how the run exited.
	m.persistAbortMarker(key, ionConvID, runID, signal, operatorStop, operatorScope, cleanCancel)

	if cleanCancel || abnormalExit {
		if skipDescendantReap {
			utils.LogWithFields(utils.LevelInfo, "session", "handlerunexit: skipping descendant reap (orchestrator-scoped abort)", map[string]any{"key": key, "run_id": runID, "code_str": codeStr, "sig_str": sigStr})
		} else {
			m.abortAllDescendants(key, fmt.Sprintf("parent run exit code=%s signal=%s", codeStr, sigStr))
		}
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
	} else if suspendedExit {
		// Park exit: the run ended deliberately with children or background
		// work in flight. No descendant reaping (the awaited children ARE
		// the descendants), no engine_dead. Logged so the park's exit branch
		// is reconstructible next to the cancel/death branches above.
		utils.LogWithFields(utils.LevelInfo, "session", "suspended exit (park; no reap, no engine_dead)", map[string]any{"key": key, "code_str": codeStr, "sig_str": sigStr})
	}

	// A terminal exit clears its durable journal. A suspended root remains
	// recoverable because its engine-owned wake has not started yet.
	m.cleanupRunExitJournal(exitSession, key, runID, suspendedExit, cleanCancel, abnormalExit, codeStr, sigStr)

	// Auto-respawn any extension hosts whose subprocess died during the
	// run. Now that the run has finished we can rebuild safely without
	// mid-turn hook interleaving.
	m.respawnDeadExtensions(key)

	// Dispatch queued prompt outside the lock. A user prompt accepted before a
	// completion retains FIFO priority; once it is dispatched, the completion
	// retry queues safely behind its active run.
	if nextPrompt != nil {
		utils.LogWithFields(utils.LevelDebug, "session", "dispatching queued prompt", map[string]any{"key": key})
		m.dispatchQueuedPrompt(key, nextPrompt)
		return
	}
	m.retryRootDispatchCompletions(key)
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
