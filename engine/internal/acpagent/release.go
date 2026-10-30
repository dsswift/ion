package acpagent

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// markReleased records that the engine released the session on its own. The
// client still holds the session id, and the key's conversation binding
// survives the release, so the session is reopened on its next use rather
// than reported gone.
func (s *Session) markReleased(e map[string]any) {
	s.mu.Lock()
	s.released = true
	s.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "acp", "engine released session", map[string]any{"session_id": s.id, "reason": str(e, "sessionReleaseReason"), "conversation_id": str(e, "sessionReleaseConversationId")})
}

// ensureOpen reopens a released session on its bound conversation and
// restores the plan mode the client last set. A live session is left alone.
func (s *Session) ensureOpen(ctx context.Context) error {
	s.reopenMu.Lock()
	defer s.reopenMu.Unlock()
	s.mu.Lock()
	released, planMode := s.released, s.planMode
	s.mu.Unlock()
	if !released {
		return nil
	}
	if err := s.open(ctx, true); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "reopen released session failed", map[string]any{"session_id": s.id, "error": err.Error()})
		return fmt.Errorf("reopen released session: %w", err)
	}
	if planMode {
		modeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, err := s.agent.engine.Send(modeCtx, map[string]any{"cmd": "set_plan_mode", "key": s.id, "enabled": true})
		cancel()
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "acp", "restore plan mode after reopen failed", map[string]any{"session_id": s.id, "error": err.Error()})
			return fmt.Errorf("restore plan mode: %w", err)
		}
	}
	s.mu.Lock()
	s.released = false
	s.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "acp", "released session reopened", map[string]any{"session_id": s.id, "plan_mode": planMode})
	return nil
}
