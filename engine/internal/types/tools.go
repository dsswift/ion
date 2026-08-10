package types

import "context"

// ToolDef defines a tool available to the LLM (from engine/src/tools/types.ts).
type ToolDef struct {
	Name         string
	Description  string
	InputSchema  map[string]any
	PlanModeSafe bool
	Execute      func(ctx context.Context, input map[string]any, cwd string) (*ToolResult, error)
}

// ToolResult is the output of a tool execution.
type ToolResult struct {
	Content string         `json:"content"`
	IsError bool           `json:"isError,omitempty"`
	Images  []*ImageSource `json:"images,omitempty"` // durable vision images returned alongside text
	// ContentItems preserves ordered typed MCP content for extension consumers.
	// It is never rendered or decoded by the engine.
	ContentItems []ToolContent `json:"contentItems,omitempty"`
	// EphemeralImages feed this turn's provider request only. json:"-" ensures
	// MCP bytes never enter extension RPC, events, telemetry, or conversation
	// persistence by default.
	EphemeralImages []*ImageSource `json:"-"`
}
