package session

import (
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// buildStatusFields reads the exact session-owned work inventory under one
// manager lock. It exposes no client estimate: idle plus HasPendingWork means
// accepted work remains and must not be treated as terminal.
func (m *Manager) buildStatusFields(key string) (*types.StatusFields, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[key]
	if !ok {
		return nil, false
	}
	agents := 0
	if s.dispatchRegistry != nil {
		agents = len(s.dispatchRegistry.ActiveIDs())
	}
	fields := &types.StatusFields{
		Label:                 key,
		State:                 m.currentSessionStatus(s),
		BackgroundAgents:      agents,
		BackgroundShells:      len(s.outstandingBackgroundTasks),
		ActiveBackgroundTasks: liveBackgroundTaskStates(key),
		HasPendingWork:        agents > 0 || len(s.outstandingBackgroundTasks) > 0 || len(s.promptQueue) > 0 || len(s.rootDispatchCompletions) > 0 || len(s.pendingBackgroundCompletions) > 0 || s.parked != nil,
		SessionID:             s.conversationID,
		ContextPercent:        s.lastContextPct,
		ContextWindow:         s.lastContextWindow,
		ContextTokens:         s.lastContextTokens,
		ContextEffectiveLimit: s.lastContextLimit,
		Model:                 s.lastModel,
		RunCostUsd:            s.lastTotalCost,
		CompletionReason:      s.lastCompletionReason,
		ConversationCostUsd:   s.lastConvCost,
		PermissionDenials:     s.lastPermissionDenials,
	}
	return fields, true
}

// liveBackgroundTaskStates projects every LIVE session-owned background Bash
// process into wire shape, notifying or detached.
//
// Separate from buildStatusFields because the hand-built status snapshots
// (run start in prompt_dispatch.go, extension restart and idle in
// host_death.go, clear in clear_core.go) need the same inventory. Those
// snapshots are complete-replacement events by contract, so a snapshot that
// omitted this field told every consumer that a live command had disappeared —
// the next status emission after a detached command started erased it from the
// client's view even though the process was still running.
func liveBackgroundTaskStates(owner string) []types.BackgroundTaskState {
	activeTasks := tools.BackgroundTasksForOwner(owner)
	if len(activeTasks) == 0 {
		return nil
	}
	states := make([]types.BackgroundTaskState, len(activeTasks))
	for i, task := range activeTasks {
		states[i] = types.BackgroundTaskState{
			TaskID:           task.TaskID,
			ToolID:           task.ToolID,
			Command:          task.Command,
			StartedAt:        task.StartedAt.UnixMilli(),
			NotifyOnComplete: task.NotifyOnComplete,
		}
	}
	return states
}
