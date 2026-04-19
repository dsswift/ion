package backend

import "github.com/dsswift/ion/engine/internal/types"

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
