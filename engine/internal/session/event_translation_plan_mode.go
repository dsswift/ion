package session

// event_translation_plan_mode.go — the plan-mode side effects of a normalized
// event, split out of event_translation.go's handleNormalizedEvent.
//
// These run on the manager (not in the pure translateToEngineEvent) because
// each one writes session state: the reentry flag SendPrompt reads, the
// planFilePath the next run inherits, and the plan marker persistCliTurn
// appends. Keeping them in one function keeps the plan-mode state machine
// readable in one place instead of interleaved with usage accounting and hook
// firing.

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// applyPlanModeSideEffects updates session plan-mode state from one normalized
// event. Called from handleNormalizedEvent for every event; each branch is a
// no-op for events it does not match.
func (m *Manager) applyPlanModeSideEffects(key string, event types.NormalizedEvent) {
	// Track plan mode changes so re-entering plan mode triggers reentry
	// detection in SendPrompt. We do this here (rather than in the pure
	// translateToEngineEvent) because we need access to the session manager.
	if pmc, ok := event.Data.(*types.PlanModeChangedEvent); ok {
		if !pmc.Enabled {
			// Model called ExitPlanMode: record the exit so that if the
			// session is later re-entered into plan mode, the reentry
			// prompt fires.
			m.MarkPlanModeExited(key)
		} else if pmc.PlanFilePath != "" {
			// Model called EnterPlanMode: keep the manager's session state in
			// sync with the run's state so the next SendPrompt sees the correct
			// planFilePath and planMode flag. Without this the manager's view
			// diverges from the backend run's view across run boundaries.
			m.mu.Lock()
			if s2, ok2 := m.sessions[key]; ok2 {
				s2.planMode = true
				s2.planFilePath = pmc.PlanFilePath
				utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "event_translation: model entered plan mode", map[string]any{"key": key, "plan_file_path": pmc.PlanFilePath})
			}
			m.mu.Unlock()
		}
	}

	// Per ADR-003, the model calling ExitPlanMode surfaces as a
	// PlanProposalEvent{Kind:"exit"} (a workflow proposal), NOT a
	// PlanModeChangedEvent{Enabled:false} (a confirmed state change). The
	// CLI backend emits this on the model's ExitPlanMode tool call, and the
	// API backend emits it from interceptExitPlanMode. Record the exit so
	// reentry detection fires when plan mode is re-enabled — mirroring the
	// PlanModeChangedEvent{Enabled:false} branch above. Idempotent with the
	// SetPlanMode(false) user-approval chokepoint path (both set
	// hasExitedPlanMode=true).
	if pp, ok := event.Data.(*types.PlanProposalEvent); ok && pp.Kind == "exit" {
		m.MarkPlanModeExited(key)
	}

	// Record a delegated-CLI run's plan-file write so persistCliTurn appends
	// the matching EntryPlanMarker when it writes the turn. A delegated CLI
	// captures its plan natively (plan_capture.go) and emits this event, but
	// owns no conversation, so nothing wrote the marker and the tree carried
	// no record that a plan existed. The engine-owned ApiBackend appends its
	// own marker inline against run.conv and never reaches persistCliTurn, so
	// gating on an active CLI recorder keeps exactly one writer per backend.
	if pfw, ok := event.Data.(*types.PlanFileWrittenEvent); ok && pfw.PlanFilePath != "" {
		slug := pfw.PlanSlug
		if slug == "" {
			slug = types.PlanSlugFromPath(pfw.PlanFilePath)
		}
		m.mu.Lock()
		if s2, ok2 := m.sessions[key]; ok2 && s2.cliTranscript != nil {
			s2.pendingCliPlanMarker = &conversation.PlanMarkerData{
				Operation:    pfw.Operation,
				PlanFilePath: pfw.PlanFilePath,
				PlanSlug:     slug,
			}
			utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "recorded delegated-CLI plan marker for turn persistence", map[string]any{
				"key": key, "plan_file_path": pfw.PlanFilePath, "plan_slug": slug, "operation": pfw.Operation,
			})
		} else {
			utils.LogWithFields(utils.LevelDebug, "session.plan_mode", "plan file written outside a delegated-CLI run, marker written by the backend", map[string]any{
				"key": key, "plan_file_path": pfw.PlanFilePath, "plan_slug": slug, "session_live": ok2,
			})
		}
		m.mu.Unlock()
	}
}
