package session

import (
	"errors"
	"fmt"
	"os"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/utils"
)

// RewindSession is the ordinal-addressed, tree-native rewind. A client rewinding
// "to before its Nth user turn" sends the ordinal it already computes from its
// rendered rows; the engine resolves it to the matching tree entry, moves the
// leaf to that entry's parent (so the next prompt replaces the turn on a fresh
// sibling branch instead of chaining after the old leaf and duplicating it), and
// restores the plan-file continuity in effect at the branch point from the tree.
//
// Why ordinal, not entry id: clients hold no engine entry ids, only their own
// user-turn ordinal. Resolving the ordinal engine-side (via the same
// flattenEntries that produces the client's rows) keeps the engine authoritative
// over its own tree and removes the client's brittle index arithmetic.
//
// Plan-state division of labor: the engine restores planFilePath (the slug the
// conversation was working under at the branch point), because that is what the
// tree records and what prevents a re-enter from allocating a fresh slug and
// orphaning the real plan. Whether the session is *in* plan mode at that point
// is re-asserted by the harness on the next prompt (set_plan_mode / prompt_sync)
// from the client's preserved permission mode — the engine does not guess it
// from the tree, which records plan-file writes, not mode transitions.
func (m *Manager) RewindSession(key string, userTurnIndex int) error {
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

	// Resolve the ordinal against the CURRENT path before branching.
	entryID, found := conversation.UserMessageEntryID(conv, userTurnIndex)
	if !found {
		return fmt.Errorf("rewind: user turn %d out of range for session %q", userTurnIndex, key)
	}

	if _, err := conversation.BranchBefore(conv, entryID); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "rewind: branch before failed", map[string]any{"run_id": sessionID, "user_turn_index": userTurnIndex, "entry_id": entryID, "error": err.Error()})
		return err
	}

	// Derive plan-file continuity from the NEW path (after the leaf moved) and
	// restore it onto the live session so a plan re-enter reuses the existing
	// slug instead of allocating a fresh one.
	planFilePath, planSlug := conversation.PlanStateAtLeaf(conv)
	m.restorePlanFileForRewind(key, planFilePath)

	utils.LogWithFields(utils.LevelInfo, "session.rewind", "rewind: leaf moved to before user turn", map[string]any{
		"run_id":          sessionID,
		"user_turn_index": userTurnIndex,
		"entry_id":        entryID,
		"kept_messages":   len(conv.Messages),
		"plan_file_path":  planFilePath,
		"plan_slug":       planSlug,
	})

	return conversation.Save(conv, "")
}

// restorePlanFileForRewind sets the session's plan-file continuity to the plan
// in effect at the rewind point. An existing-on-disk guard mirrors SetPlanMode /
// SendPrompt: a path that no longer exists (or an empty path, meaning the rewind
// landed before any plan) clears the field so the next plan-mode entry allocates
// a fresh slug rather than pointing at a gone file. planModePromptSent resets so
// the reentry guidance re-fires; hasExitedPlanMode tracks whether a plan file is
// carried, matching SetPlanMode's disable path.
func (m *Manager) restorePlanFileForRewind(key, planFilePath string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[key]
	if !ok {
		return
	}
	if planFilePath != "" {
		if _, err := os.Stat(planFilePath); err == nil {
			s.planFilePath = planFilePath
		} else {
			utils.LogWithFields(utils.LevelInfo, "session.rewind", "rewind: restored plan file not on disk, clearing", map[string]any{"key": key, "plan_file_path": planFilePath})
			s.planFilePath = ""
		}
	} else {
		s.planFilePath = ""
	}
	s.planModePromptSent = false
	s.hasExitedPlanMode = s.planFilePath != ""
	utils.LogWithFields(utils.LevelInfo, "session.rewind", "rewind: plan file restored", map[string]any{"key": key, "plan_file_path": s.planFilePath, "has_exited_plan_mode": s.hasExitedPlanMode})
}
