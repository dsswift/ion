package session

import (
	"context"
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/backend"
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

// dispatchClear handles the built-in /clear command on a live session. It
// routes the wipe + denial-clear through the shared clearConversationCore so
// the file-only path (ClearConversationFile) and this path carry identical
// semantics, then re-fires session_start (a /clear is a checkpoint that
// re-primes the harness) and emits the shared clear signal. See clear_core.go
// for the rationale behind the single shared core.
func (m *Manager) dispatchClear(s *engineSession, key string) {
	// Run the shared core with this session's key as the known owner. The
	// core clears retained AskUserQuestion / ExitPlanMode denials on the
	// session (so heartbeat / ReconcileState / QuerySessionStatus stop
	// re-publishing a stale card) and wipes the on-disk Messages, preserving
	// the .tree.jsonl tree. It does not emit — we emit below so the
	// session_start re-fire is sequenced correctly relative to the signal.
	res, err := m.clearConversationCore(s.conversationID, key)
	if err != nil {
		utils.Log("Session", fmt.Sprintf("clear: key=%s core failed convID=%s: %v", key, s.conversationID, err))
		m.emitCommandResult(key, "clear", err)
		return
	}
	utils.Log("Session", fmt.Sprintf("clear: key=%s core done convID=%s wiped=%t deniedCleared=%d", key, s.conversationID, res.wiped, res.deniedCleared))

	// Re-fire session_start so the harness can re-prime the now-empty
	// conversation. `/clear` is a checkpoint, not a session restart — the
	// session, extension subprocesses, and MCP connections stay alive. Only
	// the LLM-visible history was wiped above; firing session_start gives the
	// harness a chance to inject whatever bootstrap context it would normally
	// inject for a fresh session. Same pattern as start_session.go's bootstrap
	// path. Fired before the clear signal so any harness-injected state is in
	// place when consumers observe the reset.
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		utils.Log("Session", fmt.Sprintf("firing session_start on clear for session %s", key))
		ctx := m.newExtContext(s, key)
		_ = s.extGroup.FireSessionStart(ctx)
		utils.Log("Session", fmt.Sprintf("session_start re-fired on clear for session %s", key))
	} else {
		utils.Debug("Session", fmt.Sprintf("clear: no extensions loaded for %s, skipping session_start re-fire", key))
	}

	// Emit the single shared clear signal: engine_status (empty denials,
	// reset context-percent) followed by engine_command_result{clear}. This
	// is the same signal ClearConversationFile emits when it finds a live
	// session, so desktop and iOS dismiss the card identically regardless of
	// which clear entry point ran.
	m.emitClearSignal(key)
}

// compactable is the local interface satisfied by any backend that can
// run engine-side compaction in process. ApiBackend (and HybridBackend
// when its current run is API-routed) implements this; CliBackend does
// not — its conversation lives in the Claude Code subprocess, which
// runs its own /compact natively.
//
// This local interface is the mechanism that keeps CompactNow off the
// public RunBackend interface — adding it there would be a contract
// change. Mirrors the steerable pattern in agent.go.
type compactable interface {
	CompactNow(ctx context.Context, req backend.CompactRequest) error
}

// dispatchCompact handles the built-in /compact command. Routes through
// the backend's engine-side compaction (ApiBackend.CompactNow) when the
// backend supports it; falls back to forwarding /compact over the
// stream-json stdin pipe when the backend is the Claude Code CLI wrapper
// so the subprocess can run its native /compact.
//
// Path A — API backend (in-process compaction):
//
//	The conversation lives on disk under the engine's control. CompactNow
//	loads it, runs performCompact("user"), and persists the result with
//	a compact_boundary block and a tree entry. CompactingEvent fires
//	exactly as it does for proactive compaction so consumers can render
//	the same progress UI.
//
// Path B — CLI backend (subprocess forwarding):
//
//	The Claude Code subprocess owns the conversation. We write the literal
//	"/compact" string as a stream-json user message to its stdin so the
//	subprocess executes its own compaction. Only valid while a run is
//	in flight (the stdin pipe is closed at run-end). When no run is
//	active we surface an informational error code the consumer can render
//	as a friendly system message.
//
// Path C — no conversation:
//
//	Empty conversationID is a no-op success, matching the existing
//	clear/export behavior so a /compact on a fresh tab does not return
//	an error event.
func (m *Manager) dispatchCompact(s *engineSession, key string) {
	if s.conversationID == "" {
		utils.Debug("Session", fmt.Sprintf("compact: no conversationID set on session %s", key))
		// Empty-session compact is a no-op success — mirrors clear's behavior.
		m.emitCommandResult(key, "compact", nil)
		return
	}

	// Path A: backend supports engine-side compaction. ApiBackend
	// (and HybridBackend when its run is API-routed) implements
	// compactable; the assertion fails for CliBackend, which falls
	// through to Path B.
	if cb, ok := m.backend.(compactable); ok {
		req := backend.CompactRequest{
			ConversationID: s.conversationID,
			Model:          s.lastModel,
			RequestID:      fmt.Sprintf("user-compact-%s", s.conversationID),
		}
		utils.Log("Session", fmt.Sprintf("compact: dispatching to backend.CompactNow key=%s convID=%s model=%s", key, req.ConversationID, req.Model))
		if err := cb.CompactNow(context.Background(), req); err != nil {
			// Distinguish "conversation not found" from generic errors so
			// the consumer can render a friendlier message. ErrNotFound
			// is wrapped inside CompactNow's load failure; unwrap to test.
			if errors.Is(err, conversation.ErrNotFound) {
				utils.Debug("Session", fmt.Sprintf("compact: conversation %s not found, treating as empty success", s.conversationID))
				m.emitCommandResult(key, "compact", nil)
				return
			}
			utils.Log("Session", fmt.Sprintf("compact: CompactNow failed key=%s err=%v", key, err))
			m.emitCommandResult(key, "compact", err)
			return
		}
		utils.Log("Session", fmt.Sprintf("compacted session %s via CompactNow", key))
		m.emitCommandResult(key, "compact", nil)
		return
	}

	// Path B: CLI backend — forward to the Claude Code subprocess.
	// Without an active run there's no stdin pipe to write to, so we
	// surface an informational error the consumer can render as a
	// system message ("send /compact as a normal prompt instead").
	rid := s.requestID
	if rid == "" {
		utils.Log("Session", fmt.Sprintf("compact: backend does not support engine-side compaction and no active run; key=%s", key))
		m.emit(key, types.EngineEvent{
			Type:         "engine_command_result",
			Command:      "compact",
			CommandError: "compact_requires_active_run",
			EventMessage: "On this backend, /compact must run inside an active conversation. Send /compact as a normal prompt to forward it to the underlying CLI.",
		})
		return
	}

	// Mirror SteerAgent's stdin-message shape so the CLI subprocess
	// parses the line as a user message containing the literal slash
	// command. The Claude Code CLI's slash dispatcher recognises
	// "/compact" inside a user-content text block and runs its own
	// compaction. See engine/internal/backend/cli_backend.go for the
	// stream-json wire shape.
	stdinMsg := map[string]interface{}{
		"type": "user",
		"message": map[string]interface{}{
			"role": "user",
			"content": []map[string]interface{}{
				{"type": "text", "text": "/compact"},
			},
		},
	}
	if err := m.backend.WriteToStdin(rid, stdinMsg); err != nil {
		utils.Log("Session", fmt.Sprintf("compact: WriteToStdin failed key=%s err=%s", key, err.Error()))
		m.emitCommandResult(key, "compact", err)
		return
	}
	utils.Log("Session", fmt.Sprintf("compact: forwarded /compact to CLI subprocess key=%s rid=%s", key, rid))
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
	// engine_status / command_result pair. ExportFormat carries the
	// resolved format so consumers pick an extension / MIME type without
	// sniffing the payload bytes.
	m.emit(key, types.EngineEvent{
		Type:         EngineEventExport,
		EventMessage: output,
		ExportFormat: format,
	})
	m.emitCommandResult(key, "export", nil)
}

// EngineEventExport is the wire type string for the export-payload event
// emitted by dispatchExport. Lives at the session-package level so
// command_registry.go's EngineEventCommandRegistry constant has a
// stylistic peer and external consumers can import the string directly
// from a stable Go symbol rather than copy-pasting the literal.
//
// The event carries the rendered export output (markdown / json / html /
// jsonl, depending on the args passed to /export) on EngineEvent.EventMessage,
// and the resolved format on EngineEvent.ExportFormat so consumers can pick a
// file extension / MIME type without sniffing the payload. Consumers are
// expected to handle the format-specific rendering or download; the engine
// attaches no semantics beyond "this is the export".
//
// Per CLAUDE.md "Engine consumers" framing, this event is one half of the
// contract: the desktop and iOS reference implementations render save-as
// dialogs and share sheets, but external consumers (CLI orchestrators,
// custom harnesses) may pipe the payload to stdout, write it to a
// predetermined path, or stream it back over their own transport. The
// engine has no opinion.
const EngineEventExport = "engine_export"
