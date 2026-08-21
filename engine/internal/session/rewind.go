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
//
// RewindSession retains ordinal addressing for any client that has not adopted
// entry-id addressing (external SDK consumers, older client builds). Clients
// that have learned an exact durable EntryID — from an engine_steer_injected
// confirmation, or from loaded conversation history — should call
// RewindSessionToEntry instead: an ordinal computed against a client's own
// rendered row list silently drifts the moment a queued-but-undelivered steer
// occupies a position in that list with no corresponding tree entry yet, which
// resolves to the WRONG turn rather than failing loudly.
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

	return m.rewindToEntryLocked(key, sessionID, conv, entryID, userTurnIndex)
}

// RewindSessionToEntry is the exact-entry-addressed counterpart to
// RewindSession. entryID must name a genuine user-turn row on the
// conversation's CURRENT context path — verified here via
// conversation.IsUserTurnEntryOnCurrentPath BEFORE any branch happens, so a
// stale, foreign-branch, or non-user entryID is rejected loudly instead of
// silently corrupting the tree (BranchBefore trusts its entryID argument
// completely and has no independent notion of "is this even a user row").
//
// This is the addressing mode a client should prefer once it has learned an
// exact EntryID: it removes the class of bug where a client's rendered-row
// ordinal points at a different tree entry than the one the client thinks it
// does, because a queued-but-undelivered steer occupied a row position with no
// corresponding persisted entry yet.
func (m *Manager) RewindSessionToEntry(key, entryID string) error {
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

	if !conversation.IsUserTurnEntryOnCurrentPath(conv, entryID) {
		utils.LogWithFields(utils.LevelWarn, "session.rewind", "rewind: rejected, entry is not a user turn on the current path", map[string]any{
			"run_id":   sessionID,
			"key":      key,
			"entry_id": entryID,
		})
		return fmt.Errorf("rewind: entry %q is not a user turn on the current path for session %q", entryID, key)
	}

	return m.rewindToEntryLocked(key, sessionID, conv, entryID, -1)
}

// rewindToEntryLocked is the shared branch/plan-restore/save tail for both
// RewindSession (ordinal) and RewindSessionToEntry (exact id), once each has
// independently resolved and validated its target entryID against the current
// path. userTurnIndex is -1 for the exact-entry caller (nothing to log as an
// ordinal); RewindSession passes its real ordinal through for parity with the
// prior log shape.
func (m *Manager) rewindToEntryLocked(key, sessionID string, conv *conversation.Conversation, entryID string, userTurnIndex int) error {
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
