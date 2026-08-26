package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// temporaryAutoPlanWorkflow keeps a plan-mode conversation intact while one
// command deliberately uses the auto-mode tool set. It is session-owned because
// a user question ends one run but does not end the command workflow.
type temporaryAutoPlanWorkflow struct {
	runID        string
	planFile     string
	awaitingUser bool
	awaitingWork bool
}

func (m *Manager) beginTemporaryAutoPlanWorkflow(s *engineSession, key, runID, planFile string) {
	if !s.planMode || planFile == "" {
		utils.LogWithFields(utils.LevelWarn, "session.plan_mode", "temporary auto plan workflow refused", map[string]any{"key": key, "run_id": runID, "plan_file": planFile, "plan_mode": s.planMode})
		return
	}
	if s.temporaryAutoPlan != nil && s.temporaryAutoPlan.planFile == planFile {
		s.temporaryAutoPlan.runID = runID
		s.temporaryAutoPlan.awaitingUser = false
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "temporary auto plan workflow resumed", map[string]any{"key": key, "run_id": runID, "plan_file": planFile})
		return
	}
	s.temporaryAutoPlan = &temporaryAutoPlanWorkflow{runID: runID, planFile: planFile}
	utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "temporary auto plan workflow started", map[string]any{"key": key, "run_id": runID, "plan_file": planFile})
}

// completeTemporaryAutoPlanWorkflow enriches the terminal event before it is
// translated. This keeps every backend on the same approval-card contract.
func (m *Manager) completeTemporaryAutoPlanWorkflow(key, runID string, event *types.TaskCompleteEvent) []types.NormalizedEvent {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok || s.temporaryAutoPlan == nil || s.temporaryAutoPlan.runID != runID {
		m.mu.Unlock()
		return nil
	}
	workflow := s.temporaryAutoPlan
	if hasPendingSessionWorkLocked(s, runID) {
		workflow.awaitingWork = true
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "temporary auto plan workflow waiting for background work", map[string]any{"key": key, "run_id": runID, "plan_file": workflow.planFile})
		return nil
	}
	if hasHumanWaitDenial(s, event.PermissionDenials) {
		workflow.awaitingUser = true
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "temporary auto plan workflow waiting for user", map[string]any{"key": key, "run_id": runID, "plan_file": workflow.planFile})
		return nil
	}
	if hasExitPlanDenial(event.PermissionDenials) {
		s.temporaryAutoPlan = nil
		m.mu.Unlock()
		return nil
	}
	if event.Reason != types.TaskCompletionReasonNormal || workflow.planFile == "" {
		s.temporaryAutoPlan = nil
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "temporary auto plan workflow ended without proposal", map[string]any{"key": key, "run_id": runID, "reason": event.Reason})
		return nil
	}
	info := extension.BeforePlanModeAutoExitInfo{SessionID: s.conversationID, RunID: runID, StopReason: "temporary_auto_complete", PlanFilePath: workflow.planFile}
	extGroup := s.extGroup
	m.mu.Unlock()

	suppress, path, reason := false, "", ""
	if extGroup != nil && !extGroup.IsEmpty() {
		ctx := m.newExtContextForKey(key)
		suppress, path, reason = extGroup.FireBeforePlanModeAutoExit(ctx, info)
	}
	if suppress {
		m.mu.Lock()
		if s2, ok := m.sessions[key]; ok && s2.temporaryAutoPlan == workflow {
			s2.temporaryAutoPlan = nil
		}
		m.mu.Unlock()
		return nil
	}
	if path != "" {
		workflow.planFile = path
	}
	if reason == "" {
		reason = "engine-synthesized: temporary auto-mode command completed in plan workflow"
	}
	denial := types.PermissionDenial{ToolName: "ExitPlanMode", ToolUseID: fmt.Sprintf("synth-temporary-plan-%s", runID), ToolInput: map[string]any{"planFilePath": workflow.planFile, "synthesized": true, "reason": reason}}
	event.PermissionDenials = append(event.PermissionDenials, denial)
	m.mu.Lock()
	if s2, ok := m.sessions[key]; ok && s2.temporaryAutoPlan == workflow {
		s2.temporaryAutoPlan = nil
	}
	m.mu.Unlock()
	return []types.NormalizedEvent{
		{Data: &types.PlanModeAutoExitEvent{SessionID: info.SessionID, RunID: runID, StopReason: info.StopReason, PlanFilePath: workflow.planFile, PlanSlug: types.PlanSlugFromPath(workflow.planFile), Reason: reason}},
		{Data: &types.PlanProposalEvent{Kind: "exit", PlanFilePath: workflow.planFile, PlanSlug: types.PlanSlugFromPath(workflow.planFile)}},
	}
}

func hasPendingSessionWorkLocked(s *engineSession, completingRunID string) bool {
	if s.dispatchRegistry != nil && len(s.dispatchRegistry.ActiveIDs()) > 0 {
		return true
	}
	return len(s.outstandingBackgroundTasks) > 0 ||
		len(s.rootDispatchCompletions) > 0 ||
		len(s.pendingBackgroundCompletions) > 0 ||
		len(s.promptQueue) > 0 ||
		(s.requestID != "" && s.requestID != completingRunID)
}

// inheritTemporaryAutoPlanWorkflow extends a command workflow across engine-
// owned child/background continuations. An ordinary user prompt does not inherit.
func (m *Manager) inheritTemporaryAutoPlanWorkflow(s *engineSession, key string, opts *types.RunOptions) {
	workflow := s.temporaryAutoPlan
	if workflow == nil || !workflow.awaitingWork || opts.BackgroundWork == nil {
		return
	}
	opts.TemporaryAutoFromPlan = true
	workflow.awaitingWork = false
	utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "temporary auto plan workflow continuing with background result", map[string]any{"key": key, "plan_file": workflow.planFile})
}

func hasHumanWaitDenial(s *engineSession, denials []types.PermissionDenial) bool {
	for _, denial := range denials {
		if denial.ToolName == "AskUserQuestion" || denial.ToolName == "AskUserQuestions" {
			return true
		}
		if s.config.ToolGate != nil {
			for _, tool := range s.config.ToolGate.ClientTools {
				if tool.HumanWait && tool.Name == denial.ToolName {
					return true
				}
			}
		}
	}
	return false
}
func hasExitPlanDenial(denials []types.PermissionDenial) bool {
	for _, denial := range denials {
		if denial.ToolName == "ExitPlanMode" {
			return true
		}
	}
	return false
}

func (m *Manager) clearTemporaryAutoPlanOnAbnormalExitLocked(s *engineSession, key, runID string, code *int, signal *string) {
	if s.temporaryAutoPlan == nil || s.temporaryAutoPlan.runID != runID ||
		((code == nil || *code == 0) && signal == nil) {
		return
	}
	codeValue, signalValue := "nil", "nil"
	if code != nil {
		codeValue = fmt.Sprintf("%d", *code)
	}
	if signal != nil {
		signalValue = *signal
	}
	utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "temporary auto plan workflow cleared on abnormal exit", map[string]any{"key": key, "run_id": runID, "code": codeValue, "signal": signalValue})
	s.temporaryAutoPlan = nil
}

func (m *Manager) applyTemporaryAutoPlanCompletion(runID, key string, event types.NormalizedEvent) {
	complete, ok := event.Data.(*types.TaskCompleteEvent)
	if !ok {
		return
	}
	for _, synthesized := range m.completeTemporaryAutoPlanWorkflow(key, runID, complete) {
		m.handleNormalizedEvent(runID, synthesized)
	}
}
