package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Native-session cursor management — the t3-aligned core of provider-agnostic
// conversation continuity.
//
// Invariant: Ion's transcript is the single source of truth. A delegated-CLI
// backend's native session (claude --resume / codex ThreadResume / ACP
// session/load) is a disposable, per-provider CACHE over it. Whenever the
// cache is stale or absent, it is discarded and rebuilt from the transcript.
// Worst case is always "rebuild from truth" (more tokens), never wrong
// context — which is what kills the whole class of state-drift bugs.
//
// The pieces:
//   - resolveCliContinuity (dispatch): resume when this session holds a
//     still-valid cursor for the serving backend kind, else bridge the
//     transcript into the prompt (seedCliHistory).
//   - captureNativeSessionCursor (run exit): store the backend-reported
//     native id per kind, position-tagged with the conversation's current
//     LeafID, and persist it into the .tree.jsonl header.
//   - rehydrateNativeSessions (session start): restore the persisted cursor
//     map so continuity survives an engine restart.
//
// Validity is exact, not heuristic: a cursor is valid iff its HeadEntryID
// equals the conversation's live LeafID. Staying on one provider keeps the
// leaf where that provider's run left it → cheap native resume. Any other
// writer advancing the transcript (a turn on another provider, /clear,
// rewind, tree navigation) moves the leaf and thereby stales every other
// provider's cursor → the next use re-bridges from truth. Correct by
// construction; no reconciliation.

// resolveCliContinuity makes the resume-vs-bridge decision for a run about to
// dispatch. Must be called after opts.Prompt and opts.Model are final and
// before the backend dispatch. No-op for engine-owned backends (the
// ApiBackend loads conversation.Messages itself).
func (m *Manager) resolveCliContinuity(s *engineSession, opts *types.RunOptions) {
	caps := m.resolvedBackend(opts.Model).Capabilities()
	if caps.ContextModel != backend.ContextModelNativeSession {
		return
	}

	m.mu.RLock()
	cursor, hasCursor := s.nativeSessions[caps.Kind]
	convID := s.conversationID
	m.mu.RUnlock()

	leaf := currentConversationLeaf(convID)
	if hasCursor && cursor.Cursor != "" && caps.Resume && cursor.HeadEntryID == leaf {
		// Valid cursor: the transcript has not advanced since this backend
		// last saw it, so the native session still equals Ion's truth.
		opts.CliResumeSessionID = cursor.Cursor
		utils.LogWithFields(utils.LevelInfo, "session.native_session", "resuming native session", map[string]any{
			"key": s.key, "conversation_id": convID, "kind": caps.Kind,
			"cursor": cursor.Cursor, "head_entry_id": leaf,
		})
		return
	}

	// Stale or absent: discard the cache and rebuild from the transcript.
	// The run's exit will capture a fresh cursor at the new head.
	reason := "absent"
	if hasCursor {
		reason = "stale"
	}
	utils.LogWithFields(utils.LevelInfo, "session.native_session", "no valid native session, bridging from transcript", map[string]any{
		"key": s.key, "conversation_id": convID, "kind": caps.Kind, "reason": reason,
		"cursor_head": cursor.HeadEntryID, "live_leaf": leaf,
	})
	m.seedCliHistory(s, opts)
}

// currentConversationLeaf reads the conversation's live LeafID from disk.
// Returns "" when the conversation has no backing file yet (a fresh
// conversation, or a CLI-only conversation the Ion store never persisted) —
// which round-trips correctly against a cursor captured at the same state.
func currentConversationLeaf(convID string) string {
	if convID == "" || !conversation.Exists(convID, "") {
		return ""
	}
	conv, err := conversation.Load(convID, "")
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "session.native_session", "leaf read failed, treating as empty", map[string]any{
			"conversation_id": convID, "error": err.Error(),
		})
		return ""
	}
	if conv.LeafID == nil {
		return ""
	}
	return *conv.LeafID
}

// persistCliTurn appends a completed delegated-CLI turn (the user prompt and
// the assistant's final text) to Ion's conversation store, advancing the
// conversation leaf. This is what makes Ion's transcript the true single
// source of truth for CLI-served turns: without it, delegated-CLI turns are
// invisible to Ion and a later cross-provider turn's transcript bridge misses
// them entirely (the continuity-loss bug — a claude turn a subsequent gpt turn
// could not see).
//
// Called from handleRunExit BEFORE captureNativeSessionCursor so the cursor is
// tagged at the post-turn leaf: staying on this provider keeps the cursor
// valid (leaf unchanged until the next turn), while any other provider's turn
// advances the leaf and stales this cursor, forcing a re-bridge that now
// carries this turn. Engine-owned backends never call this — they persist
// their own turns via the runloop.
//
// Best-effort: a load/save failure is logged and the turn is dropped from Ion's
// store (the native session still carries it for same-provider resume). The
// pending fields are cleared regardless so a failure cannot double-append on a
// later exit.
func (m *Manager) persistCliTurn(key, convID string) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return
	}
	userText := s.pendingCliUserTurn
	assistantText := s.pendingCliAssistantText
	s.pendingCliUserTurn = ""
	s.pendingCliAssistantText = ""
	m.mu.Unlock()

	if convID == "" || userText == "" {
		return // engine-owned run, or nothing to persist
	}

	conv, err := conversation.Load(convID, "")
	if err != nil {
		// No file yet (first turn on a pre-minted CLI conversation): create it
		// so the turn is not lost. Mirrors the backend's loadOrCreate.
		conv = conversation.CreateConversation(convID, "", "")
	}

	conversation.AddUserMessage(conv, userText)
	if assistantText != "" {
		conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: assistantText}}, types.LlmUsage{})
	}
	if saveErr := conversation.Save(conv, ""); saveErr != nil {
		utils.LogWithFields(utils.LevelWarn, "session.native_session", "persistCliTurn: save failed, turn dropped from Ion store", map[string]any{
			"key": key, "conversation_id": convID, "error": saveErr.Error(),
		})
		return
	}
	leaf := ""
	if conv.LeafID != nil {
		leaf = *conv.LeafID
	}
	utils.LogWithFields(utils.LevelInfo, "session.native_session", "persisted delegated-CLI turn into Ion transcript", map[string]any{
		"key": key, "conversation_id": convID, "new_leaf": leaf,
		"user_bytes": len(userText), "assistant_bytes": len(assistantText),
	})
}

// captureNativeSessionCursor records a run's backend-reported native session
// id as this conversation's cursor for the given backend kind, position-
// tagged with the conversation's current LeafID, and persists the updated
// cursor map into the .tree.jsonl header so it survives an engine restart.
//
// Called from handleRunExit AFTER persistTerminalDispatches — terminal
// dispatch entries advance the leaf, and the cursor must be tagged with the
// leaf as it stands at the end of all run-exit writes, or the very next
// same-provider turn would see a moved leaf and re-bridge for nothing.
//
// A conversation with no backing file (CLI-only, never saved by the Ion
// store) gets an in-memory cursor only: there is nothing to persist against,
// and consistently, its key→conversationId binding is never flushed either —
// a restart mints a fresh conversation, so a persisted cursor would be
// unreachable anyway.
func (m *Manager) captureNativeSessionCursor(key, convID, kind, cursor string) {
	leaf := ""
	persisted := false
	if convID != "" && conversation.Exists(convID, "") {
		conv, err := conversation.Load(convID, "")
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "session.native_session", "capture: conversation load failed, keeping cursor in-memory only", map[string]any{
				"key": key, "conversation_id": convID, "kind": kind, "error": err.Error(),
			})
		} else {
			if conv.LeafID != nil {
				leaf = *conv.LeafID
			}
			if conv.NativeSessions == nil {
				conv.NativeSessions = make(map[string]conversation.NativeSessionCursor)
			}
			conv.NativeSessions[kind] = conversation.NativeSessionCursor{Cursor: cursor, HeadEntryID: leaf}
			if saveErr := conversation.Save(conv, ""); saveErr != nil {
				utils.LogWithFields(utils.LevelWarn, "session.native_session", "capture: cursor persist failed, keeping cursor in-memory only", map[string]any{
					"key": key, "conversation_id": convID, "kind": kind, "error": saveErr.Error(),
				})
			} else {
				persisted = true
			}
		}
	}

	m.mu.Lock()
	if s, ok := m.sessions[key]; ok {
		if s.nativeSessions == nil {
			s.nativeSessions = make(map[string]conversation.NativeSessionCursor)
		}
		s.nativeSessions[kind] = conversation.NativeSessionCursor{Cursor: cursor, HeadEntryID: leaf}
	}
	m.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "session.native_session", "captured native session cursor", map[string]any{
		"key": key, "conversation_id": convID, "kind": kind,
		"cursor": cursor, "head_entry_id": leaf, "persisted": persisted,
	})
}

// rehydrateNativeSessions seeds the session's in-memory cursor map from the
// loaded conversation's persisted NativeSessions header. Called from
// StartSession with the conversation rehydrateDispatchState already loaded —
// this is what makes continuity survive an engine restart (resume, not
// re-bridge, when staying on a provider). Copies the map so later captures
// never mutate the loaded conversation's view.
func (m *Manager) rehydrateNativeSessions(s *engineSession, conv *conversation.Conversation) {
	if conv == nil || len(conv.NativeSessions) == 0 {
		return
	}
	ns := make(map[string]conversation.NativeSessionCursor, len(conv.NativeSessions))
	for k, v := range conv.NativeSessions {
		ns[k] = v
	}
	m.mu.Lock()
	s.nativeSessions = ns
	m.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "session.native_session", "rehydrated native session cursors", map[string]any{
		"key": s.key, "conversation_id": s.conversationID, "count": len(ns),
	})
}
