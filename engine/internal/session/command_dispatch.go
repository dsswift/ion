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
//   - Every dispatch path MUST emit exactly one engine_command_result event.
//     Consumers treat the event as the authoritative "engine handled this
//     command" signal. A missing emit leaves the in-flight conversation
//     hanging — the very defect that motivated the central emit in the
//     first place. emitCommandResult is the only idiomatic way to produce
//     this event; do not inline EngineEvent literals.
//
//     Timing note: most arms emit the result synchronously before returning.
//     The exception is /compact Path A (API backend), which runs an LLM
//     summarization that can take many seconds. To avoid blocking the
//     server's per-connection read loop (SendCommand is called synchronously
//     from server dispatch), that arm launches CompactNow on a goroutine and
//     emits its single result from the goroutine at completion — including
//     from the goroutine's panic-recovery backstop, so the exactly-one-result
//     invariant holds even on panic. See dispatchCompact.
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
			utils.LogWithFields(utils.LevelInfo, "session", "sendcommand: dispatching extension command", map[string]any{"key": key, "command": command, "count": len(args)})
			// Stash the raw slash invocation so that if the handler calls
			// ctx.sendPrompt(expandedBody), SendPrompt can attach the slash
			// provenance to the persisted user turn. This is consumed (cleared)
			// on the next SendPrompt call. Without this, extension-command-
			// resolved slashes persist the expanded body as plain content with
			// no slash metadata, and consumers have no dispatch label to surface after
			// a history reload. Written under the manager lock because
			// SendPrompt reads it under the same lock from a different goroutine
			// (the ext/send_prompt RPC handler goroutine).
			m.mu.Lock()
			s.pendingSlashInvocation = &conversation.SlashInvocation{
				Command: "/" + command,
				Args:    args,
				Source:  "extension",
			}
			m.mu.Unlock()
			ctx := m.newExtContext(s, key)
			err := cmd.Execute(args, ctx)
			m.emitCommandResult(key, command, err)
			return
		}
		utils.LogWithFields(utils.LevelDebug, "session", "sendcommand: name not in extension registry, falling through to built-ins", map[string]any{"key": key, "command": command, "count": len(cmds)})
	} else {
		utils.LogWithFields(utils.LevelDebug, "session", "sendcommand: no extension group on session", map[string]any{"key": key, "command": command})
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
		utils.LogWithFields(utils.LevelInfo, "session", "sendcommand: unknown command", map[string]any{"key": key, "command": command, "count": len(args)})
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
	utils.LogWithFields(utils.LevelInfo, "session", "sendcommand: command failed", map[string]any{"key": key, "command": command, "error": err})
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
		utils.LogWithFields(utils.LevelInfo, "session", "clear: core failed", map[string]any{"key": key, "run_id": s.conversationID, "error": err})
		m.emitCommandResult(key, "clear", err)
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "clear: core done", map[string]any{"key": key, "run_id": s.conversationID, "wiped": res.wiped, "denied_cleared": res.deniedCleared})

	// Re-fire session_start so the harness can re-prime the now-empty
	// conversation. `/clear` is a checkpoint, not a session restart — the
	// session, extension subprocesses, and MCP connections stay alive. Only
	// the LLM-visible history was wiped above; firing session_start gives the
	// harness a chance to inject whatever bootstrap context it would normally
	// inject for a fresh session. Same pattern as start_session.go's bootstrap
	// path. Fired before the clear signal so any harness-injected state is in
	// place when consumers observe the reset.
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		utils.LogWithFields(utils.LevelInfo, "session", "firing session_start on clear for session", map[string]any{"key": key})
		ctx := m.newExtContext(s, key)
		_ = s.extGroup.FireSessionStart(ctx)
		utils.LogWithFields(utils.LevelInfo, "session", "session_start re-fired on clear for session", map[string]any{"key": key})
	} else {
		utils.LogWithFields(utils.LevelDebug, "session", "clear: no extensions loaded for , skipping session_start re-fire", map[string]any{"key": key})
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
// when its current run is API-routed) implements this; ClaudeCodeBackend does
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
		utils.LogWithFields(utils.LevelDebug, "session", "compact: no conversationid set on session", map[string]any{"key": key})
		// Empty-session compact is a no-op success — mirrors clear's behavior.
		m.emitCommandResult(key, "compact", nil)
		return
	}

	// Path A: backend supports engine-side compaction. ApiBackend
	// (and HybridBackend when its run is API-routed) implements
	// compactable; the assertion fails for ClaudeCodeBackend, which falls
	// through to Path B.
	//
	// This path runs asynchronously: CompactNow performs an LLM
	// summarization that can take many seconds, and SendCommand is invoked
	// synchronously from the server's per-connection read loop. Running it
	// inline would stall every other command on that connection for the
	// whole compaction. Instead we validate the guards, mark the session
	// compacting, bind the synthetic runID for event routing, and launch
	// CompactNow on a goroutine that emits the single command_result at
	// completion.
	if cb, ok := m.backend.(compactable); ok {
		m.mu.Lock()
		// Guard 1 (double-run): reject a second /compact while one is in
		// flight rather than launching a concurrent CompactNow that would
		// clobber the first's load-mutate-save cycle.
		if s.compactInFlight {
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelInfo, "session", "compact: rejected — already in flight", map[string]any{"key": key, "run_id": s.conversationID})
			m.emit(key, types.EngineEvent{
				Type:         "engine_command_result",
				Command:      "compact",
				CommandError: "compact_in_progress",
				EventMessage: "A /compact is already running for this conversation. Wait for it to finish before running another.",
			})
			return
		}
		// Guard 2 (compact-during-run): reject when a run is active. A run
		// mutates the conversation in memory and saves it while CompactNow
		// loads a separate copy from disk and saves that — last-writer-wins
		// corruption. The symmetric direction (run-during-compact) is guarded
		// in SendPrompt via s.compactInFlight.
		if s.requestID != "" {
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelInfo, "session", "compact: rejected — run active", map[string]any{"key": key, "run_id": s.requestID})
			m.emit(key, types.EngineEvent{
				Type:         "engine_command_result",
				Command:      "compact",
				CommandError: "compact_requires_idle",
				EventMessage: "Cannot compact while a run is active. Stop the current turn, then run /compact.",
			})
			return
		}
		convID := s.conversationID
		model := s.lastModel
		runID := fmt.Sprintf("user-compact-%s", convID)
		s.compactInFlight = true
		// Bind the synthetic runID -> key so the CompactingEvent progress
		// events CompactNow emits route to this session. Without this the
		// events are dropped (keyForRun returns "" for an unbound runID while
		// s.requestID is empty) and the consumer sees no "Compacting…" UI.
		m.bindRunLocked(runID, key)
		// Capture the session cancellation root under the lock. Running
		// CompactNow under s.rootCtx (not context.Background) keeps the async
		// compaction inside the engine's unified cancellation tree, so Stop
		// (SendAbort) and StopSession teardown abort it. Fall back to
		// Background only for test-constructed sessions that never called
		// newSessionRootContext.
		rootCtx := s.rootCtx
		m.mu.Unlock()
		if rootCtx == nil {
			rootCtx = context.Background()
		}

		req := backend.CompactRequest{
			ConversationID: convID,
			Model:          model,
			RequestID:      runID,
		}
		utils.LogWithFields(utils.LevelInfo, "session", "compact: launching async compactnow", map[string]any{"key": key, "run_id": convID, "model": model, "run_id_3": runID})
		go func() {
			// Cleanup + result invariant. The deferred func always runs: it
			// emits a failure result on panic (preserving exactly-one-result
			// so the consumer's awaiter never hangs), then clears the
			// in-flight flag, unbinds the routing binding, and drains one
			// queued prompt (mirroring handleRunExit).
			defer func() {
				if r := recover(); r != nil {
					utils.LogWithFields(utils.LevelError, "session", "compact: panic in async compactnow", map[string]any{"key": key, "run_id": runID, "r": r})
					m.emitCommandResult(key, "compact", fmt.Errorf("compact panicked: %v", r))
				}
				m.finishCompact(key, runID)
			}()

			if err := cb.CompactNow(rootCtx, req); err != nil {
				// Distinguish "conversation not found" from generic errors so
				// the consumer can render a friendlier message. ErrNotFound
				// is wrapped inside CompactNow's load failure; unwrap to test.
				if errors.Is(err, conversation.ErrNotFound) {
					utils.LogWithFields(utils.LevelDebug, "session", "compact: conversation not found, treating as empty success", map[string]any{"run_id": convID})
					m.emitCommandResult(key, "compact", nil)
					return
				}
				utils.LogWithFields(utils.LevelInfo, "session", "compact: async compactnow failed", map[string]any{"key": key, "run_id": runID, "error": err})
				m.emitCommandResult(key, "compact", err)
				return
			}
			utils.LogWithFields(utils.LevelInfo, "session", "compact: async compactnow complete outcome=success", map[string]any{"key": key, "run_id": runID})
			m.emitCommandResult(key, "compact", nil)
		}()
		return
	}

	// Path B: CLI backend — forward to the Claude Code subprocess.
	// Without an active run there's no stdin pipe to write to, so we
	// surface an informational error the consumer can render as a
	// system message ("send /compact as a normal prompt instead").
	rid := s.requestID
	if rid == "" {
		utils.LogWithFields(utils.LevelInfo, "session", "compact: backend does not support engine-side compaction and no active run;", map[string]any{"key": key})
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
		utils.LogWithFields(utils.LevelInfo, "session", "compact: writetostdin failed", map[string]any{"key": key, "error": err.Error()})
		m.emitCommandResult(key, "compact", err)
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "compact: forwarded /compact to cli subprocess", map[string]any{"key": key, "run_id": rid})
	m.emitCommandResult(key, "compact", nil)
}

// finishCompact is the teardown for the async Path-A compaction goroutine.
// It clears the in-flight flag, removes the synthetic runID -> key routing
// binding, and drains one queued prompt if any accumulated while compaction
// ran. Runs from the goroutine's deferred cleanup so it fires on both the
// success/error and panic paths. Mirrors the terminal-point teardown +
// queue drain that handleRunExit performs for a normal run.
func (m *Manager) finishCompact(key, runID string) {
	m.mu.Lock()
	var nextPrompt *pendingPrompt
	if s, ok := m.sessions[key]; ok {
		s.compactInFlight = false
		m.unbindRunLocked(runID)
		if len(s.promptQueue) > 0 {
			next := s.promptQueue[0]
			s.promptQueue = s.promptQueue[1:]
			nextPrompt = &next
		}
	} else {
		// Session torn down mid-compaction (StopSession). Still clear the
		// routing binding so it doesn't leak; no queue to drain.
		m.unbindRunLocked(runID)
	}
	m.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "session", "compact: finished (compactinflight cleared, binding removed, )", map[string]any{"key": key, "run_id": runID, "next_prompt != nil": nextPrompt != nil})

	if nextPrompt != nil {
		utils.LogWithFields(utils.LevelDebug, "session", "compact: draining queued prompt after compaction", map[string]any{"key": key})
		m.dispatchQueuedPrompt(key, nextPrompt)
	}
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
		utils.LogWithFields(utils.LevelDebug, "session", "export: no conversationid set on session , nothing to export", map[string]any{"key": key})
		// Empty-session export is a no-op success — mirrors clear/compact behavior.
		m.emitCommandResult(key, "export", nil)
		return
	}
	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		if errors.Is(err, conversation.ErrNotFound) {
			utils.LogWithFields(utils.LevelDebug, "session", "export: conversation not found, nothing to export", map[string]any{"run_id": s.conversationID})
			m.emitCommandResult(key, "export", nil)
			return
		}
		utils.LogWithFields(utils.LevelInfo, "session", "export: failed to load conversation", map[string]any{"run_id": s.conversationID, "error": err})
		m.emitCommandResult(key, "export", err)
		return
	}
	format := "markdown"
	if args != "" {
		format = args
	}
	output, err := export.ExportSession(conv, export.Options{Format: format})
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "export failed for", map[string]any{"key": key, "error": err})
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
