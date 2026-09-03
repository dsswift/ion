package session

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/utils"
)

// persistAbortMarker writes the durable record of a cancelled run.
//
// Two kinds of cancel reach here and they mean different things to anything
// reading the history back. An operator stop is a deliberate redirect: the
// person abandoned the run and will say something else next. An engine-side
// cancel is the run interrupting itself — a turn or tool hook, a watchdog —
// with nobody behind it. Both are recorded, and Source is what separates them,
// so a consumer counting operator redirects never counts a watchdog as one.
//
// operatorStop is authoritative and independent of the exit classification: a
// stop that escalated to a forced kill exits abnormally and is still the
// operator's stop. An exit with no operator behind it is recorded only when it
// is a cooperative cancel; an ordinary completion and a crash are not aborts.
//
// Called from handleRunExit after persistTerminalDispatches and persistCliTurn,
// which is the first point where the backend's final save for this run has
// already landed. Writing earlier would have the save overwrite the entry.
func (m *Manager) persistAbortMarker(key, convID, runID string, signal *string, operatorStop bool, scope AbortScope, cleanCancel bool) {
	if !operatorStop && !cleanCancel {
		return
	}
	if convID == "" || runID == "" {
		utils.LogWithFields(utils.LevelDebug, "session", "abort marker skipped: no conversation or run id", map[string]any{
			"key": key, "conversation_id": convID, "run_id": runID, "operator_stop": operatorStop,
		})
		return
	}

	data := conversation.AbortedData{
		RunID:  runID,
		Source: conversation.AbortSourceEngine,
	}
	if operatorStop {
		data.Source = conversation.AbortSourceUser
		data.Scope = string(scope)
	}
	if signal != nil {
		data.Signal = *signal
	}

	if err := conversation.AppendAbortMarker(convID, data); err != nil {
		utils.LogWithFields(utils.LevelError, "session", "abort marker write failed", map[string]any{
			"key": key, "conversation_id": convID, "run_id": runID, "error": err,
		})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "abort marker written", map[string]any{
		"key": key, "conversation_id": convID, "run_id": runID,
		"abort_source": data.Source, "abort_scope": data.Scope, "signal": data.Signal,
	})
}
