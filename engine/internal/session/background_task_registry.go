package session

import (
	"sort"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// background_task_registry.go owns the session-scoped set of outstanding
// background bash commands — those started via Bash(run_in_background: true,
// notify_on_complete: true).
//
// Why the set lives on the session rather than on the run: a model may start a
// command, keep working, start another, keep working, and only then end its
// turn. Those commands were registered by DIFFERENT runs (each turn boundary
// that ends a run starts a new one on the next prompt), but they are all work
// the same session is waiting on. A run-scoped set would forget the earlier
// commands the moment the run that started them exited, and the session would
// complete while its own background work was still in flight.
//
// The park/wake cycle that consumes this set is in background_task_wake.go.

// outstandingBackgroundTask is one tracked background command.
type outstandingBackgroundTask struct {
	// TaskID is the tasks-registry ID ("bash-<n>-<millis>").
	TaskID string
	// Command is the shell command, retained so a wake payload can describe
	// what is still running without reaching back into the tools registry.
	Command string
	// StartedAt is when the command was registered on this session.
	StartedAt time.Time
}

// registerOutstandingBackgroundTask adds a task to the session's outstanding
// set. Called from the Bash tool through the run's registrar seam (the
// tools.OutstandingRegistrar stamped onto the tool context).
//
// Enforces BackgroundTasksConfig.MaxOutstandingPerSession: past the cap the
// command still runs and still notifies, it is simply not tracked as
// outstanding — so a runaway loop cannot grow the set without bound, and the
// session will not park waiting on an unbounded pile.
func (m *Manager) registerOutstandingBackgroundTask(key, taskID, command string) {
	cfg := m.backgroundTasksConfig()

	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelWarn, "session.bgtask", "register outstanding: no such session", map[string]any{
			"session_id": key, "task_id": taskID,
		})
		return
	}
	if s.outstandingBackgroundTasks == nil {
		s.outstandingBackgroundTasks = make(map[string]outstandingBackgroundTask)
	}
	if len(s.outstandingBackgroundTasks) >= cfg.MaxOutstandingPerSession {
		count := len(s.outstandingBackgroundTasks)
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelWarn, "session.bgtask", "register outstanding: at cap, task runs untracked", map[string]any{
			"session_id": key, "task_id": taskID, "count": count, "max": cfg.MaxOutstandingPerSession,
		})
		return
	}
	s.outstandingBackgroundTasks[taskID] = outstandingBackgroundTask{
		TaskID:    taskID,
		Command:   command,
		StartedAt: time.Now(),
	}
	count := len(s.outstandingBackgroundTasks)
	m.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "session.bgtask", "outstanding background task registered", map[string]any{
		"session_id": key, "task_id": taskID, "count": count,
	})
	// The outstanding count rides engine_status alongside BackgroundAgents, so
	// consumers see the tab go "waiting on shells" the moment one is started.
	m.emitBackgroundShellStatus(key, "background_task_registered")
}

// drainOutstandingBackgroundTask removes one task from the set and returns the
// tasks that remain, sorted by start time (oldest first) for stable payloads
// and logs. found reports whether the task was actually tracked — a completion
// for an untracked task (started without notify, or registered past the cap)
// still emits its typed event but must not drive the park/wake cycle.
//
// Caller must hold m.mu: the wake path drains and claims the wake under one
// lock hold so two simultaneous completions cannot both start a run.
func drainOutstandingBackgroundTaskLocked(s *engineSession, taskID string) (remaining []outstandingBackgroundTask, found bool) {
	if s.outstandingBackgroundTasks == nil {
		return nil, false
	}
	if _, ok := s.outstandingBackgroundTasks[taskID]; !ok {
		return outstandingSnapshotLocked(s), false
	}
	delete(s.outstandingBackgroundTasks, taskID)
	return outstandingSnapshotLocked(s), true
}

// outstandingSnapshotLocked returns the current outstanding set as a slice
// sorted oldest-first. Caller must hold m.mu.
func outstandingSnapshotLocked(s *engineSession) []outstandingBackgroundTask {
	if len(s.outstandingBackgroundTasks) == 0 {
		return nil
	}
	out := make([]outstandingBackgroundTask, 0, len(s.outstandingBackgroundTasks))
	for _, t := range s.outstandingBackgroundTasks {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].StartedAt.Equal(out[j].StartedAt) {
			return out[i].TaskID < out[j].TaskID
		}
		return out[i].StartedAt.Before(out[j].StartedAt)
	})
	return out
}

// OutstandingBackgroundTaskIDs returns the session's outstanding task IDs,
// oldest first. Used by the run loop's turn-boundary park check (through the
// RunConfig seam) and by status projection. Returns nil for an unknown session
// or an empty set, so the caller's "is anything outstanding" test is a simple
// length check.
func (m *Manager) OutstandingBackgroundTaskIDs(key string) []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[key]
	if !ok {
		return nil
	}
	snap := outstandingSnapshotLocked(s)
	if len(snap) == 0 {
		return nil
	}
	ids := make([]string, 0, len(snap))
	for _, t := range snap {
		ids = append(ids, t.TaskID)
	}
	return ids
}

// clearOutstandingBackgroundTasks drops the whole set and any parked state.
// Called from StopSession alongside tools.StopBackgroundTasksForOwner, which
// kills the processes themselves — this clears the bookkeeping so a torn-down
// session leaves nothing behind for a late completion to find.
func (m *Manager) clearOutstandingBackgroundTasks(key string) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return
	}
	count := len(s.outstandingBackgroundTasks)
	pollCount := len(s.activePolls)
	wasParked := s.parked != nil
	if s.parked != nil && s.parked.TimeoutTimer != nil {
		s.parked.TimeoutTimer.Stop()
	}
	s.outstandingBackgroundTasks = nil
	for _, poll := range s.activePolls {
		if poll.timer != nil {
			poll.timer.Stop()
		}
	}
	s.activePolls = nil
	s.parked = nil
	s.pendingBackgroundCompletions = nil
	m.mu.Unlock()

	if count > 0 || pollCount > 0 || wasParked {
		utils.LogWithFields(utils.LevelInfo, "session.bgtask", "outstanding background work cleared at session stop", map[string]any{
			"session_id": key, "shell_count": count, "poll_count": pollCount, "was_parked": wasParked,
		})
	} else {
		utils.LogWithFields(utils.LevelDebug, "session.bgtask", "no outstanding background tasks to clear at session stop", map[string]any{
			"session_id": key,
		})
	}
}

// backgroundTasksConfig resolves the engine's background-task policy, falling
// back to compiled defaults when engine.json omits the block.
func (m *Manager) backgroundTasksConfig() types.BackgroundTasksConfig {
	if m.config == nil {
		return types.BackgroundTasksDefaults()
	}
	return m.config.BackgroundTasks.Resolved()
}

// emitBackgroundShellStatus re-emits the session's status so consumers see the
// current outstanding-shell count. The count itself rides StatusFields
// (BackgroundShells) on the existing engine_status event — no new event type,
// mirroring how BackgroundAgents is surfaced. reason is an observability label
// naming what moved the count.
func (m *Manager) emitBackgroundShellStatus(key, reason string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return
	}
	count := len(s.outstandingBackgroundTasks)
	m.mu.RUnlock()

	utils.LogWithFields(utils.LevelDebug, "session.bgtask", "emitting background-shell status", map[string]any{
		"session_id": key, "count": count, "reason": reason,
	})
	m.emitSessionStatus(key, reason)
}
