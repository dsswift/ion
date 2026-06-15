package session

import (
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// clear_core.go owns the single, shared implementation of "clear a
// conversation" so that the two entry points the engine exposes —
// dispatchClear (live-session /clear command) and ClearConversationFile
// (file-only wipe by conversationId, used when no live session exists) —
// carry identical semantics and emit one identical clear signal whenever a
// live session owns the conversation.
//
// Why this exists: before unification the two paths diverged. dispatchClear
// cleared retained AskUserQuestion / ExitPlanMode denials and emitted an
// engine_status snapshot + engine_command_result; ClearConversationFile only
// wiped the on-disk file and emitted nothing. A consumer that cleared a
// conversation through the file-only path (e.g. a reopened tab whose session
// had not started) kept re-surfacing the pending question card because the
// engine never told anyone the card was dismissed. Routing both paths through
// clearConversationCore closes that gap: clearing always wipes the file AND,
// when a live session owns the conversation, always clears that session's
// retained denials and emits the same dismissal signal.

// clearResult captures what clearConversationCore did so callers can decide
// which follow-up emits to fire. The core itself performs the file wipe and
// the in-memory denial clear; the caller owns the engine_status /
// command_result emission because the two callers emit on different keys and
// with slightly different surrounding context (dispatchClear also re-fires
// session_start).
type clearResult struct {
	// sessionKey is the engine session key that owns this conversation, or
	// "" when no live session does. When non-empty the caller should emit
	// the shared clear signal (engine_status + command_result) on this key.
	sessionKey string
	// deniedCleared is the number of retained PermissionDenials that were
	// dropped from the owning session. 0 when none were retained or no
	// session owns the conversation. Logged for observability.
	deniedCleared int
	// wiped is true when the on-disk conversation file was loaded and its
	// Messages cleared. False when the conversation file did not exist
	// (never-prompted, pre-minted id) — still a semantic success.
	wiped bool
}

// clearConversationCore is the single source of clear semantics. It:
//
//  1. Finds the live session (if any) that owns conversationID and clears its
//     retained PermissionDenials and context-percent so subsequent
//     engine_status snapshots (heartbeat / ReconcileState / QuerySessionStatus)
//     stop re-publishing a stale AskUserQuestion / ExitPlanMode card.
//  2. Wipes the on-disk conversation's LLM-visible Messages and token counters,
//     preserving the .tree.jsonl tree (/clear is a checkpoint, not a delete).
//
// It does NOT emit events — the caller emits, because dispatchClear and
// ClearConversationFile differ in what surrounds the emit (session_start
// re-fire, error-result shapes). The returned clearResult tells the caller
// whether a live session was found (so it can emit the shared signal) and how
// many denials were cleared (for logging).
//
// preferKey, when non-empty, is the caller's known session key (dispatchClear
// already holds the session). When empty (ClearConversationFile) the core does
// a reverse lookup over m.sessions by conversationID. Either way the result's
// sessionKey reflects the live owner, or "" if none.
func (m *Manager) clearConversationCore(conversationID, preferKey string) (clearResult, error) {
	res := clearResult{}
	if conversationID == "" {
		// Nothing to wipe on disk. A caller may still have handed us a
		// preferKey whose session retains denials (defensive — a pending
		// denial can exist before the first prompt persists a file). Clear
		// them so the card is dismissed regardless.
		if preferKey != "" {
			res.sessionKey, res.deniedCleared = m.clearSessionDenials(preferKey)
		}
		utils.Debug("Session", fmt.Sprintf("clearCore: empty conversationID preferKey=%s deniedCleared=%d (nothing to wipe on disk)", preferKey, res.deniedCleared))
		return res, nil
	}

	// Resolve the owning live session. dispatchClear passes preferKey (it
	// already holds the session); ClearConversationFile passes "" and we
	// reverse-lookup by conversationID. The reverse lookup mirrors the
	// `range m.sessions` pattern used elsewhere in the manager.
	ownerKey := preferKey
	if ownerKey == "" {
		ownerKey = m.sessionKeyForConversation(conversationID)
	}
	if ownerKey != "" {
		res.sessionKey, res.deniedCleared = m.clearSessionDenials(ownerKey)
		utils.Log("Session", fmt.Sprintf("clearCore: convID=%s owned by live session key=%s deniedCleared=%d", conversationID, res.sessionKey, res.deniedCleared))
	} else {
		utils.Log("Session", fmt.Sprintf("clearCore: convID=%s has no live session (file-only wipe)", conversationID))
	}

	conv, err := conversation.Load(conversationID, "")
	if err != nil {
		if errors.Is(err, conversation.ErrNotFound) {
			// Pre-minted id with no prompt sent yet — file doesn't exist.
			// Treat as already-empty: a semantic success with nothing to
			// wipe. The denial clear above (if any) still applied.
			utils.Debug("Session", fmt.Sprintf("clearCore: convID=%s file not found, treating as already-empty", conversationID))
			return res, nil
		}
		utils.Log("Session", fmt.Sprintf("clearCore: convID=%s load failed: %v", conversationID, err))
		return res, fmt.Errorf("load conversation %q: %w", conversationID, err)
	}

	conv.Messages = nil
	conv.LastInputTokens = 0
	conv.LastInputTokensMsgCount = 0
	if err := conversation.Save(conv, ""); err != nil {
		utils.Log("Session", fmt.Sprintf("clearCore: convID=%s save failed: %v", conversationID, err))
		return res, fmt.Errorf("save conversation %q: %w", conversationID, err)
	}
	res.wiped = true
	utils.Log("Session", fmt.Sprintf("clearCore: convID=%s wiped Messages (%d entries preserved in tree) ownerKey=%s deniedCleared=%d", conversationID, len(conv.Entries), res.sessionKey, res.deniedCleared))
	return res, nil
}

// clearSessionDenials drops the retained PermissionDenials and resets the
// context-percent on the live session keyed by key. Returns the key (echoed
// for caller convenience) and the number of denials cleared. Safe to call
// when the session does not exist (returns "", 0). Holds the manager lock for
// the mutation so the clear is race-free with concurrent status emits.
func (m *Manager) clearSessionDenials(key string) (string, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[key]
	if !ok {
		utils.Debug("Session", fmt.Sprintf("clearSessionDenials: key=%s not found", key))
		return "", 0
	}
	n := len(s.lastPermissionDenials)
	if n > 0 {
		utils.Log("Session", fmt.Sprintf("clearSessionDenials: key=%s clearing %d retained permission_denials (/clear dismisses pending question/plan card)", key, n))
		s.lastPermissionDenials = nil
	}
	s.lastContextPct = 0
	return key, n
}

// sessionKeyForConversation reverse-looks-up the live session key that owns
// the given conversationID, or "" when no live session does. Mirrors the
// `range m.sessions` iteration pattern used elsewhere in the manager. Takes
// the read lock; callers must not already hold the manager lock.
func (m *Manager) sessionKeyForConversation(conversationID string) string {
	if conversationID == "" {
		return ""
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	for key, s := range m.sessions {
		if s.conversationID == conversationID {
			return key
		}
	}
	return ""
}

// emitClearSignal emits the single, shared "clear executed" signal on the
// given session key: an engine_status snapshot that explicitly carries empty
// PermissionDenials (dismissing any pending card per the snapshot contract)
// followed by the engine_command_result{command:"clear"}. Both callers
// (dispatchClear and ClearConversationFile) use this so desktop and iOS
// receive the identical dismissal signal regardless of which clear path ran.
//
// The engine_status fires before the command_result so consumers that mirror
// context-percent from engine_status observe the reset before the completion
// event — same ordering invariant dispatchClear documented inline.
func (m *Manager) emitClearSignal(key string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	var window int
	var model string
	var cost float64
	var state string
	if ok {
		window = s.lastContextWindow
		model = s.lastModel
		cost = s.lastTotalCost
		state = m.sessionState(s)
	}
	m.mu.RUnlock()
	if !ok {
		utils.Debug("Session", fmt.Sprintf("emitClearSignal: key=%s not found, emitting command_result only", key))
		m.emitCommandResult(key, "clear", nil)
		return
	}
	utils.Log("Session", fmt.Sprintf("emitClearSignal: key=%s emitting engine_status(empty denials) + command_result", key))
	m.emit(key, types.EngineEvent{
		Type: "engine_status",
		Fields: &types.StatusFields{
			State:          state,
			ContextPercent: 0,
			ContextWindow:  window,
			Model:          model,
			TotalCostUsd:   cost,
			// Explicitly nil — engine_status is a full snapshot, and /clear
			// just dismissed any retained AskUserQuestion / ExitPlanMode
			// denial. Stating nil documents the dismissal and guards against
			// a future edit carrying a stale denial onto this snapshot.
			PermissionDenials: nil,
		},
	})
	m.emitCommandResult(key, "clear", nil)
}
