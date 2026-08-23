package session

import (
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// stopBackgroundWork disarms a parked session before signaling its owned Bash
// processes. Task-completion callbacks may arrive after the stop, but find no
// outstanding work or parked record and therefore cannot wake a new run.
func (m *Manager) stopBackgroundWork(key string) {
	active := tools.BackgroundTasksForOwner(key)
	stoppedIDs := make([]string, 0, len(active))
	for _, task := range active {
		stoppedIDs = append(stoppedIDs, task.TaskID)
	}
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return
	}
	if s.parked != nil && s.parked.TimeoutTimer != nil {
		s.parked.TimeoutTimer.Stop()
	}
	outstanding := len(s.outstandingBackgroundTasks)
	s.outstandingBackgroundTasks = nil
	s.pendingBackgroundCompletions = nil
	s.parked = nil
	m.mu.Unlock()

	tools.StopBackgroundTasksForOwner(key)
	m.emitBackgroundShellStatus(key, "all_work_abort")
	m.emit(key, types.EngineEvent{Type: "engine_session_work_stopped", SessionWorkStopped: &types.SessionWorkStoppedEvent{Scope: string(AbortScopeAllWork), StoppedBackgroundTaskIDs: stoppedIDs}})
	utils.LogWithFields(utils.LevelInfo, "session.bgtask", "all work abort stopped background tasks", map[string]any{"session_id": key, "outstanding": outstanding})
}
