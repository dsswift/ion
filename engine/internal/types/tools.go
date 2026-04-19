package types

import "context"

// ToolDef defines a tool available to the LLM (from engine/src/tools/types.ts).
type ToolDef struct {
	Name        string
	Description string
	InputSchema map[string]any
	Execute     func(ctx context.Context, input map[string]any, cwd string) (*ToolResult, error)
}

// ToolResult is the output of a tool execution.
type ToolResult struct {
	Content string `json:"content"`
	IsError bool   `json:"isError,omitempty"`
}
