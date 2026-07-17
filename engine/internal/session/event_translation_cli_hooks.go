package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// fireCliTurnHooks fires turn_start / turn_end extension hooks for CLI
// backend runs. No-op when the backend is not ClaudeCodeBackend or when the
// session has no extension group.
//
// Turn boundaries are derived from the normalised event stream:
//   - turn_start: first TextChunkEvent or ToolCallEvent after run start
//     or after the previous turn ended.
//   - turn_end: TaskUpdateEvent (completed assistant message) signals that
//     the model finished responding and tools (if any) have been executed.
//   - TaskCompleteEvent: final result; close any active turn before the
//     run finishes.
//
// Under HybridBackend, the resolved backend for the *current* run depends
// on the model that started it. We use s.lastModel (set in prompt_dispatch
// when StartRun is called) to drive the resolution. If lastModel is empty
// (no run yet), this is a no-op — matching the pre-hybrid behavior of
// returning early when the backend wasn't ClaudeCodeBackend.
func (m *Manager) fireCliTurnHooks(s *engineSession, key string, sOk bool, event types.NormalizedEvent) {
	if _, isCli := m.resolvedBackend(s.lastModel).(*backend.ClaudeCodeBackend); !isCli {
		return
	}
	if !sOk || s.extGroup == nil || s.extGroup.IsEmpty() {
		return
	}

	switch e := event.Data.(type) {
	case *types.TextChunkEvent:
		// Accumulate assistant text for message_update hook.
		m.mu.Lock()
		s.cliTextBuf += e.Text
		alreadyActive := s.cliTurnActive
		if !alreadyActive {
			s.cliTurnNumber++
			s.cliTurnActive = true
		}
		turnNum := s.cliTurnNumber
		m.mu.Unlock()

		if !alreadyActive {
			ctx := m.newExtContext(s, key)
			s.extGroup.FireTurnStart(ctx, extension.TurnInfo{TurnNumber: turnNum})
			taskID := fmt.Sprintf("%s-t%d", key, turnNum)
			utils.LogWithFields(utils.LevelDebug, "session", "firecliturnhooks: task_created", map[string]any{"run_id": taskID, "key": key, "turn": turnNum})
			_ = s.extGroup.FireTaskCreated(ctx, extension.TaskLifecycleInfo{
				TaskID: taskID,
				Name:   fmt.Sprintf("turn-%d", turnNum),
				Status: "running",
			})
		}

	case *types.ToolCallEvent:
		_ = e // suppress unused
		m.mu.Lock()
		alreadyActive := s.cliTurnActive
		if !alreadyActive {
			s.cliTurnNumber++
			s.cliTurnActive = true
		}
		turnNum := s.cliTurnNumber
		m.mu.Unlock()

		if !alreadyActive {
			ctx := m.newExtContext(s, key)
			s.extGroup.FireTurnStart(ctx, extension.TurnInfo{TurnNumber: turnNum})
			taskID := fmt.Sprintf("%s-t%d", key, turnNum)
			utils.LogWithFields(utils.LevelDebug, "session", "firecliturnhooks: task_created", map[string]any{"run_id": taskID, "key": key, "turn": turnNum})
			_ = s.extGroup.FireTaskCreated(ctx, extension.TaskLifecycleInfo{
				TaskID: taskID,
				Name:   fmt.Sprintf("turn-%d", turnNum),
				Status: "running",
			})
		}

	case *types.TaskUpdateEvent:
		_ = e // suppress unused
		m.mu.Lock()
		wasActive := s.cliTurnActive
		s.cliTurnActive = false
		turnNum := s.cliTurnNumber
		accum := s.cliTextBuf
		s.cliTextBuf = ""
		m.mu.Unlock()

		if wasActive {
			ctx := m.newExtContext(s, key)
			if accum != "" {
				_ = s.extGroup.FireMessageUpdate(ctx, extension.MessageUpdateInfo{
					Role:    "assistant",
					Content: accum,
				})
			}
			s.extGroup.FireTurnEnd(ctx, extension.TurnInfo{TurnNumber: turnNum})
		}

	case *types.TaskCompleteEvent:
		_ = e // suppress unused
		m.mu.Lock()
		wasActive := s.cliTurnActive
		s.cliTurnActive = false
		turnNum := s.cliTurnNumber
		accum := s.cliTextBuf
		s.cliTextBuf = ""
		m.mu.Unlock()

		if wasActive {
			ctx := m.newExtContext(s, key)
			if accum != "" {
				_ = s.extGroup.FireMessageUpdate(ctx, extension.MessageUpdateInfo{
					Role:    "assistant",
					Content: accum,
				})
			}
			s.extGroup.FireTurnEnd(ctx, extension.TurnInfo{TurnNumber: turnNum})
		}
		// task_completed fires when at least one turn occurred during this run.
		// turnNum > 0 guarantees a prior task_created with the same TaskID.
		if turnNum > 0 {
			ctx := m.newExtContext(s, key)
			taskID := fmt.Sprintf("%s-t%d", key, turnNum)
			utils.LogWithFields(utils.LevelDebug, "session", "firecliturnhooks: task_completed", map[string]any{"run_id": taskID, "key": key, "turn": turnNum})
			_ = s.extGroup.FireTaskCompleted(ctx, extension.TaskLifecycleInfo{
				TaskID: taskID,
				Name:   fmt.Sprintf("turn-%d", turnNum),
				Status: "completed",
			})
		}
	}
}
