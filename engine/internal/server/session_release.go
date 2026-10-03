package server

import (
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wireSessionRelease evicts the command lane of a session the engine released
// on its own. That teardown arrives without a stop_session command, so the
// eviction the stop_session handler performs has to happen here instead.
func (s *Server) wireSessionRelease(mgr *session.Manager) {
	mgr.OnSessionReleased(func(key, reason string) {
		s.lanes.evictSession(key)
		utils.LogWithFields(utils.LevelDebug, "server", "evicted lane for released session", map[string]any{"session_id": key, "reason": reason})
	})
}
