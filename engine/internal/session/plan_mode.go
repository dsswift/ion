package session

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"

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
		// Preserve planFilePath when the plan was previously exited via
		// ExitPlanMode so that re-entering plan mode reuses the same file
		// and triggers reentry detection in SendPrompt.
		if !s.hasExitedPlanMode {
			s.planFilePath = ""
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

// generatePlanID returns a random hex string for plan file naming.
func generatePlanID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
