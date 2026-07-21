package session

import (

	"github.com/dsswift/ion/engine/internal/utils"
)

// Stable runID -> session-key binding for event routing.
//
// WHY THIS EXISTS
//
// Every NormalizedEvent the backend emits is routed to its session by
// keyForRun(runID). Before this binding, keyForRun resolved the key by
// scanning sessions for one whose engineSession.requestID matched the runID
// (see keyForRun in helpers.go). That coupling is fragile: requestID is a
// transient field that currentSessionStatus HISTORICALLY cleared mid-run when
// the backend momentarily "disclaimed" a still-live run (manager.go:
// `currentSessionStatus: clearing stale requestID ... (backend disclaims
// run)`). When that clear raced an in-flight emit, the scan returned "" and
// handleNormalizedEvent dropped the event before it reached any consumer.
//
// The root cause of that spurious mid-run disclaim — a status computation
// racing SendPrompt's window between the requestID assignment and the
// backend Start* registration — has since been fixed at the source: the
// engineSession.dispatchingRunID marker makes currentSessionStatus report
// running (without clearing) throughout the dispatch window. See
// engineSession.dispatchingRunID in types.go. The binding remains
// load-bearing regardless: event routing must not depend on requestID
// surviving every concurrent status query, and the legitimate disclaim-clear
// (a run that terminated abnormally without flowing through handleRunExit)
// still exists by design.
//
// The observed production failure: an auto-dispatched run that flipped to plan
// mode mid-run emitted PlanModeChangedEvent{Enabled:true} exactly while
// requestID was transiently cleared. The event was dropped, the desktop never
// learned the session entered plan mode, and the permission-mode pill silently
// fell back to "auto". That is one victim of a general defect — ANY in-flight
// event (tool results, text chunks, agent-state snapshots) emitted in that
// window was equally droppable.
//
// THE FIX
//
// runKeyBindings is a stable runID -> key map that is independent of the
// transient requestID. It is set at dispatch (when the run is registered),
// consulted first by keyForRun, and cleared only at the authoritative terminal
// points (handleRunExit, and the early-abort paths that assign requestID = ""
// without ever starting a run). Routing therefore no longer depends on the
// requestID field surviving every concurrent status query.
//
// All three accessors take m.mu (the same lock that guards `sessions`) so the
// binding and the session map never disagree under concurrency.

// bindRun records the runID -> key association for an active run. Called at the
// dispatch seam where engineSession.requestID is assigned. Caller must hold
// m.mu (write).
func (m *Manager) bindRunLocked(runID, key string) {
	if runID == "" {
		return
	}
	m.runKeyBindings[runID] = key
	utils.LogWithFields(utils.LevelInfo, "session", "bindrun: -> (event-routing binding set)", map[string]any{"run_id": runID, "key": key})
}

// unbindRun removes the runID -> key association. Called at the authoritative
// terminal points: handleRunExit (normal/abnormal run end) and the early-abort
// dispatch paths that clear requestID without starting a run. Idempotent —
// unbinding an absent runID is a no-op. Acquires m.mu (write).
func (m *Manager) unbindRun(runID string) {
	if runID == "" {
		return
	}
	m.mu.Lock()
	_, existed := m.runKeyBindings[runID]
	delete(m.runKeyBindings, runID)
	m.mu.Unlock()
	if existed {
		utils.LogWithFields(utils.LevelInfo, "session", "unbindrun: (event-routing binding cleared)", map[string]any{"run_id": runID})
	} else {
		utils.LogWithFields(utils.LevelDebug, "session", "unbindrun: (no binding present — already cleared)", map[string]any{"run_id": runID})
	}
}

// keyForRunBinding returns the bound key for a runID, or "" if no binding
// exists. Caller must hold m.mu (read or write). This is the primary lookup
// keyForRun consults before falling back to the requestID scan.
func (m *Manager) keyForRunBinding(runID string) string {
	return m.runKeyBindings[runID]
}

// unbindRunLocked removes the runID -> key association without acquiring m.mu.
// For callers that already hold m.mu (write) — notably handleRunExit, which
// clears s.requestID under the same lock. Idempotent.
func (m *Manager) unbindRunLocked(runID string) {
	if runID == "" {
		return
	}
	if _, existed := m.runKeyBindings[runID]; existed {
		delete(m.runKeyBindings, runID)
		utils.LogWithFields(utils.LevelInfo, "session", "unbindrun: (event-routing binding cleared, under lock)", map[string]any{"run_id": runID})
	}
}
