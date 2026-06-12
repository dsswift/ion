package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SetPlanMode enables or disables plan mode for a session.
func (m *Manager) SetPlanMode(key string, enabled bool, allowedTools []string, source string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[key]
	if !ok {
		utils.Debug("Session", fmt.Sprintf("SetPlanMode: session %q not found (not yet started?)", key))
		return
	}
	was := s.planMode
	s.planMode = enabled
	s.planModeTools = allowedTools
	if !enabled {
		// Preserve planFilePath across any harness-initiated disable. The
		// plan ID is only retired when the engine session itself is
		// replaced — which happens via resetTabSession() when a consumer
		// signals implementation start. That creates a fresh engineSession
		// with planFilePath="" and a new slug is generated for the next
		// plan.
		//
		// We also mark hasExitedPlanMode=true whenever we disable with a
		// non-empty path so that reentry detection in SendPrompt fires
		// (planModeReentry := s.planMode && s.planFilePath != "" &&
		// s.hasExitedPlanMode), even when the harness toggled plan mode
		// off through SetPlanMode rather than the model calling
		// ExitPlanMode.
		if s.planFilePath != "" {
			s.hasExitedPlanMode = true
		}
		s.planModePromptSent = false
	}
	utils.Info("PlanMode", fmt.Sprintf("key=%s enabled=%v was=%v source=%s tools=%v hasExited=%v planFile=%s",
		key, enabled, was, source, allowedTools, s.hasExitedPlanMode, s.planFilePath))
}

// MarkPlanModeExited records that the session has exited plan mode via
// ExitPlanMode at least once. This enables reentry detection: when plan mode
// is re-enabled and the plan file still exists, SendPrompt sets
// PlanModeReentry on RunOptions so the prompt builder can emit reentry-specific
// guidance.
func (m *Manager) MarkPlanModeExited(key string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[key]
	if !ok {
		utils.Debug("Session", fmt.Sprintf("MarkPlanModeExited: session %q not found", key))
		return
	}
	s.hasExitedPlanMode = true
	utils.Info("PlanMode", fmt.Sprintf("key=%s marked plan mode exited, planFile=%s", key, s.planFilePath))
}

// RequestPlanModeEnter is called by the runloop when the model invokes the
// EnterPlanMode sentinel tool. It fires the before_plan_mode_enter hook to
// give SDK extensions the opportunity to veto the transition, then (if
// allowed) flips the session into plan mode and ensures a planFilePath exists.
//
// Returns:
//   - allowed: whether plan mode entry was permitted
//   - reason:  denial reason (empty when allowed)
//   - planFilePath: the (new or reused) plan file path (empty when denied)
func (m *Manager) RequestPlanModeEnter(key string) (allowed bool, reason string, planFilePath string) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		utils.Debug("Session", fmt.Sprintf("RequestPlanModeEnter: session %q not found", key))
		return false, "session not found", ""
	}
	if s.planMode {
		existingPath := s.planFilePath
		m.mu.Unlock()
		utils.Debug("Session", fmt.Sprintf("RequestPlanModeEnter: session %q already in plan mode, path=%s", key, existingPath))
		return false, "already in plan mode", existingPath
	}

	// Snapshot what we need for the hook call before releasing the lock.
	extGroup := s.extGroup
	workDir := s.config.WorkingDirectory
	m.mu.Unlock()

	// Fire before_plan_mode_enter hook (outside the lock — hook handlers must
	// not call back into the manager under lock or a deadlock results).
	if extGroup != nil && !extGroup.IsEmpty() {
		ctx := m.newExtContextForKey(key)
		a, r := extGroup.FireBeforePlanModeEnter(ctx, extension.PlanModeEnterInfo{Source: "model_tool"})
		if !a {
			utils.Info("PlanMode", fmt.Sprintf("RequestPlanModeEnter: key=%s denied by hook reason=%q", key, r))
			return false, r, ""
		}
	}

	// Hook allowed (or no hooks registered). Flip the session.
	m.mu.Lock()
	s, ok = m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return false, "session not found", ""
	}
	// Re-check in case another goroutine already flipped plan mode between
	// the unlock above and this re-lock.
	if s.planMode {
		path := s.planFilePath
		m.mu.Unlock()
		return true, "", path
	}
	s.planMode = true

	// Allocate a plan file path if the session doesn't have one yet (new
	// planning session). Reuse the existing path when Part 1 preserved it
	// from a previous exit — this is what ensures the model continues the
	// same plan rather than starting a fresh one.
	if s.planFilePath == "" {
		s.planFilePath = allocateNewPlanFilePath(m.backend, workDir)
		utils.Info("PlanMode", fmt.Sprintf("RequestPlanModeEnter: key=%s allocated new planFile=%s", key, s.planFilePath))
	} else {
		utils.Info("PlanMode", fmt.Sprintf("RequestPlanModeEnter: key=%s reusing planFile=%s", key, s.planFilePath))
	}
	path := s.planFilePath
	m.mu.Unlock()

	utils.Info("PlanMode", fmt.Sprintf("RequestPlanModeEnter: key=%s allowed=true planFile=%s", key, path))
	return true, "", path
}

// newExtContextForKey returns an extension Context for hook calls that happen
// outside of a normal SendPrompt dispatch (e.g. mid-run tool interception).
func (m *Manager) newExtContextForKey(key string) *extension.Context {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return &extension.Context{SessionKey: key}
	}
	return m.newExtContext(s, key)
}

// RequestPlanModeExit is called by the runloop when the model invokes the
// ExitPlanMode sentinel tool. It fires the before_plan_mode_exit hook so SDK
// extensions can veto (e.g. if the plan is incomplete). If allowed, it returns
// (true, "", planFilePath) and the caller proceeds to terminate the run and
// surface the plan-ready card. If denied, it returns (false, reason, "")
// and the caller sends reason back to the model as the tool result.
func (m *Manager) RequestPlanModeExit(key string, planFilePath string) (allowed bool, reason string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.Debug("Session", fmt.Sprintf("RequestPlanModeExit: session %q not found", key))
		return true, "" // unknown session: let the exit proceed to avoid blocking
	}
	extGroup := s.extGroup
	m.mu.RUnlock()

	if extGroup == nil || extGroup.IsEmpty() {
		utils.Debug("Session", fmt.Sprintf("RequestPlanModeExit: key=%s no extensions, auto-allow", key))
		return true, ""
	}

	ctx := m.newExtContextForKey(key)
	a, r := extGroup.FireBeforePlanModeExit(ctx, extension.BeforePlanModeExitInfo{
		PlanFilePath: planFilePath,
		Source:       "model_tool",
	})
	if !a {
		utils.Info("PlanMode", fmt.Sprintf("RequestPlanModeExit: key=%s denied by hook reason=%q", key, r))
	} else {
		utils.Debug("Session", fmt.Sprintf("RequestPlanModeExit: key=%s allowed", key))
	}
	return a, r
}

// RequestPlanModeAutoExit is called by the runloop just before it
// synthesizes a deterministic ExitPlanMode at end-of-turn (the safety
// net for "model ended plan-mode turn without calling ExitPlanMode").
// It fires the before_plan_mode_auto_exit hook so SDK extensions can
// observe the synthesis decision, suppress it, override the
// PlanFilePath used in the synthesized PermissionDenial, or override
// the human-readable Reason recorded on the denial / emitted on
// PlanModeAutoExitEvent.
//
// Returns (suppress, planFilePathOverride, reasonOverride). When the
// session is unknown or has no extensions wired, returns
// (false, "", "") so the engine proceeds with its defaults.
func (m *Manager) RequestPlanModeAutoExit(
	key string, info extension.BeforePlanModeAutoExitInfo,
) (suppress bool, planFilePathOverride, reasonOverride string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.Debug("Session", fmt.Sprintf("RequestPlanModeAutoExit: session %q not found — proceeding with defaults", key))
		return false, "", ""
	}
	extGroup := s.extGroup
	m.mu.RUnlock()

	if extGroup == nil || extGroup.IsEmpty() {
		utils.Debug("Session", fmt.Sprintf("RequestPlanModeAutoExit: key=%s no extensions — proceeding with defaults", key))
		return false, "", ""
	}

	ctx := m.newExtContextForKey(key)
	sp, pf, rs := extGroup.FireBeforePlanModeAutoExit(ctx, info)
	if sp {
		utils.Info("PlanMode", fmt.Sprintf("RequestPlanModeAutoExit: key=%s synthesis suppressed by hook", key))
	} else if pf != "" || rs != "" {
		utils.Info("PlanMode", fmt.Sprintf(
			"RequestPlanModeAutoExit: key=%s hook overrides path=%q reason=%q",
			key, pf, rs,
		))
	} else {
		utils.Debug("Session", fmt.Sprintf("RequestPlanModeAutoExit: key=%s no hook opinion", key))
	}
	return sp, pf, rs
}

// SetPlanModeBashAllowlist sets the allowed Bash command prefixes for plan mode.
// When non-empty, the Bash tool is included in plan-mode runs and only commands
// matching one of these prefixes are permitted. Called by the server after
// SetPlanMode when the client supplies planModeAllowedBashCommands.
func (m *Manager) SetPlanModeBashAllowlist(key string, cmds []string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[key]
	if !ok {
		// The wire command targeted a session that does not exist.
		// This is an invariant violation: the client should never
		// reference an unknown session key. Logged at Error level per
		// the logging-policy taxonomy ("unexpected failures, caught
		// panics, invariant violations") so it always reaches the
		// engine log and is searchable when investigating client bugs.
		utils.Error("Session", fmt.Sprintf("SetPlanModeBashAllowlist: session %q not found (invariant violation — wire command targeted unknown session)", key))
		return
	}
	s.planModeAllowedBashCommands = cmds
	utils.Info("PlanMode", fmt.Sprintf("key=%s bash_allowlist=%v", key, cmds))
}

// GetPlanModeState returns the current plan mode state for a session.
// Returns (planMode, planFilePath). Safe to call from any goroutine.
func (m *Manager) GetPlanModeState(key string) (enabled bool, planFilePath string) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[key]
	if !ok {
		return false, ""
	}
	return s.planMode, s.planFilePath
}
