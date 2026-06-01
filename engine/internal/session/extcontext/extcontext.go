// Package extcontext builds extension.Context values from a SessionAccessor
// interface, decoupling the extension wiring from concrete session internals.
package extcontext

import (
	"context"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/types"
)

// SessionAccessor abstracts the session fields and manager operations that
// NewExtContext needs. The session package provides a concrete implementation
// that delegates to *Manager and *engineSession with appropriate locking.
type SessionAccessor interface {
	SessionKey() string
	WorkingDirectory() string
	Emit(ev types.EngineEvent)
	SendAbort()
	SendPrompt(text string, model string) error
	Elicit(info extension.ElicitationRequestInfo) (map[string]interface{}, bool, error)
	SuppressTool(name string)
	CacheExtAgentStates(agents []types.AgentStateUpdate)
	RegisterAgent(name string, handle types.AgentHandle)
	DeregisterAgent(name string)
	RegisterAgentSpec(spec types.AgentSpec)
	DeregisterAgentSpec(name string)
	LookupAgentSpec(name string) (types.AgentSpec, bool)
	ExtGroup() *extension.ExtensionGroup
	ExtConfig() *extension.ExtensionConfig
	ProcRegistry() *extension.ProcessRegistry
	NewChildBackend() backend.RunBackend
	EngineConfig() *types.EngineRuntimeConfig
	ResolveTier(name string) string
	PermissionCheck(toolName string, input map[string]interface{}) (decision string, reason string)
	McpConnections() []*mcp.Connection

	// SearchHistory searches the active conversation's history for content
	// that may have been compacted. Returns nil when no conversation is active.
	SearchHistory(query string, maxResults int) []extension.HistoryMatch

	// GetSessionMemory returns the current session memory content.
	// Returns empty string when session memory is not active.
	GetSessionMemory() string

	// SetSessionMemory replaces the session memory with custom content
	// and persists it to disk. Extensions can use this to provide their
	// own summarization strategies.
	SetSessionMemory(content string)

	// TranslateEvent converts a NormalizedEvent to an EngineEvent. The
	// implementation lives in the session package (translateToEngineEvent)
	// so test coverage is unchanged.
	TranslateEvent(ev types.NormalizedEvent, contextWindow int) types.EngineEvent

	// SetPlanMode flips the session's plan mode state. source is a free-form
	// string for log observability (e.g. "extension", "slash_command").
	SetPlanMode(enabled bool, source string)

	// GetPlanModeState returns (planModeEnabled, planFilePath) for the session.
	GetPlanModeState() (bool, string)

	// AppendOrUpdateAgentState creates a new agent state entry or updates
	// an existing one (matched by name). Returns the entry's ID.
	AppendOrUpdateAgentState(state types.AgentStateUpdate) string

	// UpdateAgentStateByID finds an agent state entry by its ID and applies
	// the updater function.
	UpdateAgentStateByID(id string, updater func(*types.AgentStateUpdate))

	// EmitAgentSnapshot emits the current merged agent state snapshot as
	// an engine_agent_state event.
	EmitAgentSnapshot(reason string)
}

// NewExtContext builds a fully-populated extension.Context by delegating all
// callbacks to the provided SessionAccessor. The optional DispatchRegistry
// enables background dispatch and recall support; pass nil to disable.
func NewExtContext(sa SessionAccessor, registries ...*DispatchRegistry) *extension.Context {
	// Accept an optional registry via variadic to avoid breaking existing callers.
	var registry *DispatchRegistry
	if len(registries) > 0 {
		registry = registries[0]
	}

	ctx := &extension.Context{
		SessionKey: sa.SessionKey(),
		Cwd:        sa.WorkingDirectory(),
		Emit: func(ev types.EngineEvent) {
			if ev.Type == "engine_agent_state" {
				// Cache extension-emitted agent states, then re-emit a merged
				// snapshot that includes engine-managed entries (dispatch state
				// with task, conversationId, progress). Forwarding the raw
				// extension event would overwrite engine-managed entries on
				// the desktop due to the complete-snapshot contract.
				sa.CacheExtAgentStates(ev.Agents)
				sa.EmitAgentSnapshot("ext_emit_merged")
				return
			}
			sa.Emit(ev)
		},
		Abort: func() { sa.SendAbort() },
		RegisterAgent: func(name string, handle types.AgentHandle) {
			sa.RegisterAgent(name, handle)
		},
		DeregisterAgent: func(name string) {
			sa.DeregisterAgent(name)
		},
		RegisterAgentSpec: func(spec types.AgentSpec) {
			if spec.Name == "" {
				return
			}
			sa.RegisterAgentSpec(spec)
		},
		DeregisterAgentSpec: func(name string) {
			sa.DeregisterAgentSpec(name)
		},
		LookupAgentSpec: func(name string) (types.AgentSpec, bool) {
			return sa.LookupAgentSpec(name)
		},
		ResolveTier: func(name string) string {
			return sa.ResolveTier(name)
		},
		SuppressTool: func(name string) {
			sa.SuppressTool(name)
		},
		Elicit: func(info extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
			return sa.Elicit(info)
		},
		CallTool: func(toolName string, input map[string]interface{}) (string, bool, error) {
			return CallToolFromExtension(context.Background(), sa, toolName, input)
		},
		CallToolWithContext: func(toolName string, input map[string]interface{}, timeoutMs *float64) (string, bool, error) {
			callCtx := context.Background()
			if timeoutMs != nil && *timeoutMs > 0 {
				var cancel context.CancelFunc
				callCtx, cancel = context.WithTimeout(callCtx, time.Duration(*timeoutMs)*time.Millisecond)
				defer cancel()
			}
			return CallToolFromExtension(callCtx, sa, toolName, input)
		},
		SendPrompt: func(text string, model string) error {
			return sa.SendPrompt(text, model)
		},
		SearchHistory: func(query string, maxResults int) ([]extension.HistoryMatch, error) {
			matches := sa.SearchHistory(query, maxResults)
			return matches, nil
		},
		GetSessionMemory: func() (string, error) {
			return sa.GetSessionMemory(), nil
		},
		SetSessionMemory: func(content string) error {
			sa.SetSessionMemory(content)
			return nil
		},
		SetPlanMode: func(enabled bool, source string) {
			sa.SetPlanMode(enabled, source)
		},
		GetPlanMode: func() (bool, string) {
			return sa.GetPlanModeState()
		},
	}

	// Wire process lifecycle management.
	if reg := sa.ProcRegistry(); reg != nil {
		ctx.RegisterProcess = func(name string, pid int, task string) error {
			return reg.Register(name, pid, task)
		}
		ctx.DeregisterProcess = func(name string) {
			reg.Deregister(name)
		}
		ctx.ListProcesses = func() []extension.ProcessInfo {
			return reg.List()
		}
		ctx.TerminateProcess = func(name string) error {
			return reg.Terminate(name)
		}
		ctx.CleanStaleProcesses = func() int {
			return reg.CleanStale()
		}
	}

	// Wire engine-native agent dispatch.
	ctx.DispatchAgent = BuildDispatchAgentFunc(sa, registry)

	// Wire recall support for background dispatches.
	if registry != nil {
		ctx.RecallAgent = func(name string, opts extension.RecallAgentOpts) (bool, error) {
			reason := opts.Reason
			if reason == "" {
				reason = "recall_agent"
			}
			found := registry.Recall(name, reason)
			return found, nil
		}
	}

	// Wire the lightweight one-shot inference primitive. Always available
	// (no nil check needed at call sites) because the closure itself
	// handles every error path with a typed return value. Same accessor
	// powers DispatchAgent and LLMCall — provider routing, hook firing,
	// and event emission go through the same plumbing.
	ctx.LLMCall = BuildLLMCallFunc(sa)

	// Populate extension config if available.
	if eg := sa.ExtGroup(); eg != nil && !eg.IsEmpty() {
		ctx.Config = &extension.ExtensionConfig{
			WorkingDirectory: sa.WorkingDirectory(),
		}
	}

	// Wire agent discovery.
	ctx.DiscoverAgents = BuildDiscoverAgentsFunc(sa)

	return ctx
}
