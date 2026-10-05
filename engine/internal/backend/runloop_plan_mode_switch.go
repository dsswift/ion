package backend

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Plan-mode sources carried on PlanModeChangedEvent.Source and on the
// before_plan_mode_enter / before_plan_mode_exit hook payloads.
const (
	PlanModeSourceModelTool = "model_tool" // the model called EnterPlanMode / ExitPlanMode
	PlanModeSourceWire      = "wire"       // a client sent set_plan_mode
	PlanModeSourceExtension = "extension"  // an extension called ctx.enterPlanMode / exitPlanMode
)

// applyPlanModeTransition flips the live run's plan-mode state. The model's
// EnterPlanMode tool and an external switch (SetRunPlanMode) both call it, so
// the two paths cannot drift. Entering latches the plan file. The plan policy
// applies from the next tool call, and the matching plan-mode notice follows
// at the top of the next turn, because reconcilePlanMode compares run.planMode
// with what the model was last told.
func (r *activeRun) applyPlanModeTransition(enabled bool, planFilePath string) {
	r.mu.Lock()
	r.planMode = enabled
	if enabled {
		r.planFilePath = planFilePath
	}
	r.mu.Unlock()
}

func planModeChangedEvent(enabled bool, planFilePath, source string) types.NormalizedEvent {
	return types.NormalizedEvent{Data: &types.PlanModeChangedEvent{
		Enabled:      enabled,
		PlanFilePath: planFilePath,
		PlanSlug:     types.PlanSlugFromPath(planFilePath),
		Source:       source,
	}}
}

// SetRunPlanMode switches a live run into or out of plan mode from outside
// the run (a client toggle, an extension call), so the change takes effect
// in the current turn instead of the next one. It emits PlanModeChangedEvent
// with the given source. Returns false when no run with requestID is live.
func (b *ApiBackend) SetRunPlanMode(requestID string, enabled bool, planFilePath, source string) bool {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "live plan-mode switch skipped: no active run", map[string]any{"run_id": requestID, "enabled": enabled, "source": source})
		return false
	}
	run.applyPlanModeTransition(enabled, planFilePath)
	b.emit(run, planModeChangedEvent(enabled, planFilePath, source))
	utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "live plan-mode switch applied", map[string]any{"run_id": requestID, "enabled": enabled, "source": source, "plan_file": planFilePath})
	return true
}

// SetRunPlanMode forwards to the API-routed inner backend. A run routed to a
// delegated CLI cannot be switched mid-turn and returns false; its session
// state still changes and the next run starts in the new mode.
func (h *HybridBackend) SetRunPlanMode(requestID string, enabled bool, planFilePath, source string) bool {
	inner, kind := h.lookup(requestID)
	api, ok := inner.(*ApiBackend)
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "live plan-mode switch skipped: run is not API-routed", map[string]any{"run_id": requestID, "kind": kind})
		return false
	}
	return api.SetRunPlanMode(requestID, enabled, planFilePath, source)
}
