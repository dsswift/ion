// Package extension implements the Ion Engine extension SDK and host.
// Port of engine/src/extension-sdk.ts + extension-host.ts.
package extension

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Hook event names. 66 hooks across 15 categories.
const (
	// Lifecycle hooks
	HookSessionStart = "session_start"
	HookSessionEnd   = "session_end"
	HookBeforePrompt = "before_prompt"
	HookTurnStart    = "turn_start"
	HookTurnEnd      = "turn_end"
	HookMessageStart = "message_start"
	HookMessageEnd   = "message_end"
	HookToolStart    = "tool_start"
	HookToolEnd      = "tool_end"
	HookToolCall     = "tool_call"
	HookOnError      = "on_error"
	HookAgentStart   = "agent_start"
	HookAgentEnd     = "agent_end"

	// Session management hooks
	HookSessionBeforeCompact = "session_before_compact"
	HookSessionCompact       = "session_compact"
	HookSessionBeforeFork    = "session_before_fork"
	HookSessionFork          = "session_fork"
	HookSessionBeforeSwitch  = "session_before_switch"

	// Pre-action hooks
	HookBeforeAgentStart      = "before_agent_start"
	HookBeforeProviderRequest = "before_provider_request"

	// Early-stop continuation hooks. Fire around the engine's decision to
	// nudge the model to keep working when it emits end_turn / stop below
	// the configured token budget. See docs/hooks/reference.md.
	HookBeforeEarlyStopDecision = "before_early_stop_decision" // influence: handler can override the decision
	HookEarlyStopContinued      = "early_stop_continued"       // observe: handler sees a continuation that just fired

	// Content hooks
	HookContext       = "context"
	HookMessageUpdate = "message_update"
	HookToolResult    = "tool_result"
	HookInput         = "input"
	HookModelSelect   = "model_select"
	HookUserBash      = "user_bash"

	// Per-tool call hooks
	HookBashToolCall  = "bash_tool_call"
	HookReadToolCall  = "read_tool_call"
	HookWriteToolCall = "write_tool_call"
	HookEditToolCall  = "edit_tool_call"
	HookGrepToolCall  = "grep_tool_call"
	HookGlobToolCall  = "glob_tool_call"
	HookAgentToolCall = "agent_tool_call"

	// Per-tool result hooks
	HookBashToolResult  = "bash_tool_result"
	HookReadToolResult  = "read_tool_result"
	HookWriteToolResult = "write_tool_result"
	HookEditToolResult  = "edit_tool_result"
	HookGrepToolResult  = "grep_tool_result"
	HookGlobToolResult  = "glob_tool_result"
	HookAgentToolResult = "agent_tool_result"

	// Context discovery hooks
	HookContextDiscover = "context_discover"
	HookContextLoad     = "context_load"
	HookInstructionLoad = "instruction_load"

	// Permission hooks
	HookPermissionRequest  = "permission_request"
	HookPermissionDenied   = "permission_denied"
	HookPermissionClassify = "permission_classify"

	// File change hooks
	//
	// HookFileChanged fires only after the LLM's Write or Edit tool has
	// successfully written a file. It is NOT a filesystem watcher -- external
	// edits (user saving a file in their editor, a shell script writing to
	// disk, an MCP server modifying state) do not fire it. For external-edit
	// notifications subscribe to HookWorkspaceFileChanged instead.
	HookFileChanged = "file_changed"

	// HookWorkspaceFileChanged fires when any non-ignored file or directory
	// inside the session's working directory is created, modified, or deleted
	// by anything (including the LLM's tools, the user's editor, shell
	// commands, etc.). Backed by an engine-owned recursive fsnotify watcher
	// rooted at EngineConfig.WorkingDirectory. Paths outside the working
	// directory are NOT covered -- extensions interested in those install
	// their own watchers via node:fs.watch in their subprocess.
	HookWorkspaceFileChanged = "workspace_file_changed"

	// Task lifecycle hooks
	HookTaskCreated   = "task_created"
	HookTaskCompleted = "task_completed"

	// Elicitation hooks
	HookElicitationRequest = "elicitation_request"
	HookElicitationResult  = "elicitation_result"

	// Plan mode hooks
	HookPlanModePrompt      = "plan_mode_prompt"
	HookBeforePlanModeEnter = "before_plan_mode_enter"
	HookBeforePlanModeExit  = "before_plan_mode_exit"
	HookSystemInject        = "system_inject"

	// Context injection hooks
	HookContextInject = "context_inject"

	// Capability framework hooks
	HookCapabilityDiscover = "capability_discover"
	HookCapabilityMatch    = "capability_match"
	HookCapabilityInvoke   = "capability_invoke"

	// Extension lifecycle hooks. Fire after the engine auto-respawns a
	// crashed extension subprocess (see Manager.respawnDeadExtensions).
	// Observational only — no return value affects engine behaviour.
	HookExtensionRespawned     = "extension_respawned"      // payload: {attemptNumber, prevExitCode, prevSignal}
	HookTurnAborted            = "turn_aborted"             // payload: {reason: "extension_died"}
	HookPeerExtensionDied      = "peer_extension_died"      // payload: {name, exitCode, signal}
	HookPeerExtensionRespawned = "peer_extension_respawned" // payload: {name, attemptNumber}
)

// SDK is the extension hook registry. It manages hook handlers, tools,
// commands, and capabilities registered by extensions.
type SDK struct {
	mu            sync.RWMutex
	hooks         map[string][]HookHandler
	tools         []ToolDefinition
	commands      map[string]CommandDefinition
	capabilities  map[string]Capability
	appendEntryFn func(entryType string, data interface{}) error
	// onCommandsChange is invoked (outside the lock) after any successful
	// RegisterCommand so the owning session can emit an engine_command_registry
	// snapshot to its clients. The SDK itself does not know about session keys
	// or event types — the callback indirection keeps that policy in the
	// session manager where it belongs. Nil is valid (no observer wired).
	onCommandsChange func()
}

// NewSDK creates a new extension SDK with empty registries.
func NewSDK() *SDK {
	return &SDK{
		hooks:        make(map[string][]HookHandler),
		commands:     make(map[string]CommandDefinition),
		capabilities: make(map[string]Capability),
	}
}

// On registers a handler for the given hook event.
func (s *SDK) On(event string, handler HookHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hooks[event] = append(s.hooks[event], handler)
}

// PrependHook inserts a handler at the front of the hook chain for the given
// event. Used for enterprise required hooks that must run before extensions.
func (s *SDK) PrependHook(event string, handler HookHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hooks[event] = append([]HookHandler{handler}, s.hooks[event]...)
}

// RegisterTool adds a tool definition to the registry.
func (s *SDK) RegisterTool(def ToolDefinition) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tools = append(s.tools, def)
}

// RegisterCommand adds a slash command to the registry. After the map is
// updated, the optional onCommandsChange observer is invoked (outside the
// lock) so the owning session can broadcast a fresh registry snapshot to its
// clients. Callable from any goroutine, including from inside a hook handler
// while a session is already running -- the snapshot semantics on the wire
// (always full set, never a diff) make late registrations safe.
func (s *SDK) RegisterCommand(name string, def CommandDefinition) {
	s.mu.Lock()
	_, replaced := s.commands[name]
	s.commands[name] = def
	cb := s.onCommandsChange
	s.mu.Unlock()
	if replaced {
		utils.Log("extension", fmt.Sprintf("RegisterCommand: replaced existing entry name=%s", name))
	} else {
		utils.Log("extension", fmt.Sprintf("RegisterCommand: added name=%s desc=%q", name, def.Description))
	}
	if cb != nil {
		cb()
	} else {
		utils.Debug("extension", fmt.Sprintf("RegisterCommand: no onCommandsChange observer wired for name=%s", name))
	}
}

// SetOnCommandsChange wires an observer that will be invoked (outside the
// SDK's internal lock) after every RegisterCommand call. The session manager
// uses this to emit an engine_command_registry snapshot whenever the command
// table mutates. Pass nil to clear. Safe to call concurrently with
// RegisterCommand -- the swap itself is under the lock; the observer set when
// a particular RegisterCommand returns is the one that fires for that call.
func (s *SDK) SetOnCommandsChange(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onCommandsChange = fn
	utils.Debug("extension", fmt.Sprintf("SetOnCommandsChange: observer %s", boolStr(fn != nil, "wired", "cleared")))
}

// boolStr is a tiny helper used by logging to render a boolean as one of two
// strings. Lives here to avoid importing strconv just for log text.
func boolStr(b bool, t, f string) string {
	if b {
		return t
	}
	return f
}

// Tools returns all registered tool definitions.
func (s *SDK) Tools() []ToolDefinition {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ToolDefinition, len(s.tools))
	copy(out, s.tools)
	return out
}

// Commands returns all registered command definitions.
func (s *SDK) Commands() map[string]CommandDefinition {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]CommandDefinition, len(s.commands))
	for k, v := range s.commands {
		out[k] = v
	}
	return out
}

// AppendEntry adds a custom session entry via the active conversation.
// This allows extensions to inject entries (labels, custom data) into the session tree.
func (s *SDK) AppendEntry(entryType string, data interface{}) error {
	s.mu.RLock()
	fn := s.appendEntryFn
	s.mu.RUnlock()
	if fn == nil {
		return fmt.Errorf("appendEntry not available: no active session")
	}
	return fn(entryType, data)
}

// SetAppendEntryFn sets the function used by AppendEntry.
// Called by the session manager when a session is active.
func (s *SDK) SetAppendEntryFn(fn func(entryType string, data interface{}) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendEntryFn = fn
}

// Handlers returns a snapshot of handlers for the given event.
func (s *SDK) Handlers(event string) []HookHandler {
	s.mu.RLock()
	defer s.mu.RUnlock()
	handlers := s.hooks[event]
	out := make([]HookHandler, len(handlers))
	copy(out, handlers)
	return out
}

// fire iterates all handlers for an event, logging errors without propagating.
// Returns all non-nil results.
func (s *SDK) fire(event string, ctx *Context, payload interface{}) []interface{} {
	handlers := s.Handlers(event)
	var results []interface{}
	for i, h := range handlers {
		result, err := h(ctx, payload)
		if err != nil {
			utils.Log("extension", fmt.Sprintf("hook %s handler[%d] error: %v", event, i, err))
			continue
		}
		if result != nil {
			results = append(results, result)
		}
	}
	return results
}
