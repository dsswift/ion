package session

import (
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ForkSession preserves the original index-addressed API for in-process callers.
// A generated session key keeps the published fork_session behavior unchanged.
func (m *Manager) ForkSession(key string, messageIndex int) (string, error) {
	newKey, _, err := m.ForkSessionToKey(key, "", messageIndex)
	return newKey, err
}

// ForkSessionToKey creates an independent conversation at the requested message
// index and registers it under caller-owned newKey when one is supplied.
func (m *Manager) ForkSessionToKey(key, newKey string, messageIndex int) (string, string, error) {
	return m.forkSession(key, newKey, messageIndex, func(conv *conversation.Conversation) (*conversation.Conversation, error) {
		return conversation.ForkConversation(conv, messageIndex), nil
	})
}

// ForkSessionBeforeUserTurn creates an independent conversation ending just
// before the selected user turn. entryID is preferred because it is exact;
// userTurnIndex remains the fallback for clients with an optimistic row id.
func (m *Manager) ForkSessionBeforeUserTurn(key, newKey, entryID string, userTurnIndex int) (string, string, error) {
	return m.forkSession(key, newKey, userTurnIndex, func(conv *conversation.Conversation) (*conversation.Conversation, error) {
		if entryID != "" {
			return conversation.ForkConversationBefore(conv, entryID)
		}
		resolved, found := conversation.UserMessageEntryID(conv, userTurnIndex)
		if !found {
			return nil, fmt.Errorf("fork: user turn %d out of range for session %q", userTurnIndex, key)
		}
		return conversation.ForkConversationBefore(conv, resolved)
	})
}

func (m *Manager) forkSession(
	key, requestedNewKey string,
	messageIndex int,
	fork func(*conversation.Conversation) (*conversation.Conversation, error),
) (string, string, error) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		err := fmt.Errorf("session %q not found", key)
		logForkFailure("source session missing", key, requestedNewKey, "", "", err)
		return "", "", err
	}
	if s.conversationID == "" {
		m.mu.RUnlock()
		err := fmt.Errorf("session %q has no conversation", key)
		logForkFailure("source conversation missing", key, requestedNewKey, "", "", err)
		return "", "", err
	}
	conversationID := s.conversationID
	config := s.config
	extGroup := s.extGroup
	initial := &forkInitialState{
		planMode:                    s.planMode,
		planModeTools:               append([]string(nil), s.planModeTools...),
		planModeAllowedBashCommands: append([]string(nil), s.planModeAllowedBashCommands...),
		planModeAllowedMcpTools:     append([]string(nil), s.planModeAllowedMcpTools...),
		planFilePath:                s.planFilePath,
		hasExitedPlanMode:           s.hasExitedPlanMode,
	}
	m.mu.RUnlock()

	newKey, reservation, err := m.reserveForkKey(key, requestedNewKey)
	if err != nil {
		logForkFailure("target key unavailable", key, requestedNewKey, conversationID, "", err)
		return "", "", err
	}
	releaseReservation := true
	defer func() {
		if releaseReservation && m.releaseForkKey(newKey, reservation) {
			utils.LogWithFields(utils.LevelInfo, "session.fork", "fork session: reservation released", map[string]any{
				"source_key": key, "new_key": newKey, "source_conversation_id": conversationID,
			})
		}
	}()

	if extGroup != nil && !extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		cancel, hookErr := extGroup.FireSessionBeforeFork(ctx, extension.ForkInfo{
			SourceSessionKey: key,
			NewSessionKey:    newKey,
			ForkMessageIndex: messageIndex,
		})
		if hookErr != nil {
			err = fmt.Errorf("session_before_fork hook error: %w", hookErr)
			logForkFailure("before hook failed", key, newKey, conversationID, "", err)
			return "", "", err
		}
		if cancel {
			err = fmt.Errorf("fork cancelled by session_before_fork hook")
			logForkFailure("before hook cancelled", key, newKey, conversationID, "", err)
			return "", "", err
		}
		utils.LogWithFields(utils.LevelInfo, "session.fork", "fork session: before hook allowed", map[string]any{
			"source_key": key, "new_key": newKey, "source_conversation_id": conversationID,
		})
	}

	conv, err := conversation.Load(conversationID, "")
	if err != nil {
		if errors.Is(err, conversation.ErrNotFound) {
			err = fmt.Errorf("session %q has no conversation", key)
		} else {
			err = fmt.Errorf("failed to load conversation: %w", err)
		}
		logForkFailure("source load failed", key, newKey, conversationID, "", err)
		return "", "", err
	}
	forked, err := fork(conv)
	if err != nil {
		logForkFailure("target rejected", key, newKey, conversationID, "", err)
		return "", "", err
	}
	if err := conversation.Save(forked, ""); err != nil {
		wrapped := fmt.Errorf("failed to save forked conversation: %w", err)
		logForkFailure("save failed", key, newKey, conversationID, forked.ID, wrapped)
		return "", "", wrapped
	}

	config.SessionID = forked.ID
	config.ForceNewConversation = false
	started, err := m.startSession(newKey, config, reservation, initial)
	if err != nil {
		// startSession removes the reservation only after it installs the live
		// session. If a later startup phase fails, stop that partial session before
		// deleting the newly-saved conversation.
		m.mu.RLock()
		_, installed := m.sessions[newKey]
		m.mu.RUnlock()
		if installed {
			if stopErr := m.StopSession(newKey); stopErr != nil {
				utils.LogWithFields(utils.LevelError, "session.fork", "fork session: partial session cleanup failed", map[string]any{
					"source_key": key, "new_key": newKey, "source_conversation_id": conversationID,
					"conversation_id": forked.ID, "error": stopErr.Error(),
				})
			}
		}
		if _, cleanupErr := conversation.DeleteStoredExact("", []string{forked.ID}, nil); cleanupErr != nil {
			utils.LogWithFields(utils.LevelError, "session.fork", "fork session: startup cleanup failed", map[string]any{
				"source_key": key, "new_key": newKey, "source_conversation_id": conversationID,
				"conversation_id": forked.ID, "error": cleanupErr.Error(),
			})
		}
		wrapped := fmt.Errorf("failed to start forked session: %w", err)
		logForkFailure("target startup failed", key, newKey, conversationID, forked.ID, wrapped)
		return "", "", wrapped
	}
	if started.Existed {
		err = fmt.Errorf("session %q already exists", newKey)
		logForkFailure("target unexpectedly existed", key, newKey, conversationID, forked.ID, err)
		return "", "", err
	}
	releaseReservation = false

	utils.LogWithFields(utils.LevelInfo, "session.fork", "fork session: created", map[string]any{
		"source_key": key, "new_key": newKey, "source_conversation_id": conversationID,
		"conversation_id": forked.ID, "message_index": messageIndex, "message_count": len(forked.Messages),
	})
	if extGroup != nil && !extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		extGroup.FireSessionFork(ctx, extension.ForkInfo{ //nolint:errcheck // errors logged internally by fireVoid/s.fire
			SourceSessionKey: key,
			NewSessionKey:    newKey,
			ForkMessageIndex: messageIndex,
		})
	}
	return newKey, forked.ID, nil
}

func logForkFailure(outcome, sourceKey, targetKey, sourceConversationID, targetConversationID string, err error) {
	utils.LogWithFields(utils.LevelError, "session.fork", "fork session: "+outcome, map[string]any{
		"source_key": sourceKey, "new_key": targetKey, "source_conversation_id": sourceConversationID,
		"conversation_id": targetConversationID, "error": err.Error(),
	})
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
