package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// slash_fork.go owns the `context: fork` execution path for resolved slash
// commands. A fork-context command runs its expanded body as a forked sub-agent
// (its own context window and token budget) instead of inlining the expansion
// into the current conversation. This is the engine's generic mechanism; the
// per-command opinion (fork vs. inline) is declared in the template frontmatter.

// forkResolvedSlash persists the raw invocation as the parent conversation's
// display turn, then dispatches the expanded body as a child agent whose events
// stream on the parent's event stream. It does not start an inline run on the
// parent.
//
// opts carries the expanded body (opts.Prompt) and the resolved invocation
// metadata. Called after SendPrompt has released m.mu.
func (m *Manager) forkResolvedSlash(s *engineSession, key string, opts *types.RunOptions) {
	utils.LogWithFields(utils.LevelInfo, "session.slash", "fork dispatch", map[string]any{"session_id": key, "reason": opts.ResolvedSlashCommand, "count": len(opts.Prompt)})

	// Record the raw invocation as the parent's display turn so the user sees
	// the command they ran in the parent scrollback, even though the work runs
	// in a child. Best-effort: a persistence failure must not abort the fork.
	if s.conversationID != "" {
		if conv, err := conversation.Load(s.conversationID, ""); err == nil {
			display := opts.ResolvedSlashCommand
			if opts.ResolvedSlashArgs != "" {
				display = opts.ResolvedSlashCommand + " " + opts.ResolvedSlashArgs
			}
			// Append an invocation-only display entry. DisplayOnly keeps it out
			// of BuildContextPath's LLM reconstruction: the parent conversation
			// does not consume the expansion (the child does), so on the next
			// saveSplit the parent's .llm.jsonl must NOT gain this raw invocation
			// as a user turn. We append the entry directly so conv.Messages is
			// untouched.
			if conv.Entries != nil {
				conversation.AppendEntry(conv, conversation.EntryMessage, conversation.MessageData{
					Role:         "user",
					Content:      display,
					SlashCommand: opts.ResolvedSlashCommand,
					SlashArgs:    opts.ResolvedSlashArgs,
					SlashSource:  opts.ResolvedSlashSource,
					DisplayOnly:  true,
				})
				if saveErr := conversation.Save(conv, ""); saveErr != nil {
					utils.LogWithFields(utils.LevelInfo, "session.slash", "fork: failed to persist parent display turn", map[string]any{"key": key, "error": saveErr})
				}
			}
		} else {
			utils.LogWithFields(utils.LevelInfo, "session.slash", "fork: could not load parent conversation", map[string]any{"key": key, "error": err})
		}
	}

	// Dispatch the expanded body as a child agent. Stream child events on the
	// parent's stream so consumers see the work. The dispatch func is wired with
	// the parent session accessor, so the child inherits the parent's working
	// directory and engine config.
	//
	// Background: true is REQUIRED here. forkResolvedSlash is called from
	// SendPrompt, which runs synchronously on the per-connection dispatch loop
	// (server.handleConnection → dispatch). A foreground DispatchAgent blocks
	// until the entire child run completes — which would stall the connection's
	// command processing (no abort, no further commands) for the whole duration
	// of the forked work. Every normal prompt is non-blocking (StartRun launches
	// a goroutine); the fork path must match. Background dispatch launches the
	// child on its own goroutine (with the panic-recovery backstop and recall
	// registration the background path provides) and returns a stub immediately.
	ctx := m.newExtContext(s, key)
	if ctx.DispatchAgent == nil {
		utils.LogWithFields(utils.LevelError, "session.slash", "fork: dispatchagent unavailable — cannot run forked command", map[string]any{"key": key, "resolved_slash_command": opts.ResolvedSlashCommand})
		m.emit(key, types.EngineEvent{
			Type:         "engine_error",
			EventMessage: fmt.Sprintf("forked command %s could not be dispatched", opts.ResolvedSlashCommand),
			ErrorCode:    "fork_dispatch_unavailable",
		})
		return
	}

	agentName := opts.ResolvedSlashCommand // e.g. "/diagram" — labels the dispatch
	// _ is the stub result returned immediately by the background dispatch; the
	// real outcome arrives via OnEvent (streamed child events) and OnError
	// (runtime failure). err here is only a dispatch-LAUNCH failure.
	_, err := ctx.DispatchAgent(extension.DispatchAgentOpts{
		Name:        agentName,
		Task:        opts.Prompt, // the expanded template body
		Model:       opts.Model,
		ProjectPath: opts.ProjectPath,
		Background:  true,
		OnEvent: func(ev types.EngineEvent) {
			// Stream the child's events on the parent's key so the consumer
			// renders the forked work inline with the parent conversation.
			m.emit(key, ev)
		},
		OnError: func(de extension.DispatchError) {
			// Background runtime failure: the synchronous return already
			// succeeded (stub), so a non-zero child exit surfaces here. Emit
			// the same engine_error shape the launch-failure path uses so the
			// consumer learns the forked command failed.
			utils.LogWithFields(utils.LevelInfo, "session.slash", "fork child errored", map[string]any{"key": key, "model": agentName, "exit_code": de.ExitCode, "message": de.Message})
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: fmt.Sprintf("forked command %s failed: %s", agentName, de.Message),
				ErrorCode:    "fork_dispatch_failed",
			})
		},
	})
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "session.slash", "fork dispatch launch failed", map[string]any{"key": key, "model": agentName, "error": err})
		m.emit(key, types.EngineEvent{
			Type:         "engine_error",
			EventMessage: fmt.Sprintf("forked command %s failed: %v", agentName, err),
			ErrorCode:    "fork_dispatch_failed",
		})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session.slash", "fork dispatch launched (background)", map[string]any{"key": key, "model": agentName})
}
