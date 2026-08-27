package session

import (
	"errors"

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

	// Client-tool signature validity applies only to backends whose native
	// session fixes the tool set at creation (codex dynamicTools). For those,
	// a cursor created under a different tool set must not be resumed — the
	// resumed thread would silently lack newly declared tools. An old cursor
	// with no recorded signature is treated as "created with no client tools"
	// and stays valid only while the current run also declares none.
	signatureOk := true
	if caps.ClientToolTransport == backend.ClientToolTransportCodexDynamic {
		signatureOk = cursor.ClientToolSignature == opts.ClientToolSignature
	}

	leaf := currentConversationLeaf(convID)
	if hasCursor && cursor.Cursor != "" && caps.Resume && cursor.HeadEntryID == leaf && signatureOk {
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
		if !signatureOk {
			reason = "client_tool_signature_mismatch"
		}
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

// persistCliTurn appends a completed delegated-CLI turn (the provider prompt,
// its optional display text, and the assistant's final text) to Ion's
// conversation store, advancing the conversation leaf. This is what makes
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
	displayText := s.pendingCliDisplayText
	injectionKind := s.pendingCliInjectionKind
	assistantText := s.pendingCliAssistantText
	recorder := s.cliTranscript
	s.pendingCliUserTurn = ""
	s.pendingCliDisplayText = ""
	s.pendingCliInjectionKind = ""
	s.pendingCliAssistantText = ""
	s.cliTranscript = nil
	m.mu.Unlock()

	if convID == "" || userText == "" {
		utils.LogWithFields(utils.LevelDebug, "session.native_session", "persistCliTurn: no delegated turn to persist", map[string]any{
			"key": key, "conversation_id": convID, "has_user_text": userText != "",
		})
		return
	}

	// Prefer the structured recording (ordered text + exact tool_use /
	// tool_result pairs — client-tool question rounds included) so the
	// canonical transcript carries what actually happened. An empty recording
	// (no recorder, or a run with no recorded activity) falls back to the
	// final-text persistence so this path never regresses below its prior
	// behavior.
	structuredItems := recorder.drain()

	// Serialized read-modify-write: a dispatch record or label appended
	// between this load and its save would otherwise be erased by it.
	leaf := ""
	wroteStructured := false
	appendTurn := func(conv *conversation.Conversation) (bool, error) {
		// Recovery-enabled sessions persist their canonical user turn before the
		// delegated CLI starts. On exit only append CLI output: writing userText
		// again would duplicate the exact turn recovery relies on.
		if journal := conversation.ActiveRunRecovery(conv); journal == nil || journal.UserEntryID == "" {
			var userEntry *conversation.SessionEntry
			if displayText != "" {
				userEntry = conversation.AddUserMessageWithDisplay(conv, userText, displayText)
			} else {
				userEntry = conversation.AddUserMessage(conv, userText)
			}
			conversation.ClassifyEntry(userEntry, injectionKind)
		}
		wroteStructured = appendStructuredCliTurn(conv, structuredItems)
		hasRecordedText := false
		for _, it := range structuredItems {
			if it.kind == "text" {
				hasRecordedText = true
				break
			}
		}
		if (!wroteStructured || !hasRecordedText) && assistantText != "" {
			// Text-only fallback, and the completion for a structured recording
			// whose stream carried no text chunks (some backends report the
			// final text only on task_complete). Never runs when the recording
			// already carries text — that would duplicate the same content.
			//
			// No usage annotation: the CLI reported no provider accounting for
			// this turn, and a zero-valued LlmUsage{} would poison the occupancy
			// backward scan (GetContextUsage) into reading ~0 tokens.
			conversation.AddAssistantMessageNoUsage(conv, []types.LlmContentBlock{{Type: "text", Text: assistantText}})
		}
		if conv.LeafID != nil {
			leaf = *conv.LeafID
		}
		return true, nil
	}

	saveErr := conversation.UpdateOnDisk(convID, "", appendTurn)
	if errors.Is(saveErr, conversation.ErrNotFound) {
		// No file yet (first turn on a pre-minted CLI conversation): create it
		// so the turn is not lost. Mirrors the backend's loadOrCreate. There is
		// no on-disk state to race with in this branch.
		conv := conversation.CreateConversation(convID, "", "")
		if _, err := appendTurn(conv); err == nil {
			saveErr = conversation.Save(conv, "")
		}
	}
	if saveErr != nil {
		utils.LogWithFields(utils.LevelWarn, "session.native_session", "persistCliTurn: save failed, turn dropped from Ion store", map[string]any{
			"key": key, "conversation_id": convID, "error": saveErr.Error(),
		})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session.native_session", "persisted delegated-CLI turn into Ion transcript", map[string]any{
		"key": key, "conversation_id": convID, "new_leaf": leaf, "structured": wroteStructured,
		"structured_items": len(structuredItems), "user_bytes": len(userText), "display_bytes": len(displayText), "assistant_bytes": len(assistantText),
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
//
// toolSignature is the run's client-tool signature (empty when the run
// declared no client tools); it rides the cursor so codex resume validity
// can compare tool sets (see NativeSessionCursor.ClientToolSignature).
func (m *Manager) captureNativeSessionCursor(key, convID, kind, cursor, toolSignature string) {
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
			conv.NativeSessions[kind] = conversation.NativeSessionCursor{Cursor: cursor, HeadEntryID: leaf, ClientToolSignature: toolSignature}
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
		s.nativeSessions[kind] = conversation.NativeSessionCursor{Cursor: cursor, HeadEntryID: leaf, ClientToolSignature: toolSignature}
	}
	m.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "session.native_session", "captured native session cursor", map[string]any{
		"key": key, "conversation_id": convID, "kind": kind,
		"cursor": cursor, "head_entry_id": leaf, "persisted": persisted,
	})
}

// invalidateNativeSessionCursor deletes the native-session cursor for a
// backend kind — the inverse of captureNativeSessionCursor, through the same
// in-memory + persisted funnel. Called from handleRunExit when a delegated-CLI
// run reported a terminal error (cliRunFailedTerminal): the native session the
// cursor points at is saturated/broken, and handing it back to `--resume` /
// ThreadResume would put the very next prompt into the same failure. With no
// cursor, resolveCliContinuity bridges from Ion's transcript — Ion-owned
// history that Ion's own compaction can manage.
//
// Best-effort on the persistence half, mirroring capture: a load/save failure
// keeps the deletion in-memory only and logs it (the persisted cursor then
// dies at the next successful capture or a restart re-bridge).
func (m *Manager) invalidateNativeSessionCursor(key, convID, kind string) {
	persisted := false
	if convID != "" && conversation.Exists(convID, "") {
		conv, err := conversation.Load(convID, "")
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "session.native_session", "invalidate: conversation load failed, deleting cursor in-memory only", map[string]any{
				"key": key, "conversation_id": convID, "kind": kind, "error": err.Error(),
			})
		} else if _, has := conv.NativeSessions[kind]; has {
			delete(conv.NativeSessions, kind)
			if saveErr := conversation.Save(conv, ""); saveErr != nil {
				utils.LogWithFields(utils.LevelWarn, "session.native_session", "invalidate: cursor delete persist failed, deleting in-memory only", map[string]any{
					"key": key, "conversation_id": convID, "kind": kind, "error": saveErr.Error(),
				})
			} else {
				persisted = true
			}
		}
	}

	m.mu.Lock()
	if s, ok := m.sessions[key]; ok && s.nativeSessions != nil {
		delete(s.nativeSessions, kind)
	}
	m.mu.Unlock()

	utils.LogWithFields(utils.LevelWarn, "session.native_session", "invalidated native session cursor after terminal cli failure", map[string]any{
		"key": key, "conversation_id": convID, "kind": kind, "persisted": persisted,
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
