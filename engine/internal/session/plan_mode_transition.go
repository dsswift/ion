package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// PlanModeTransitionRequest asks TransitionPlanMode to change a session's
// plan mode.
type PlanModeTransitionRequest struct {
	Enabled bool
	// Source is backend.PlanModeSourceWire or backend.PlanModeSourceExtension.
	// It rides the hook payloads and the resulting events.
	Source string
	// AllowedTools, ClientSource, and RestorePlanFilePath carry the existing
	// set_plan_mode fields through to the session state unchanged.
	AllowedTools        []string
	ClientSource        string
	RestorePlanFilePath string
}

// PlanModeTransitionResult reports what TransitionPlanMode did.
type PlanModeTransitionResult struct {
	// Allowed is false when a hook vetoed the change or the session is unknown.
	Allowed bool `json:"allowed"`
	// Changed is true when the session's mode actually flipped. A request for
	// the mode the session is already in is allowed and unchanged.
	Changed bool   `json:"changed"`
	Reason  string `json:"reason,omitempty"`
	// PlanFilePath is the session's plan file after the request.
	PlanFilePath string `json:"planFilePath,omitempty"`
	// LiveRun is true when the change reached an in-flight run, so the
	// current turn already runs in the new mode.
	LiveRun bool `json:"liveRun"`
}

// TransitionPlanMode is the one path for a client's or an extension's
// plan-mode change. In order:
//
//  1. A request for the mode the session is already in applies its fields
//     and returns. No hook fires and no event is emitted.
//  2. The before_plan_mode_enter or before_plan_mode_exit hook fires with the
//     request's Source, unless one is already running for this session (a
//     handler calling ctx.enterPlanMode), in which case the change goes
//     through without firing it again.
//  3. A veto stops the change and emits PlanModeChangeRejectedEvent with the
//     handler's reason. The veto binds every source, a user's toggle included.
//  4. The session flips. Entering during a live run allocates a plan file if
//     the session has none; otherwise the next prompt allocates it.
//  5. A live API run is switched too, so the change applies to the current
//     turn. Otherwise the session emits PlanModeChangedEvent itself and the
//     next run starts in the new mode.
func (m *Manager) TransitionPlanMode(key string, req PlanModeTransitionRequest) PlanModeTransitionResult {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "plan-mode transition ignored: session not found", map[string]any{"key": key, "source": req.Source})
		return PlanModeTransitionResult{Reason: "session not found"}
	}
	if s.planMode == req.Enabled {
		setPlanModeLocked(s, key, req.Enabled, req.AllowedTools, req.ClientSource, req.RestorePlanFilePath)
		path := s.planFilePath
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "plan-mode transition is a no-op: already in requested mode", map[string]any{"key": key, "enabled": req.Enabled, "source": req.Source})
		return PlanModeTransitionResult{Allowed: true, PlanFilePath: path}
	}
	extGroup := s.extGroup
	currentPath := s.planFilePath
	reentrant := s.planModeHookDispatching
	m.mu.Unlock()

	if allowed, reason := m.firePlanModeTransitionHook(key, extGroup, req, currentPath, reentrant); !allowed {
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "plan-mode transition vetoed by hook", map[string]any{"key": key, "enabled": req.Enabled, "source": req.Source, "reason": reason})
		m.emit(key, translateToEngineEvent(types.NormalizedEvent{Data: &types.PlanModeChangeRejectedEvent{
			RequestedEnabled: req.Enabled, Source: req.Source, Reason: reason,
		}}, 0))
		return PlanModeTransitionResult{Reason: reason, PlanFilePath: currentPath}
	}

	m.mu.Lock()
	s, ok = m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return PlanModeTransitionResult{Reason: "session not found"}
	}
	if s.planMode == req.Enabled {
		// Another path (a re-entrant handler call) already made the change.
		path := s.planFilePath
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "plan-mode transition already applied while the hook ran", map[string]any{"key": key, "enabled": req.Enabled, "source": req.Source})
		return PlanModeTransitionResult{Allowed: true, PlanFilePath: path}
	}
	setPlanModeLocked(s, key, req.Enabled, req.AllowedTools, req.ClientSource, req.RestorePlanFilePath)
	// A live run needs a plan file now. Without one, allocation waits for
	// the next prompt, as it always has (prompt_dispatch allocates then).
	if req.Enabled && s.planFilePath == "" && s.requestID != "" {
		caps := m.resolvedBackend(s.lastModel).Capabilities()
		s.planFilePath = allocateNewPlanFilePath(caps, s.config.WorkingDirectory, s.conversationID)
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "plan-mode transition allocated a plan file", map[string]any{"key": key, "plan_file_path": s.planFilePath})
	}
	path := s.planFilePath
	requestID := s.requestID
	m.mu.Unlock()

	live := false
	if requestID != "" {
		if sw, ok := m.backend.(planModeSwitchable); ok {
			live = sw.SetRunPlanMode(requestID, req.Enabled, path, req.Source)
		} else {
			utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "backend cannot switch a live run; change applies next run", map[string]any{"key": key, "run_id": requestID})
		}
	}
	if !live {
		m.emit(key, translateToEngineEvent(types.NormalizedEvent{Data: &types.PlanModeChangedEvent{
			Enabled: req.Enabled, PlanFilePath: path, PlanSlug: types.PlanSlugFromPath(path), Source: req.Source,
		}}, 0))
	}
	utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "plan-mode transition applied", map[string]any{"key": key, "enabled": req.Enabled, "source": req.Source, "live_run": live, "plan_file_path": path})
	return PlanModeTransitionResult{Allowed: true, Changed: true, PlanFilePath: path, LiveRun: live}
}

// firePlanModeTransitionHook fires the before-hook for a transition and
// reports whether it may proceed. reentrant means a plan-mode hook is already
// running for this session; the hook is then skipped (and logged) rather than
// fired again from inside itself.
func (m *Manager) firePlanModeTransitionHook(key string, extGroup *extension.ExtensionGroup, req PlanModeTransitionRequest, currentPath string, reentrant bool) (bool, string) {
	if reentrant {
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "plan-mode hook suppressed: one is already running for this session", map[string]any{"key": key, "enabled": req.Enabled, "source": req.Source})
		return true, ""
	}
	if extGroup == nil || extGroup.IsEmpty() {
		return true, ""
	}
	var allowed bool
	var reason string
	m.withPlanModeHookDispatching(key, func() {
		ctx := m.newExtContextForKey(key)
		if req.Enabled {
			allowed, reason = extGroup.FireBeforePlanModeEnter(ctx, extension.PlanModeEnterInfo{Source: req.Source, ClientSource: req.ClientSource})
		} else {
			allowed, reason = extGroup.FireBeforePlanModeExit(ctx, extension.BeforePlanModeExitInfo{PlanFilePath: currentPath, Source: req.Source, ClientSource: req.ClientSource})
		}
	})
	return allowed, reason
}

// withPlanModeHookDispatching marks a plan-mode hook as running for the
// session while fn runs, so a re-entrant change request does not fire it
// again. Every plan-mode before-hook dispatch goes through here.
func (m *Manager) withPlanModeHookDispatching(key string, fn func()) {
	m.mu.Lock()
	if s, ok := m.sessions[key]; ok {
		s.planModeHookDispatching = true
	}
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		if s, ok := m.sessions[key]; ok {
			s.planModeHookDispatching = false
		}
		m.mu.Unlock()
	}()
	fn()
}

// Compile-time proof that the production backends can switch a live run.
var (
	_ planModeSwitchable = (*backend.ApiBackend)(nil)
	_ planModeSwitchable = (*backend.HybridBackend)(nil)
)
