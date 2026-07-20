package session

import (
	"errors"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/pending"
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
		if errors.Is(err, conversation.ErrNotFound) {
			return "", fmt.Errorf("session %q has no conversation", key)
		}
		return "", fmt.Errorf("failed to load conversation: %w", err)
	}

	forked := conversation.ForkConversation(conv, messageIndex)

	newKey := fmt.Sprintf("%s-fork-%d", key, time.Now().UnixMilli())
	newSession := &engineSession{
		key:            newKey,
		config:         s.config,
		conversationID: forked.ID,
		agents:         agents.NewRegistry(),
		childPIDs:      make(map[int]struct{}),
		pending:        pending.New(),
		planMode:       s.planMode,
		planModeTools:  s.planModeTools,
	}
	m.sessions[newKey] = newSession
	m.mu.Unlock()

	if err := conversation.Save(forked, ""); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "failed to save forked conversation", map[string]any{"error": err.Error()})
	}

	// Fire session_fork hook after the fork succeeds.
	if extGroup != nil && !extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		extGroup.FireSessionFork(ctx, extension.ForkInfo{ //nolint:errcheck // errors logged internally by fireVoid/s.fire
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
		if errors.Is(err, conversation.ErrNotFound) {
			return fmt.Errorf("session %q has no conversation", key)
		}
		return fmt.Errorf("failed to load conversation: %w", err)
	}

	if _, err := conversation.Branch(conv, entryID); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "branch failed", map[string]any{"run_id": sessionID, "entry_id": entryID, "error": err.Error()})
		return fmt.Errorf("branch failed: %w", err)
	}
	return conversation.Save(conv, "")
}

// BranchSessionBefore moves the conversation leaf to the PARENT of the given
// entry — the tree-native rewind. A consumer rewinding "to before user turn
// X" calls this so the next prompt becomes X's sibling on a fresh branch
// (replacing it on the active path) instead of chaining after the old leaf
// and duplicating the turn. Errors are returned to the caller — unlike
// BranchSession's historical swallow — because a rewind that silently fails
// leaves the duplicate-append behavior in place.
func (m *Manager) BranchSessionBefore(key, entryID string) error {
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
		if errors.Is(err, conversation.ErrNotFound) {
			return fmt.Errorf("session %q has no conversation", key)
		}
		return fmt.Errorf("failed to load conversation: %w", err)
	}

	if _, err := conversation.BranchBefore(conv, entryID); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "branch before failed", map[string]any{"run_id": sessionID, "error": err.Error()})
		return err
	}
	utils.LogWithFields(utils.LevelInfo, "session", "branch before: leaf moved to parent", map[string]any{"run_id": sessionID, "count": len(conv.Messages)})
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
		if errors.Is(err, conversation.ErrNotFound) {
			return fmt.Errorf("session %q has no conversation", key)
		}
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
		if errors.Is(err, conversation.ErrNotFound) {
			// Pre-minted ID with no prompt sent yet — no tree to show.
			return nil
		}
		m.emit(key, types.EngineEvent{
			Type:         "engine_error",
			EventMessage: "failed to load session tree: " + err.Error(),
		})
		return nil
	}
	return conversation.GetTree(conv)
}
