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

// SkillInvocation is the durable metadata emitted only by the built-in Skill
// tool. Content is full rendered SKILL.md body for current continuation;
// conversation persistence stores a short tool acknowledgment plus typed body.
type SkillInvocation struct {
	Name      string `json:"name"`
	Source    string `json:"source,omitempty"`
	Content   string `json:"content"`
	InvokedAt int64  `json:"invokedAt"`
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
	// SkillInvocation is populated by the built-in Skill tool only. It is
	// engine-internal transfer metadata, never extension RPC or wire output.
	SkillInvocation *SkillInvocation `json:"-"`
	// BackgroundTaskID correlates a tool result with the asynchronous task.
	BackgroundTaskID string `json:"backgroundTaskId,omitempty"`
}
