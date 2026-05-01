package session

import (
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ForkSession forks the session's conversation at the given message index.
func (m *Manager) ForkSession(key string, messageIndex int) (string, error) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return "", fmt.Errorf("session %q not found", key)
	}

	if s.conversationID == "" {
		m.mu.Unlock()
		return "", fmt.Errorf("session %q has no conversation", key)
	}

	extGroup := s.extGroup
	m.mu.Unlock()

	// Fire session_before_fork hook -- cancellable.
	if extGroup != nil && !extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		newKey := fmt.Sprintf("%s-fork-%d", key, time.Now().UnixMilli())
		cancel, err := extGroup.FireSessionBeforeFork(ctx, extension.ForkInfo{
			SourceSessionKey: key,
			NewSessionKey:    newKey,
			ForkMessageIndex: messageIndex,
		})
		if err != nil {
			return "", fmt.Errorf("session_before_fork hook error: %w", err)
		}
		if cancel {
			return "", fmt.Errorf("fork cancelled by session_before_fork hook")
		}
	}

	m.mu.Lock()
	s, ok = m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return "", fmt.Errorf("session %q not found", key)
	}

	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		m.mu.Unlock()
		return "", fmt.Errorf("failed to load conversation: %w", err)
	}

	forked := conversation.ForkConversation(conv, messageIndex)

	newKey := fmt.Sprintf("%s-fork-%d", key, time.Now().UnixMilli())
	newSession := &engineSession{
		key:           newKey,
		config:        s.config,
		conversationID: forked.ID,
		agentRegistry: make(map[string]types.AgentHandle),
		childPIDs:     make(map[int]struct{}),
		planMode:      s.planMode,
		planModeTools: s.planModeTools,
	}
	m.sessions[newKey] = newSession
	m.mu.Unlock()

	if err := conversation.Save(forked, ""); err != nil {
		utils.Log("Session", "failed to save forked conversation: "+err.Error())
	}

	// Fire session_fork hook after the fork succeeds.
	if extGroup != nil && !extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		_ = extGroup.FireSessionFork(ctx, extension.ForkInfo{
			SourceSessionKey: key,
			NewSessionKey:    newKey,
			ForkMessageIndex: messageIndex,
		})
	}

	return newKey, nil
}

// BranchSession branches the conversation tree at the given entry ID.
func (m *Manager) BranchSession(key, entryID string) error {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return fmt.Errorf("session %q not found", key)
	}
	sessionID := s.conversationID
	m.mu.RUnlock()

	if sessionID == "" {
		return fmt.Errorf("session %q has no conversation", key)
	}

	conv, err := conversation.Load(sessionID, "")
	if err != nil {
		return fmt.Errorf("failed to load conversation: %w", err)
	}

	if _, err := conversation.Branch(conv, entryID); err != nil {
		utils.Log("Session", "branch failed: "+err.Error())
		return nil
	}
	return conversation.Save(conv, "")
}

// NavigateSession moves the conversation tree pointer to the target entry.
func (m *Manager) NavigateSession(key, targetID string) error {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return fmt.Errorf("session %q not found", key)
	}
	sessionID := s.conversationID
	m.mu.RUnlock()

	if sessionID == "" {
		return fmt.Errorf("session %q has no conversation", key)
	}

	conv, err := conversation.Load(sessionID, "")
	if err != nil {
		return fmt.Errorf("failed to load conversation: %w", err)
	}

	if _, err := conversation.NavigateTree(conv, targetID); err != nil {
		return err
	}
	return conversation.Save(conv, "")
}

// GetSessionTree returns the conversation tree for visualization.
func (m *Manager) GetSessionTree(key string) interface{} {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return nil
	}
	sessionID := s.conversationID
	m.mu.RUnlock()

	if sessionID == "" {
		return nil
	}

	conv, err := conversation.Load(sessionID, "")
	if err != nil {
		m.emit(key, types.EngineEvent{
			Type:         "engine_error",
			EventMessage: "failed to load session tree: " + err.Error(),
		})
		return nil
	}
	return conversation.GetTree(conv)
}
