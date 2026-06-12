package session

import (
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/export"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// command_dispatch.go owns the per-command arms invoked by Manager.SendCommand.
// The dispatch was extracted from manager.go in the review pass so the god-file
// stays at a manageable size and the per-command logic is searchable as
// independent units. Behavior is unchanged from the original SendCommand body;
// the only mechanical difference is the new emitCommandResult helper that
// collapses the previously near-duplicated EngineEvent literal blocks.
//
// Contract reminders for anyone touching this file:
//
//   - Every dispatch path MUST emit exactly one engine_command_result event
//     before returning. Consumers treat the event as the authoritative
//     "engine handled this command" signal. A missing emit leaves the
//     in-flight conversation hanging — the very defect that motivated the
//     central emit in the first place. emitCommandResult is the only
//     idiomatic way to produce this event; do not inline EngineEvent
//     literals.
//
//   - Unknown commands (neither an extension command nor a built-in) emit
//     CommandError="unknown_command" so consumers can route to whatever
//     fallback they own (e.g. local `.md` template expansion). See the
//     default arm in dispatchCommand for the canonical shape.
//
//   - Extension commands take priority over built-ins. An extension that
//     registers a command named "clear" would shadow the engine's
//     conversation-clearing built-in. This is intentional: extensions
//     opt in to overriding by registering the name, and the engine logs
//     the routing so the precedence is auditable.

// dispatchCommand is the body of SendCommand minus the session-lookup guard.
// SendCommand is a thin wrapper that handles the session-not-found early
// return; the real work is here so the file boundary tracks the logical
// boundary (lookup vs. dispatch) rather than file-size pressure.
func (m *Manager) dispatchCommand(s *engineSession, key, command, args string) {
	// Extension commands take precedence over built-ins. See the contract
	// comment at the top of this file for the rationale.
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		cmds := s.extGroup.Commands()
		if cmd, exists := cmds[command]; exists {
			utils.Log("Session", fmt.Sprintf("SendCommand: dispatching extension command key=%s command=%s argsLen=%d", key, command, len(args)))
			ctx := m.newExtContext(s, key)
			err := cmd.Execute(args, ctx)
			m.emitCommandResult(key, command, err)
			return
		}
		utils.Debug("Session", fmt.Sprintf("SendCommand: name not in extension registry, falling through to built-ins key=%s command=%s extCount=%d", key, command, len(cmds)))
	} else {
		utils.Debug("Session", fmt.Sprintf("SendCommand: no extension group on session key=%s command=%s", key, command))
	}

	switch command {
	case "clear":
		m.dispatchClear(s, key)
	case "compact":
		m.dispatchCompact(s, key)
	case "export":
		m.dispatchExport(s, key, args)
	default:
		// Unknown command — neither an extension command nor a built-in.
		// Emit an engine_command_result with CommandError populated so
		// consumers can route to whatever fallback they own. This
		// replaces the silent log-only behavior the engine carried
		// before commit b002a1cb, which left in-flight conversations
		// hanging when a slash-command name didn't resolve.
		utils.Log("Session", fmt.Sprintf("SendCommand: unknown command key=%s command=%s argsLen=%d", key, command, len(args)))
		m.emit(key, types.EngineEvent{
			Type:         "engine_command_result",
			EventMessage: "unknown command: " + command,
			Command:      command,
			CommandError: "unknown_command",
		})
	}
}

// emitCommandResult constructs and emits a single engine_command_result
// event with the canonical shape consumers expect. When err is nil the
// result is success-flavored ("command executed: <name>"); when err is
// non-nil the result is failure-flavored with both EventMessage and
// CommandError populated. This is the single seam that replaces the
// five near-duplicate EngineEvent literal blocks the original SendCommand
// body carried.
//
// Important: this helper is for the *generic* success / extension-failure
// case. Built-in arms that need to interleave other emits (e.g. /clear
// also emits engine_status before its command_result) call this for the
// final event but build their interim events inline.
func (m *Manager) emitCommandResult(key, command string, err error) {
	if err == nil {
		m.emit(key, types.EngineEvent{
			Type:         "engine_command_result",
			EventMessage: "command executed: " + command,
			Command:      command,
		})
		return
	}
	utils.Log("Session", fmt.Sprintf("SendCommand: command failed key=%s command=%s err=%v", key, command, err))
	m.emit(key, types.EngineEvent{
		Type:         "engine_command_result",
		EventMessage: fmt.Sprintf("command failed: %s: %v", command, err),
		Command:      command,
		CommandError: err.Error(),
	})
}

// dispatchClear handles the built-in /clear command. Wipes the
// LLM-visible conversation history, resets the context-percent counter,
// re-fires session_start so the harness can re-prime, and emits a
// command_result. Same path used to live inline in SendCommand; the
// extraction is mechanical.
func (m *Manager) dispatchClear(s *engineSession, key string) {
	if s.conversationID == "" {
		utils.Debug("Session", fmt.Sprintf("clear: no conversationID set on session %s, nothing to wipe", key))
		// Still emit success on a never-talked-to session so consumers
		// see the same "clear executed" signal regardless of whether
		// there was any conversation to wipe. The conversation was
		// already "empty" so /clear semantically succeeded.
		m.emitCommandResult(key, "clear", nil)
		return
	}
	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		if errors.Is(err, conversation.ErrNotFound) {
			// Pre-minted ID with no prompt sent yet — conversation file
			// doesn't exist. Treat as already-empty (same as the "" path).
			utils.Debug("Session", fmt.Sprintf("clear: conversation %s not found, treating as empty", s.conversationID))
			m.emitCommandResult(key, "clear", nil)
			return
		}
		utils.Log("Session", fmt.Sprintf("clear: failed to load conversation %s: %v", s.conversationID, err))
		m.emitCommandResult(key, "clear", err)
		return
	}
	conv.Messages = nil
	conv.LastInputTokens = 0
	conv.LastInputTokensMsgCount = 0
	_ = conversation.Save(conv, "")
	s.lastContextPct = 0
	utils.Log("Session", fmt.Sprintf("cleared conversation id=%s for session %s — .tree.jsonl preserved", s.conversationID, key))
	// Emit the engine_status snapshot first so consumers can mirror the
	// reset context-percent before they see the command_result event. The
	// order matters: consumers that mirror context-percent from every
	// engine_status event would briefly observe a stale percent if the
	// command_result arrived first.
	m.emit(key, types.EngineEvent{
		Type: "engine_status",
		Fields: &types.StatusFields{
			State:          m.sessionState(s),
			ContextPercent: 0,
			ContextWindow:  s.lastContextWindow,
			Model:          s.lastModel,
			TotalCostUsd:   s.lastTotalCost,
		},
	})
	// Re-fire session_start so the harness can re-prime the now-empty
	// conversation. `/clear` is a checkpoint, not a session restart —
	// the session, extension subprocesses, and MCP connections stay
	// alive. Only the LLM-visible history was wiped above; firing
	// session_start gives the harness a chance to inject whatever
	// bootstrap context it would normally inject for a fresh session.
	// Same pattern as start_session.go's bootstrap path.
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		utils.Log("Session", fmt.Sprintf("firing session_start on clear for session %s", key))
		ctx := m.newExtContext(s, key)
		_ = s.extGroup.FireSessionStart(ctx)
		utils.Log("Session", fmt.Sprintf("session_start re-fired on clear for session %s", key))
	} else {
		utils.Debug("Session", fmt.Sprintf("clear: no extensions loaded for %s, skipping session_start re-fire", key))
	}
	// Emit an engine-driven result so consumers see a single
	// authoritative "clear executed" event rather than inferring it
	// locally. The Command field carries the name verbatim so a
	// subscriber can switch on it without re-parsing EventMessage.
	m.emitCommandResult(key, "clear", nil)
}

// dispatchCompact handles the built-in /compact command. Calls the
// conversation package's compaction helper (10-message tail by default)
// and emits a command_result.
func (m *Manager) dispatchCompact(s *engineSession, key string) {
	if s.conversationID == "" {
		utils.Debug("Session", fmt.Sprintf("compact: no conversationID set on session %s", key))
		// Empty-session compact is a no-op success — mirrors clear's behavior.
		m.emitCommandResult(key, "compact", nil)
		return
	}
	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		if errors.Is(err, conversation.ErrNotFound) {
			utils.Debug("Session", fmt.Sprintf("compact: conversation %s not found, treating as empty", s.conversationID))
			m.emitCommandResult(key, "compact", nil)
			return
		}
		utils.Log("Session", fmt.Sprintf("compact: failed to load conversation %s: %v", s.conversationID, err))
		m.emitCommandResult(key, "compact", err)
		return
	}
	conversation.Compact(conv, 10)
	_ = conversation.Save(conv, "")
	utils.Log("Session", fmt.Sprintf("compacted session %s", key))
	m.emitCommandResult(key, "compact", nil)
}

// dispatchExport handles the built-in /export command. The optional args
// string carries the format ("markdown" by default; any value the export
// package recognizes is accepted). Emits an engine_export event carrying
// the rendered output, then the command_result.
//
// Like /clear and /compact, /export emits exactly one engine_command_result
// before returning. Every code path calls emitCommandResult — including the
// empty-conversation and load-failure paths that previously returned silently.
func (m *Manager) dispatchExport(s *engineSession, key, args string) {
	if s.conversationID == "" {
		utils.Debug("Session", fmt.Sprintf("export: no conversationID set on session %s, nothing to export", key))
		// Empty-session export is a no-op success — mirrors clear/compact behavior.
		m.emitCommandResult(key, "export", nil)
		return
	}
	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		if errors.Is(err, conversation.ErrNotFound) {
			utils.Debug("Session", fmt.Sprintf("export: conversation %s not found, nothing to export", s.conversationID))
			m.emitCommandResult(key, "export", nil)
			return
		}
		utils.Log("Session", fmt.Sprintf("export: failed to load conversation %s: %v", s.conversationID, err))
		m.emitCommandResult(key, "export", err)
		return
	}
	format := "markdown"
	if args != "" {
		format = args
	}
	output, err := export.ExportSession(conv, export.Options{Format: format})
	if err != nil {
		utils.Log("Session", fmt.Sprintf("export failed for %s: %s", key, err))
		m.emitCommandResult(key, "export", err)
		return
	}
	// engine_export fires before engine_command_result so consumers receive
	// the payload before the completion signal — mirrors the ordering
	// invariant dispatchClear documents at command_dispatch.go for the
	// engine_status / command_result pair.
	m.emit(key, types.EngineEvent{
		Type:         "engine_export",
		EventMessage: output,
	})
	m.emitCommandResult(key, "export", nil)
}
