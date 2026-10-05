package session

import (
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// sessionConversationID returns the conversation behind key.
func (m *Manager) sessionConversationID(key string) (string, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[key]
	if !ok {
		return "", fmt.Errorf("session %q not found", key)
	}
	if s.conversationID == "" {
		return "", fmt.Errorf("session %q has no conversation", key)
	}
	return s.conversationID, nil
}

// sessionBusyReason names why the conversation behind key cannot change its
// active path now, or "" when it can. A run, a compaction, and a recovery all
// append to the current path; moving the leaf under them would put their
// entries on a path nobody chose.
func (m *Manager) sessionBusyReason(key string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[key]
	if !ok {
		return ""
	}
	switch {
	case s.requestID != "":
		return "a run is active"
	case s.compactInFlight:
		return "a compaction is running"
	case s.recoveryInProgress:
		return "a run recovery is in progress"
	}
	return ""
}

// ListSessionBranches reports every branch of the conversation behind key.
// A session whose conversation has no file yet has no branches.
func (m *Manager) ListSessionBranches(key string) (conversation.BranchListing, error) {
	convID, err := m.sessionConversationID(key)
	if err != nil {
		return conversation.BranchListing{}, err
	}
	conv, err := conversation.Load(convID, "")
	if errors.Is(err, conversation.ErrNotFound) {
		utils.LogWithFields(utils.LevelDebug, "session.branches", "list branches: no conversation file yet", map[string]any{"key": key, "conversation_id": convID})
		return conversation.BranchListing{Branches: []conversation.BranchSummary{}, BranchPoints: []conversation.BranchPoint{}}, nil
	}
	if err != nil {
		return conversation.BranchListing{}, fmt.Errorf("failed to load conversation: %w", err)
	}
	listing := conversation.ListBranches(conv)
	utils.LogWithFields(utils.LevelInfo, "session.branches", "list branches", map[string]any{
		"key": key, "conversation_id": convID, "count": len(listing.Branches),
		"branch_points": len(listing.BranchPoints), "leaf_id": listing.ActiveLeafID,
	})
	return listing, nil
}

// SwitchSessionBranch makes leafID the active path of the conversation behind
// key, so the next prompt continues that branch. The model context is rebuilt
// from that path, the plan file in effect on it is restored, and every
// consumer is told through engine_active_path_changed. Refused while anything
// is appending to the current path.
func (m *Manager) SwitchSessionBranch(key, leafID string) error {
	convID, err := m.sessionConversationID(key)
	if err != nil {
		return err
	}
	if reason := m.sessionBusyReason(key); reason != "" {
		utils.LogWithFields(utils.LevelInfo, "session.branches", "switch branch: refused, session busy", map[string]any{"key": key, "conversation_id": convID, "leaf_id": leafID, "reason": reason})
		return fmt.Errorf("switch branch: %s for session %q", reason, key)
	}

	var previous, planFilePath, planSlug string
	var kept int
	err = conversation.UpdateOnDisk(convID, "", func(conv *conversation.Conversation) (bool, error) {
		// Checked again under the conversation lock: a prompt accepted after
		// the first check owns the live object by now.
		if reason := m.sessionBusyReason(key); reason != "" {
			return false, fmt.Errorf("switch branch: %s for session %q", reason, key)
		}
		prev, switchErr := conversation.SwitchBranch(conv, leafID)
		if switchErr != nil {
			return false, switchErr
		}
		previous = prev
		kept = len(conv.Messages)
		planFilePath, planSlug = conversation.PlanStateAtLeaf(conv)
		return true, nil
	})
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "session.branches", "switch branch: rejected", map[string]any{"key": key, "conversation_id": convID, "leaf_id": leafID, "error": err.Error()})
		return err
	}

	m.restorePlanFileForRewind(key, planFilePath)
	utils.LogWithFields(utils.LevelInfo, "session.branches", "switch branch: active path moved", map[string]any{
		"key": key, "conversation_id": convID, "leaf_id": leafID, "previous_leaf_id": previous,
		"kept_messages": kept, "plan_file_path": planFilePath, "plan_slug": planSlug,
	})
	m.emit(key, translateToEngineEvent(types.NormalizedEvent{Data: &types.ActivePathChangedEvent{
		ConversationID: convID, LeafID: leafID, PreviousLeafID: previous,
	}}, 0))
	return nil
}

// ForkSessionAtLeaf creates an independent conversation holding exactly the
// branch that ends at leafID, so two branches can be open side by side.
// ForkMessageIndex is -1 in the fork hooks: the branch need not lie on the
// source's current path, so no index on it names the cut.
func (m *Manager) ForkSessionAtLeaf(key, newKey, leafID string) (string, string, error) {
	return m.forkSession(key, newKey, -1, func(conv *conversation.Conversation) (*conversation.Conversation, error) {
		return conversation.ForkConversationAtLeaf(conv, leafID)
	})
}
