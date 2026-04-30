package backend

import (
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// RunBackend abstracts the LLM execution backend.
// Both ApiBackend (direct API) and CliBackend (Claude CLI wrapper) implement this.
type RunBackend interface {
	StartRun(requestID string, options types.RunOptions)
	Cancel(requestID string) bool
	IsRunning(requestID string) bool

	// WriteToStdin sends a follow-up message to a running process over stdin.
	// Used by CliBackend for bidirectional stream-json communication.
	// ApiBackend returns nil (no stdin pipe -- uses conversation injection).
	WriteToStdin(requestID string, msg interface{}) error

	// FlushConversations persists every in-flight run's conversation to disk.
	// Best-effort; intended for shutdown paths so partially streamed turns
	// survive the engine being killed mid-run.
	FlushConversations()

	// Event channels
	OnNormalized(func(runID string, event types.NormalizedEvent))
	OnExit(func(runID string, code *int, signal *string, sessionID string))
	OnError(func(runID string, err error))
}

// ToolCallInfo describes a tool invocation for the onToolCall hook.
type ToolCallInfo struct {
	ToolName string
	ToolID   string
	Input    map[string]interface{}
}

// ToolCallResult is the hook response that can block a tool call.
type ToolCallResult struct {
	Block  bool
	Reason string
}

// TelemetryCollector is an optional interface for telemetry injection.
type TelemetryCollector interface {
	Event(name string, payload map[string]interface{}, ctx map[string]interface{})
	StartSpan(name string, attrs map[string]interface{}) Span
}

// Span tracks the lifetime of a telemetry span.
type Span interface {
	End(attrs map[string]interface{}, errMsg ...string)
}

// RunHooks bundles every per-run callback the ApiBackend may invoke during a
// run loop. All fields are optional; nil callbacks are treated as no-ops.
//
// The hooks live on each activeRun (rather than the singleton backend) so that
// concurrent runs from different sessions cannot trample each other's
// closures. See engine/internal/backend/api_backend.go for usage.
type RunHooks struct {
	// OnToolCall fires before tool execution and may block the call.
	OnToolCall func(ToolCallInfo) (*ToolCallResult, error)
	// OnPerToolHook fires before ("before") and after ("after") each tool.
	OnPerToolHook func(toolName string, info interface{}, phase string) (interface{}, error)

	OnTurnStart func(runID string, turnNumber int)
	OnTurnEnd   func(runID string, turnNumber int)

	// OnBeforePrompt receives the run ID and current user prompt; may return a
	// rewritten prompt and additional system-prompt content.
	OnBeforePrompt func(runID string, prompt string) (rewrittenPrompt, extraSystemPrompt string)

	// OnPlanModePrompt provides plan-mode prompt customization.
	OnPlanModePrompt func(planFilePath string) (customPrompt string, customTools []string)

	// OnSessionBeforeCompact may cancel a compaction (return true to cancel).
	OnSessionBeforeCompact func(runID string) bool
	// OnSessionCompact observes a completed compaction.
	OnSessionCompact func(runID string, info interface{})

	OnFileChanged func(runID string, path string, action string)

	OnPermissionRequest func(runID string, info interface{})
	OnPermissionDenied  func(runID string, info interface{})

	OnPermissionClassify func(toolName string, input map[string]interface{}) string
}

// RunConfig packages all per-run state that varies between sessions. It is
// passed to ApiBackend.StartRunWithConfig and stored on the matching
// activeRun. Nil-valued fields fall back to backend defaults (no permission
// engine, no external tools, no telemetry, etc.).
//
// Splitting these out of the backend singleton fixes the multi-session
// interlacing bug: with one shared ApiBackend serving multiple desktop tabs,
// per-session hooks were globally mutated on every SendPrompt. A run from tab
// A would then fire hooks captured for tab B. Now each run captures its own
// snapshot.
type RunConfig struct {
	Hooks RunHooks

	PermEngine    *permissions.Engine
	SandboxCfg    *sandbox.Config
	SecurityCfg   *types.SecurityConfig
	ExternalTools []types.LlmToolDef
	McpToolRouter func(name string, input map[string]interface{}) (content string, isErr bool, err error)
	AgentSpawner  tools.AgentSpawner
	Telemetry     TelemetryCollector
}
