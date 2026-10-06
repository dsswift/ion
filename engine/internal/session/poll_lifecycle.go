package session

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// stopTimers stops the poll's re-arm and deadline timers. Caller holds
// Manager.mu.
func (p *activePoll) stopTimers() {
	if p.timer != nil {
		p.timer.Stop()
	}
	if p.deadlineTimer != nil {
		p.deadlineTimer.Stop()
	}
}

// expirePoll ends a poll whose deadline passed. A judge still in flight is
// left to finish; its late answer finds no poll and is dropped.
func (m *Manager) expirePoll(key, id string) {
	utils.LogWithFields(utils.LevelInfo, "session.poll", "poll deadline reached", map[string]any{"session_id": key, "poll_id": id})
	m.finishPoll(key, id, pollChildAnswer{Verdict: types.PollVerdictExhausted, Evidence: "The configured poll deadline was reached.", Reason: "deadline reached"})
}

// releaseDispatchPolls ends every poll a dispatch started, once that dispatch
// has ended. Nothing remains to receive their verdicts, so each ends with a
// terminal event and no delivery.
func (m *Manager) releaseDispatchPolls(key, dispatchID string) {
	if dispatchID == "" {
		return
	}
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return
	}
	var released []types.PollTerminalPayload
	for id, poll := range s.activePolls {
		if poll.owner != dispatchID {
			continue
		}
		poll.stopTimers()
		delete(s.activePolls, id)
		released = append(released, types.PollTerminalPayload{
			PollState: poll.state,
			Verdict:   types.PollVerdictStuck,
			Evidence:  "The dispatch that started this poll ended before the poll finished.",
			Reason:    "owning dispatch ended",
		})
	}
	m.mu.Unlock()

	if len(released) == 0 {
		utils.LogWithFields(utils.LevelDebug, "session.poll", "dispatch ended with no open polls", map[string]any{"session_id": key, "dispatch_id": dispatchID})
		return
	}
	for i := range released {
		result := released[i]
		m.emit(key, types.EngineEvent{Type: "engine_poll_terminal", PollTerminal: &result})
		utils.LogWithFields(utils.LevelInfo, "session.poll", "poll released: owning dispatch ended", map[string]any{"session_id": key, "poll_id": result.PollID, "dispatch_id": dispatchID, "attempt": result.Attempt})
	}
	m.emitPollStatus(key, "poll_released")
}

// ReleaseDispatchPolls ends the polls a finished dispatch left open.
func (a *sessionAccessor) ReleaseDispatchPolls(dispatchID string) {
	a.m.releaseDispatchPolls(a.key, dispatchID)
}
