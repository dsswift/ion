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
		s.planFilePath = ""
		s.planModePromptSent = false
	}
	utils.Info("PlanMode", fmt.Sprintf("key=%s enabled=%v was=%v source=%s tools=%v", key, enabled, was, source, allowedTools))
}

// generatePlanID returns a random hex string for plan file naming.
func generatePlanID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}
