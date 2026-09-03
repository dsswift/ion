package session

import (
	"errors"
	"fmt"
	"os"
	"strings"

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
	// clearEntryID is the canonical tree-entry id of the display-only `/clear`
	// invocation row the core persists immediately before the EntryCleared
	// marker. Empty when no file was wiped (nothing to persist). Callers emit
	// it via engine_user_turn_persisted so consumers can re-key their optimistic
	// `/clear` entry to this id and a history reload dedups against it — the same
	// re-key contract every other slash command already has. See dispatchClear.
	clearEntryID string
}

// ClearConversationFile wipes the LLM-visible history on a stored conversation
// file by sessionId, without requiring a live engine session. It is the
// stateless counterpart of dispatchClear: it performs the same load → zero
// → save sequence but does not emit any events (no session exists to emit to)
// and does not re-fire session_start (no extension group is loaded).
//
// Fields wiped (matches dispatchClear exactly):
//   - Messages           — the flat LLM-visible message list
//   - (token counters are not persisted as scalars — GetContextUsage reads
//     them from LlmMessage.Usage via the backward scan)
//
// Fields preserved: Entries, LeafID, TotalInputTokens, TotalOutputTokens,
// TotalCost, ID, System, Model, CreatedAt, Version, ParentID,
// WorkingDirectory — same rationale as dispatchClear (/clear is a checkpoint,
// not a delete).
//
// Returns nil on success. Returns an error if the conversation file cannot be
// loaded or saved; in that case no partial write occurs (Load/Save are atomic
// operations at the file level).
func (m *Manager) ClearConversationFile(sessionID string) error {
	_, err := m.ClearConversationFileWithOptions(sessionID, false)
	return err
}

// ClearConversationFileWithOptions is ClearConversationFile plus the
// `/clear --keep-plan` behavior, so the file-only path (a tab loaded from disk
// but never prompted, cleared by id) retains a plan exactly as the live-session
// path does. When keepPlan is true and the conversation's tree holds an
// unimplemented plan, retainPlanForClear re-injects that plan into the cleared
// context; the retained slug is returned so the caller (server dispatch) can
// hand it back to the client that will render the notice locally — the file-only
// path may own no live session to emit a signal to.
func (m *Manager) ClearConversationFileWithOptions(sessionID string, keepPlan bool) (string, error) {
	utils.LogWithFields(utils.LevelInfo, "session", "clearconversationfile: clearing conversation", map[string]any{"run_id": sessionID, "keep_plan": keepPlan})
	// Route through the shared clear core (preferKey empty → the core does a
	// reverse lookup over live sessions by conversationID). This guarantees
	// the file-only clear path carries identical semantics to the
	// live-session /clear: if a live session owns this conversation, its
	// retained AskUserQuestion / ExitPlanMode denials are cleared and the
	// shared clear signal is emitted so desktop and iOS dismiss the pending
	// card. If no live session owns it, the file is still wiped and there is
	// no in-memory card to dismiss (the consumer's restore-time rule handles
	// a later reopen).
	res, err := m.clearConversationCore(sessionID, "")
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "clearconversationfile: core failed", map[string]any{"run_id": sessionID, "error": err})
		return "", err
	}
	// Retain the plan after the wipe, exactly as dispatchClear does. Runs on
	// the file whether or not a live session owns it, so a never-prompted tab
	// keeps its plan too.
	keptSlug := ""
	if keepPlan {
		keptSlug = retainPlanForClear(sessionID)
		utils.LogWithFields(utils.LevelInfo, "session", "clearconversationfile: keep-plan outcome", map[string]any{"run_id": sessionID, "retained": keptSlug != "", "plan_slug": keptSlug})
	}
	if res.sessionKey != "" {
		utils.LogWithFields(utils.LevelInfo, "session", "clearconversationfile: owned by live session — emitting shared clear signal", map[string]any{"run_id": sessionID, "session_key": res.sessionKey, "denied_cleared": res.deniedCleared})
		m.emitClearSignal(res.sessionKey, keepPlan, keptSlug)
	} else {
		utils.LogWithFields(utils.LevelInfo, "session", "clearconversationfile: (no live session owner, no signal to emit)", map[string]any{"run_id": sessionID, "wiped": res.wiped})
	}
	return keptSlug, nil
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
		utils.LogWithFields(utils.LevelDebug, "session", "clearcore: empty conversationid (nothing to wipe on disk)", map[string]any{"prefer_key": preferKey, "denied_cleared": res.deniedCleared})
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
		utils.LogWithFields(utils.LevelInfo, "session", "clearcore: owned by live session", map[string]any{"conversation_id": conversationID, "session_key": res.sessionKey, "denied_cleared": res.deniedCleared})
	} else {
		utils.LogWithFields(utils.LevelInfo, "session", "clearcore: has no live session (file-only wipe)", map[string]any{"conversation_id": conversationID})
	}

	fileResult, err := clearConversationFile(conversationID)
	if err != nil {
		return res, err
	}
	res.wiped = fileResult.wiped
	res.clearEntryID = fileResult.clearEntryID
	utils.LogWithFields(utils.LevelInfo, "session", "clearcore: conversation file clear complete", map[string]any{
		"conversation_id": conversationID, "clear_entry_id": res.clearEntryID,
		"session_key": res.sessionKey, "denied_cleared": res.deniedCleared, "wiped": res.wiped,
	})
	return res, nil
}

// clearConversationFile performs only the durable part of a clear. It does not
// read or lock Manager state. This separation lets SendPrompt clear a resolved
// command while it already owns m.mu, without recursively locking the mutex.
func clearConversationFile(conversationID string) (clearResult, error) {
	res := clearResult{}
	conv, err := conversation.Load(conversationID, "")
	if err != nil {
		if errors.Is(err, conversation.ErrNotFound) {
			// Pre-minted id with no prompt sent yet — file doesn't exist.
			// Treat as already-empty: a semantic success with nothing to wipe.
			utils.LogWithFields(utils.LevelDebug, "session", "clearcore: file not found, treating as already-empty", map[string]any{"conversation_id": conversationID})
			return res, nil
		}
		utils.LogWithFields(utils.LevelInfo, "session", "clearcore: load failed", map[string]any{"conversation_id": conversationID, "error": err})
		return res, fmt.Errorf("load conversation %q: %w", conversationID, err)
	}

	conv.Messages = nil
	// Persist the `/clear` invocation as a DisplayOnly user entry chained
	// BEFORE the EntryCleared marker. This makes /clear symmetric with every
	// other slash command (which the run loop persists as a user turn carrying
	// slash provenance), so the invocation is a persisted display turn with a
	// canonical tree-entry id that a consumer can re-key its optimistic entry
	// to. Without this row the optimistic entry had nothing to reconcile against
	// and was ordered inconsistently on reload/replay.
	//
	// DisplayOnly keeps the row OUT of BuildContextPath (see tree.go), so a
	// rebuilt .llm.jsonl never resurrects the invocation as a real user turn —
	// the LLM context stays empty, which is the whole point of /clear. Tree
	// order (invocation → marker) means flattenEntries yields the invocation row
	// then the divider row, matching the live insert order.
	clearEntry := conversation.AppendEntry(conv, conversation.EntryMessage, conversation.MessageData{
		Role:         "user",
		Content:      "/clear",
		SlashCommand: "/clear",
		SlashSource:  "ion",
		DisplayOnly:  true,
	})
	if clearEntry != nil {
		res.clearEntryID = clearEntry.ID
	}
	conversation.AppendEntry(conv, conversation.EntryCleared, conversation.ClearedData{})
	if err := conversation.Save(conv, ""); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "clearcore: save failed", map[string]any{"conversation_id": conversationID, "error": err})
		return res, fmt.Errorf("save conversation %q: %w", conversationID, err)
	}
	res.wiped = true
	return res, nil
}

// clearSessionDenials drops the retained PermissionDenials AND resets context
// occupancy on the live session keyed by key — the /clear semantics, where the
// conversation's messages are wiped so zero tokens is the truth. Returns the
// key (echoed for caller convenience) and the number of denials cleared. Safe
// to call when the session does not exist (returns "", 0).
//
// Callers that dismiss a card WITHOUT emptying the conversation must use
// dropRetainedDenials instead; see its comment for why conflating the two
// would make the engine misreport occupancy.
func (m *Manager) clearSessionDenials(key string) (string, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.clearSessionDenialsLocked(key)
}

// clearSessionDenialsLocked is the lock-aware form used by prompt dispatch,
// which already owns m.mu while it resolves command frontmatter.
func (m *Manager) clearSessionDenialsLocked(key string) (string, int) {
	sessionKey, n := m.dropRetainedDenialsLocked(key, "/clear dismisses pending question/plan card")
	if sessionKey == "" {
		return "", 0
	}
	s := m.sessions[key]
	// A clear empties the LLM-visible messages, so occupancy is zero. Reset
	// both values together so every later status snapshot reports the truth.
	s.lastContextPct = 0
	s.lastContextTokens = 0
	return sessionKey, n
}

// dropRetainedDenials drops ONLY the retained PermissionDenials on the live
// session keyed by key, leaving context occupancy untouched. Returns the key
// (echoed for caller convenience) and the number of denials cleared. Safe to
// call when the session does not exist (returns "", 0). Holds the manager lock
// for the mutation so the clear is race-free with concurrent status emits.
//
// Split out of clearSessionDenials because the two callers dismiss a card for
// different reasons and only one of them empties the conversation. /clear wipes
// the LLM-visible messages, so zeroing occupancy alongside the denial is
// correct there. Resolving a card changes no messages at all: the conversation
// still holds everything it did a moment earlier, so reporting zero tokens
// would make the engine lie about occupancy and every consumer's context meter
// would read empty until the next real usage event.
//
// `reason` is logged so the two dismissal paths stay distinguishable in
// engine.jsonl.
func (m *Manager) dropRetainedDenials(key, reason string) (string, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.dropRetainedDenialsLocked(key, reason)
}

func (m *Manager) dropRetainedDenialsLocked(key, reason string) (string, int) {
	s, ok := m.sessions[key]
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session", "dropretaineddenials: not found", map[string]any{"key": key, "reason": reason})
		return "", 0
	}
	n := len(s.lastPermissionDenials)
	if n > 0 {
		utils.LogWithFields(utils.LevelInfo, "session", "dropretaineddenials: clearing retained permission_denials", map[string]any{"key": key, "n": n, "reason": reason})
		s.lastPermissionDenials = nil
	} else {
		utils.LogWithFields(utils.LevelDebug, "session", "dropretaineddenials: none retained", map[string]any{"key": key, "reason": reason})
	}
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
//
// keepPlan / keptSlug carry the `/clear --keep-plan` outcome onto the final
// engine_command_result so a consumer renders a keep-plan-aware notice: keepPlan
// echoes that the flag was requested, keptSlug is the retained plan's slug (empty
// when the flag found no unimplemented plan to keep). Both are zero for an
// ordinary /clear.
func (m *Manager) emitClearSignal(key string, keepPlan bool, keptSlug string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	var window int
	var model string
	var cost float64
	var state string
	var epoch int64
	if ok {
		window = s.lastContextWindow
		model = s.lastModel
		cost = s.lastTotalCost
		state = m.sessionState(s)
		epoch = s.runEpoch
	}
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session", "emitclearsignal: not found, emitting command_result only", map[string]any{"key": key})
		m.emitClearCommandResult(key, keepPlan, keptSlug)
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "emitclearsignal: emitting engine_status(empty denials) + command_result", map[string]any{"key": key})
	m.emit(key, types.EngineEvent{
		Type: "engine_status",
		Fields: &types.StatusFields{
			State: state,
			// Hand-built snapshot: stamp the epoch explicitly so a /clear
			// during a live run does not read as older than that run.
			RunEpoch:       epoch,
			ContextPercent: 0,
			ContextTokens:  0,
			ContextWindow:  window,
			Model:          model,
			RunCostUsd:     cost,
			// Explicitly nil — engine_status is a full snapshot, and /clear
			// just dismissed any retained AskUserQuestion / ExitPlanMode
			// denial. Stating nil documents the dismissal and guards against
			// a future edit carrying a stale denial onto this snapshot.
			PermissionDenials: nil,
			// NOT nil, for the same full-snapshot reason: /clear resets the
			// conversation, it does not kill the session's background Bash
			// processes. Omitting them would erase live work from every
			// consumer's view.
			ActiveBackgroundTasks: liveBackgroundTaskStates(key),
		},
	})
	m.emitClearCommandResult(key, keepPlan, keptSlug)
}

// emitClearCommandResult emits the single success-flavored
// engine_command_result{command:"clear"} carrying the keep-plan outcome. It is
// the clear-specific analogue of emitCommandResult(key, "clear", nil): both
// produce "command executed: clear", but this one stamps ClearKeepPlan /
// ClearKeptPlanSlug so consumers render the retained-plan / no-plan notice.
func (m *Manager) emitClearCommandResult(key string, keepPlan bool, keptSlug string) {
	m.emit(key, types.EngineEvent{
		Type:              "engine_command_result",
		EventMessage:      "command executed: clear",
		Command:           "clear",
		ClearKeepPlan:     keepPlan,
		ClearKeptPlanSlug: keptSlug,
	})
}

// ClearArgsRequestKeepPlan reports whether a /clear argument string requested
// the --keep-plan behavior. The flag rides the existing command args string
// (no new wire field): the desktop sends `clear` with args "--keep-plan". Any
// whitespace-delimited token equal to "--keep-plan" enables it; every other
// argument is ignored, so an ordinary /clear (empty args) is unaffected.
//
// Exported so both callers share one definition: the live-session path
// (dispatchClear, below) and server.dispatchCommand's file-only
// clear_conversation_file case, which used to substring-match the same flag
// independently and would have silently diverged on an argument like
// "--keep-plan-extra".
func ClearArgsRequestKeepPlan(args string) bool {
	for _, tok := range strings.Fields(args) {
		if tok == "--keep-plan" {
			return true
		}
	}
	return false
}

// buildRetainedPlanTurn renders the single machine-authored user turn that
// re-seeds a freshly-cleared conversation with the retained plan. The preamble
// names the situation so the model treats the markdown as the plan to continue
// from rather than as a stray document, and the slug (when known) labels which
// plan was kept.
func buildRetainedPlanTurn(planSlug, planMarkdown string) string {
	var b strings.Builder
	b.WriteString("The conversation history was cleared to start fresh, but this plan was kept so the work continues from it.")
	if planSlug != "" {
		b.WriteString(" Plan: ")
		b.WriteString(planSlug)
		b.WriteString(".")
	}
	b.WriteString("\n\n")
	b.WriteString(planMarkdown)
	return b.String()
}

// retainPlanForClear resolves the latest unimplemented plan on conversationID's
// tree and, when one exists, re-injects its markdown into the just-cleared
// conversation as a single machine-authored user turn
// (InjectionKindPlanRetained). Returns the retained plan's slug, or "" when
// there is no unimplemented plan or its file is unreadable (the "clear +
// notice" outcome).
//
// It runs AFTER clearConversationCore has wiped conv.Messages and appended
// EntryCleared: the wipe never touches the tree's plan markers or
// implementation-phase user turns, so LatestUnimplementedPlan still resolves
// them on the context path. The reload here reads that just-saved post-clear
// state (Messages == nil, leaf == EntryCleared), so AddUserMessageWithKind
// appends the plan as the ONLY LLM-visible message and as a tree child of the
// clear boundary — exactly the [plan] context the next prompt continues from.
func retainPlanForClear(conversationID string) string {
	if conversationID == "" {
		return ""
	}
	conv, err := conversation.Load(conversationID, "")
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "keepplan: load failed, nothing to retain", map[string]any{"conversation_id": conversationID, "error": err})
		return ""
	}
	planPath, planSlug, found := conversation.LatestUnimplementedPlan(conv)
	if !found {
		// The tree is the only authority here, and it now records a marker on
		// every backend. Answering from the session's live planFilePath instead
		// would ignore the implementation-phase verdict LatestUnimplementedPlan
		// just returned, and re-seed the context with a plan the conversation
		// had already moved past. LatestUnimplementedPlan logs which of its
		// three not-found branches it took.
		utils.LogWithFields(utils.LevelInfo, "session", "keepplan: no unimplemented plan on path", map[string]any{"conversation_id": conversationID})
		return ""
	}
	planMarkdown, err := os.ReadFile(planPath) //nolint:gosec // path comes from the engine's own persisted plan marker
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "keepplan: plan file unreadable, nothing to retain", map[string]any{"conversation_id": conversationID, "plan_file_path": planPath, "error": err})
		return ""
	}
	conversation.AddUserMessageWithKind(conv, buildRetainedPlanTurn(planSlug, string(planMarkdown)), string(types.InjectionKindPlanRetained))
	if err := conversation.Save(conv, ""); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "keepplan: save failed after injection", map[string]any{"conversation_id": conversationID, "plan_file_path": planPath, "error": err})
		return ""
	}
	utils.LogWithFields(utils.LevelInfo, "session", "keepplan: plan retained and re-injected into cleared context", map[string]any{
		"conversation_id": conversationID, "plan_file_path": planPath, "plan_slug": planSlug, "bytes": len(planMarkdown),
	})
	return planSlug
}

// ResolvePermissionDenials drops the session's retained AskUserQuestion /
// ExitPlanMode denials because the consumer resolved them by its own means.
// Wire-protocol entrypoint for the resolve_permission_denials client command.
//
// Why this exists as a first-class command. The engine retains unresolved
// denials so every status snapshot tells a re-attaching consumer that a
// question is still outstanding (status_work_snapshot.go). Retention is
// released on exactly two paths: a new prompt supersedes the question
// (prompt_dispatch.go), or /clear discards it (clearConversationCore above).
// Neither covers a resolution that produces no prompt and no clear — a user
// dismissing the card is the common case. A consumer in that position had no
// way to inform the engine, so the engine kept re-publishing the denial on
// every heartbeat and the consumer had to suppress the echo locally, forever.
// That local suppression is load-bearing state with no recovery: if anything
// drops the consumer's copy of the card, the re-publication it needs to heal
// is the very thing its own suppression is discarding.
//
// This is the third path, and it is mechanism only. The engine takes no
// position on WHY the question was resolved (dismissed, answered elsewhere, no
// longer relevant) and holds no opinion about what the consumer shows. A
// consumer that never sends this command behaves exactly as before.
//
// Emits a fresh status snapshot after clearing so every attached consumer —
// not just the caller — converges on the same authoritative state. Without the
// emit, a second client would keep showing a card the first client resolved.
//
// Returns silently when no session owns the key, matching ReconcileState and
// QuerySessionStatus. A consumer may resolve a card for a conversation whose
// session has already exited; there is nothing to clear and it is not an error.
func (m *Manager) ResolvePermissionDenials(key string) {
	sessionKey, n := m.dropRetainedDenials(key, "consumer resolved the card")
	if sessionKey == "" {
		utils.LogWithFields(utils.LevelDebug, "session", "resolvepermissiondenials: no live session for key", map[string]any{"key": key})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "resolvepermissiondenials: consumer resolved retained denials", map[string]any{"key": key, "denied_cleared": n})
	// Re-emit status so the cleared snapshot reaches every consumer. Reuses
	// the shared snapshot path, so the payload is identical to a heartbeat
	// tick and carries the now-empty PermissionDenials.
	m.emitStatusSnapshot(key, "denials_resolved")
}
