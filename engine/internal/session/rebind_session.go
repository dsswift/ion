package session

// rebindSession — conversation-identity rebinding for pre-minted sessions.
// Extracted from start_session.go for the file-size cap.

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/utils"
)

// rebindSession changes an idle session's conversation identity to a different
// (existing) conversation. Used when the desktop restarts and asserts the real
// conversation ID on a session that was pre-minted before the client connected.
// The caller must verify: (a) the target conversation file exists on disk,
// (b) no run is in flight (s.requestID == ""). (#270)
func (m *Manager) rebindSession(s *engineSession, key, newConvID string) {
	m.mu.Lock()
	oldConvID := s.conversationID
	s.conversationID = newConvID
	s.bindingPending = false
	m.mu.Unlock()

	saveBinding(bindingsPath(), key, newConvID)

	// Re-seed model and context usage from the target conversation so the
	// next status snapshot carries correct values. Same gate split as
	// StartSession: an empty header model must not suppress the context
	// seed, or every delegated-CLI conversation rebinds to 0%.
	convModel, mErr := conversation.LoadLlmHeaderModel(newConvID, "")
	if mErr != nil {
		utils.LogWithFields(utils.LevelDebug, "session", "rebindsession: no header model on target conversation", map[string]any{"key": key, "conversation_id": newConvID, "error": mErr})
	}
	m.mu.RLock()
	retainedModel := s.lastModel
	m.mu.RUnlock()
	windowModel := convModel
	if windowModel == "" {
		windowModel = retainedModel
	}
	if windowModel == "" && m.config != nil {
		windowModel = m.config.DefaultModel
	}
	ctxWindow := conversation.DefaultContext
	if info := providers.GetModelInfo(windowModel); info != nil && info.ContextWindow > 0 {
		ctxWindow = info.ContextWindow
	}
	if conv, lerr := conversation.Load(newConvID, ""); lerr == nil {
		usage := conversation.GetContextUsage(conv, ctxWindow)
		m.mu.Lock()
		if convModel != "" {
			s.setCurrentModel(convModel)
		}
		s.lastContextWindow = ctxWindow
		s.lastContextTokens = usage.Tokens
		s.lastContextPct = usage.Percent
		updateContextCapacityLocked(s, windowModel, ctxWindow, s.config.MaxTokens)
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session", "rebindsession: seeded model and context from target conversation", map[string]any{
			"key": key, "model": convModel, "window_model": windowModel, "context_window": ctxWindow,
			"context_pct": usage.Percent, "context_tokens": usage.Tokens,
			"conversation_id": newConvID, "was": oldConvID,
		})
	} else {
		utils.LogWithFields(utils.LevelInfo, "session", "rebindsession: target conversation load failed, context not re-seeded", map[string]any{
			"key": key, "conversation_id": newConvID, "error": lerr,
		})
	}

	m.emitStatusSnapshot(key, "rebind")
}
