package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// handleNormalizedEvent translates a NormalizedEvent into an EngineEvent
// and forwards it through the Manager's event callback.
func (m *Manager) handleNormalizedEvent(runID string, event types.NormalizedEvent) {
	key := m.keyForRun(runID)
	if key == "" {
		return
	}

	utils.Debug("Session", fmt.Sprintf("normalized event: key=%s runID=%s type=%T", key, runID, event.Data))

	// Look up session once for all downstream hook firing.
	m.mu.RLock()
	s, sOk := m.sessions[key]
	m.mu.RUnlock()

	// Fire CLI backend turn lifecycle hooks BEFORE the translate/drop gate.
	// TaskUpdateEvent (assistant message complete) has no client-facing
	// EngineEvent translation and would be dropped by the ee.Type == ""
	// check below, but it is the signal for turn_end.
	m.fireCliTurnHooks(s, key, sOk, event)

	contextWindow := conversation.DefaultContext

	ee := translateToEngineEvent(event, contextWindow)
	if ee.Type == "" {
		utils.Debug("Session", fmt.Sprintf("dropping unhandled normalized event type: %T", event.Data))
		return
	}
	m.emit(key, ee)

	// G34: Fire tool_start/tool_end extension hooks
	if sOk && s.extGroup != nil && !s.extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		switch e := event.Data.(type) {
		case *types.ToolCallEvent:
			_ = s.extGroup.FireToolStart(ctx, extension.ToolStartInfo{
				ToolName: e.ToolName,
				ToolID:   e.ToolID,
			})
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
	utils.Info("Session", fmt.Sprintf("handleRunExit: key=%s runID=%s code=%s signal=%s sessionID=%s", key, runID, codeStr, sigStr, sessionID))

	var nextPrompt *pendingPrompt
	m.mu.Lock()
	if s, ok := m.sessions[key]; ok {
		s.requestID = ""
		s.agentStates = nil
		if sessionID != "" {
			s.conversationID = sessionID
		}
		if len(s.promptQueue) > 0 {
			next := s.promptQueue[0]
			s.promptQueue = s.promptQueue[1:]
			nextPrompt = &next
		}
	}
	m.mu.Unlock()

	// Clear engine-managed agent panel (Agent tool sub-agents).
	// Only emit if the session had built-in agent states; extension-managed
	// agents are owned by the extension and must not be wiped on run exit.
	m.mu.RLock()
	hasExtGroup := false
	if s, ok := m.sessions[key]; ok {
		hasExtGroup = s.extGroup != nil && !s.extGroup.IsEmpty()
	}
	m.mu.RUnlock()
	if !hasExtGroup {
		m.emit(key, types.EngineEvent{
			Type:   "engine_agent_state",
			Agents: []types.AgentStateUpdate{},
		})
	}

	// Clear any stale working message before transitioning to idle
	m.emit(key, types.EngineEvent{Type: "engine_working_message", EventMessage: ""})

	m.emit(key, types.EngineEvent{
		Type:   "engine_status",
		Fields: &types.StatusFields{Label: key, State: "idle", SessionID: sessionID},
	})

	if (code != nil && *code != 0) || signal != nil {
		utils.Warn("Session", fmt.Sprintf("emitting engine_dead: key=%s code=%s signal=%s", key, codeStr, sigStr))
		m.abortAllDescendants(key, fmt.Sprintf("parent run exit code=%s signal=%s", codeStr, sigStr))
		m.emit(key, types.EngineEvent{
			Type:     "engine_dead",
			ExitCode: code,
			Signal:   signal,
		})
	}

	// Auto-respawn any extension hosts whose subprocess died during the
	// run. Now that the run has finished we can rebuild safely without
	// mid-turn hook interleaving.
	m.respawnDeadExtensions(key)

	// Dispatch queued prompt outside the lock
	if nextPrompt != nil {
		utils.Debug("Session", fmt.Sprintf("dispatching queued prompt: key=%s", key))
		go func() {
			var ov *PromptOverrides
			if nextPrompt.model != "" || nextPrompt.maxTurns > 0 || nextPrompt.maxBudgetUsd > 0 || len(nextPrompt.extensions) > 0 || nextPrompt.noExtensions {
				ov = &PromptOverrides{
					Model:        nextPrompt.model,
					MaxTurns:     nextPrompt.maxTurns,
					MaxBudgetUsd: nextPrompt.maxBudgetUsd,
					Extensions:   nextPrompt.extensions,
					NoExtensions: nextPrompt.noExtensions,
				}
			}
			if err := m.SendPrompt(key, nextPrompt.text, ov); err != nil {
				utils.Error("Session", "queued prompt failed: "+err.Error())
			}
		}()
	}
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
	utils.Error("Session", fmt.Sprintf("handleRunError: key=%s runID=%s err=%s", key, runID, err.Error()))
	// Reap descendants so a dispatched child does not continue running
	// (and billing model time) after the parent loop has died.
	m.abortAllDescendants(key, fmt.Sprintf("parent run error: %s", err.Error()))
}

// fireCliTurnHooks fires turn_start / turn_end extension hooks for CLI
// backend runs. No-op when the backend is not CliBackend or when the
// session has no extension group.
//
// Turn boundaries are derived from the normalised event stream:
//   - turn_start: first TextChunkEvent or ToolCallEvent after run start
//     or after the previous turn ended.
//   - turn_end: TaskUpdateEvent (completed assistant message) signals that
//     the model finished responding and tools (if any) have been executed.
//   - TaskCompleteEvent: final result; close any active turn before the
//     run finishes.
func (m *Manager) fireCliTurnHooks(s *engineSession, key string, sOk bool, event types.NormalizedEvent) {
	if _, isCli := m.backend.(*backend.CliBackend); !isCli {
		return
	}
	if !sOk || s.extGroup == nil || s.extGroup.IsEmpty() {
		return
	}

	switch event.Data.(type) {
	case *types.TextChunkEvent, *types.ToolCallEvent:
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
		}

	case *types.TaskUpdateEvent:
		m.mu.Lock()
		wasActive := s.cliTurnActive
		s.cliTurnActive = false
		turnNum := s.cliTurnNumber
		m.mu.Unlock()

		if wasActive {
			ctx := m.newExtContext(s, key)
			s.extGroup.FireTurnEnd(ctx, extension.TurnInfo{TurnNumber: turnNum})
		}

	case *types.TaskCompleteEvent:
		m.mu.Lock()
		wasActive := s.cliTurnActive
		s.cliTurnActive = false
		turnNum := s.cliTurnNumber
		m.mu.Unlock()

		if wasActive {
			ctx := m.newExtContext(s, key)
			s.extGroup.FireTurnEnd(ctx, extension.TurnInfo{TurnNumber: turnNum})
		}
	}
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

// translateToEngineEvent converts a NormalizedEvent to an EngineEvent.
func translateToEngineEvent(event types.NormalizedEvent, contextWindow int) types.EngineEvent {
	if event.Data == nil {
		return types.EngineEvent{Type: "engine_error", EventMessage: "nil event data"}
	}

	switch e := event.Data.(type) {
	case *types.TextChunkEvent:
		return types.EngineEvent{Type: "engine_text_delta", TextDelta: e.Text}

	case *types.ToolCallEvent:
		return types.EngineEvent{Type: "engine_tool_start", ToolName: e.ToolName, ToolID: e.ToolID}

	case *types.ToolCallUpdateEvent:
		return types.EngineEvent{Type: "engine_tool_update", ToolID: e.ToolID, ToolPartialInput: e.PartialInput}

	case *types.ToolCallCompleteEvent:
		idx := e.Index
		return types.EngineEvent{Type: "engine_tool_complete", ToolIndex: &idx}

	case *types.ToolResultEvent:
		return types.EngineEvent{Type: "engine_tool_end", ToolName: "", ToolID: e.ToolID, ToolResult: e.Content, ToolIsError: e.IsError}

	case *types.TaskCompleteEvent:
		return types.EngineEvent{
			Type: "engine_status",
			Fields: &types.StatusFields{
				State:             "idle",
				SessionID:         e.SessionID,
				TotalCostUsd:      e.CostUsd,
				ContextWindow:     contextWindow,
				PermissionDenials: e.PermissionDenials,
			},
		}

	case *types.ErrorEvent:
		return types.EngineEvent{
			Type:          "engine_error",
			EventMessage:  e.ErrorMessage,
			ErrorCode:     e.ErrorCode,
			ErrorCategory: string(classifyErrorCategory(e.ErrorCode)),
			Retryable:     e.Retryable,
			RetryAfterMs:  e.RetryAfterMs,
			HttpStatus:    e.HttpStatus,
		}

	case *types.UsageEvent:
		var pct int
		if e.Usage.InputTokens != nil {
			window := contextWindow
			if window <= 0 {
				window = conversation.DefaultContext
			}
			pct = *e.Usage.InputTokens * 100 / window
			if pct > 100 {
				pct = 100
			}
		}
		return types.EngineEvent{
			Type: "engine_message_end",
			EndUsage: &types.MessageEndUsage{
				InputTokens:    derefInt(e.Usage.InputTokens),
				OutputTokens:   derefInt(e.Usage.OutputTokens),
				ContextPercent: pct,
			},
		}

	case *types.SessionDeadEvent:
		return types.EngineEvent{
			Type:       "engine_dead",
			ExitCode:   e.ExitCode,
			Signal:     e.Signal,
			StderrTail: e.StderrTail,
		}

	case *types.PermissionRequestEvent:
		return types.EngineEvent{
			Type:          "engine_permission_request",
			QuestionID:    e.QuestionID,
			PermToolName:  e.ToolName,
			PermToolDesc:  e.ToolDescription,
			PermToolInput: e.ToolInput,
			PermOptions:   e.Options,
		}

	case *types.PlanModeChangedEvent:
		return types.EngineEvent{
			Type:             "engine_plan_mode_changed",
			PlanModeEnabled:  e.Enabled,
			PlanModeFilePath: e.PlanFilePath,
		}

	case *types.StreamResetEvent:
		return types.EngineEvent{Type: "engine_stream_reset"}

	case *types.CompactingEvent:
		return types.EngineEvent{Type: "engine_compacting", CompactingActive: e.Active}

	default:
		return types.EngineEvent{}
	}
}
