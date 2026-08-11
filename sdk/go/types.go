// types.go — the SDK's public value types.
//
// Field names and JSON tags mirror the TypeScript SDK's types.ts and the
// engine's own structs. The engine is the source of truth; where a shape here
// looks arbitrary it is because the wire says so.
package ion

import (
	"context"
	"encoding/json"
)

// ExtensionConfig is the configuration the engine supplies in the init
// handshake and in each invocation's _ctx envelope.
type ExtensionConfig struct {
	// ExtensionDir is the directory this extension was loaded from. Pass it
	// as DispatchAgentOpts.ExtensionDir to give a dispatched child the same
	// extension.
	ExtensionDir string `json:"extensionDir"`
	// Model is the session's configured model.
	Model string `json:"model"`
	// WorkingDirectory is the session's working directory.
	WorkingDirectory string `json:"workingDirectory"`
	// McpConfigPath points at the session's MCP server configuration, when
	// one is configured.
	McpConfigPath string `json:"mcpConfigPath,omitempty"`
}

// EngineEvent is an event emitted onto the session's event stream via
// [Context.Emit]. Type is the discriminator (engine_harness_message,
// engine_agent_state, engine_notify, engine_working_message, and so on) and
// Fields carries the variant's payload, merged at the top level on the wire.
//
// Modelled as an open map rather than a closed union because the engine's
// event set grows and an extension must be able to emit a variant this SDK
// version predates.
type EngineEvent struct {
	// Type is the event discriminator, e.g. "engine_harness_message".
	Type string
	// Fields are the variant's payload keys, serialised alongside type.
	Fields map[string]any
}

// MarshalJSON flattens Type and Fields into one object, which is the wire
// shape the engine's ext/emit handler decodes.
func (e EngineEvent) MarshalJSON() ([]byte, error) {
	out := make(map[string]any, len(e.Fields)+1)
	for k, v := range e.Fields {
		out[k] = v
	}
	out["type"] = e.Type
	return json.Marshal(out)
}

// UnmarshalJSON splits a flat event object back into Type and Fields.
func (e *EngineEvent) UnmarshalJSON(data []byte) error {
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if t, ok := raw["type"].(string); ok {
		e.Type = t
	}
	delete(raw, "type")
	e.Fields = raw
	return nil
}

// NewEvent builds an EngineEvent. Convenience over the struct literal:
//
//	ctx.Emit(ion.NewEvent("engine_harness_message", map[string]any{
//		"message": "build finished",
//	}))
func NewEvent(eventType string, fields map[string]any) EngineEvent {
	return EngineEvent{Type: eventType, Fields: fields}
}

// ToolResult is what a tool returns to the model.
type ToolResult struct {
	// Content is the tool's output as the model will see it.
	Content string `json:"content"`
	// IsError marks the result as a failure. The model still sees Content —
	// this is how a tool reports a problem the model should react to, as
	// distinct from an extension malfunction.
	IsError bool `json:"isError,omitempty"`
}

// ToolDef declares a tool the extension provides to the model.
type ToolDef struct {
	// Name is the tool's identifier as the model calls it.
	Name string `json:"name"`
	// Description tells the model what the tool does and when to use it.
	Description string `json:"description"`
	// Parameters is the tool's JSON Schema.
	Parameters map[string]any `json:"parameters"`
	// PlanModeSafe marks a tool as callable while the session is in plan
	// mode. Read-only tools set it; anything that mutates state must not.
	PlanModeSafe bool `json:"planModeSafe,omitempty"`
	// Execute runs the tool. input is the raw JSON arguments, so a handler
	// can unmarshal into its own typed struct. The context.Context carries
	// the invocation's cancellation.
	Execute func(c context.Context, ctx *Context, input json.RawMessage) (ToolResult, error) `json:"-"`
}

// CommandDef declares a slash command the extension provides.
type CommandDef struct {
	// Description is shown in the command list.
	Description string `json:"description"`
	// Execute runs the command. args is the raw argument string following
	// the command name.
	Execute func(c context.Context, ctx *Context, args string) error `json:"-"`
}

// ProcessInfo describes an entry in the session's process registry.
type ProcessInfo struct {
	Name      string `json:"name"`
	PID       int    `json:"pid"`
	Task      string `json:"task"`
	StartedAt string `json:"startedAt"`
}

// ContextUsage is the running context-window readout for the active run.
type ContextUsage struct {
	// Percent of the context window consumed.
	Percent int `json:"percent"`
	// Tokens consumed.
	Tokens int `json:"tokens"`
	// Cost accumulated, in USD.
	Cost float64 `json:"cost"`
}

// HistoryMatch is one hit from [Context.SearchHistory].
type HistoryMatch struct {
	// Index is the matched message's 0-based position in the conversation.
	Index int `json:"index"`
	// Role is "user", "assistant", "tool", and so on.
	Role string `json:"role"`
	// Type discriminates the matched content: "text", "tool_use",
	// "tool_result".
	Type string `json:"type"`
	// Snippet is an engine-truncated excerpt. Do not assume full content.
	Snippet string `json:"snippet"`
	// ToolName is set when Type references a tool segment.
	ToolName string `json:"toolName,omitempty"`
	// ToolUseID is set when Type references a tool segment.
	ToolUseID string `json:"toolUseId,omitempty"`
}

// SandboxProfile configures [Context.SandboxWrap].
type SandboxProfile struct {
	FSAllowWrite      []string         `json:"fsAllowWrite,omitempty"`
	FSDenyWrite       []string         `json:"fsDenyWrite,omitempty"`
	FSDenyRead        []string         `json:"fsDenyRead,omitempty"`
	NetAllowedDomains []string         `json:"netAllowedDomains,omitempty"`
	NetBlockedDomains []string         `json:"netBlockedDomains,omitempty"`
	NetAllowLocalBind bool             `json:"netAllowLocalBind,omitempty"`
	ExtraPatterns     []SandboxPattern `json:"extraPatterns,omitempty"`
	// Platform overrides the detected platform ("darwin", "linux",
	// "windows"). Leave empty to let the engine detect it.
	Platform string `json:"platform,omitempty"`
}

// SandboxPattern is an additional dangerous-command pattern for the sandbox
// validator to reject.
type SandboxPattern struct {
	Pattern string `json:"pattern"`
	Reason  string `json:"reason"`
}

// SandboxWrapResult is the wrapped command from [Context.SandboxWrap].
type SandboxWrapResult struct {
	// Wrapped is the command string, ready for a shell.
	Wrapped string `json:"wrapped"`
	// Platform is the platform the wrap was generated for.
	Platform string `json:"platform"`
}

// PlanModeState is the session's plan-mode status.
type PlanModeState struct {
	Enabled      bool   `json:"enabled"`
	PlanFilePath string `json:"planFilePath"`
}

// SessionListEntry is one session from [Context.Sessions].List.
type SessionListEntry struct {
	SessionKey     string `json:"sessionKey"`
	ConversationID string `json:"conversationId"`
	ExtensionName  string `json:"extensionName,omitempty"`
	Status         string `json:"status,omitempty"`
}

// NotifyOpts configures [Context.Notify], which sends a push notification
// through the engine's relay pipeline.
//
// A notification is a doorbell, not a payload: the body should say that
// something happened, not carry the content. The content belongs in a
// published resource the client fetches, which is what Kind and ResourceID
// point at.
type NotifyOpts struct {
	// Kind is the resource kind this notification relates to, e.g.
	// "briefing". Required.
	Kind string `json:"kind"`
	// ResourceID identifies the specific item, when there is one.
	ResourceID string `json:"resourceId,omitempty"`
	// Title is the banner headline. Required.
	Title string `json:"title"`
	// Body is the doorbell text. Required.
	Body string `json:"body"`
	// Sound names the notification sound. Empty uses the default.
	Sound string `json:"sound,omitempty"`
	// Scope is the delivery scope: "user" (default), "device", or "all".
	Scope string `json:"scope,omitempty"`
	// ConversationID lets a client navigate to the right tab. Omit for a
	// workspace-level notification.
	ConversationID string `json:"conversationId,omitempty"`
	// TargetSessionKey emits the notification on another session's event
	// stream instead of the caller's. The target must exist.
	TargetSessionKey string `json:"targetSessionKey,omitempty"`
}

// ElicitOptions configures [Context.Elicit], which asks the user for
// structured input.
type ElicitOptions struct {
	// RequestID correlates the response. Generated by the engine when empty.
	RequestID string `json:"requestId,omitempty"`
	// Schema is a JSON Schema describing the requested shape.
	Schema map[string]any `json:"schema,omitempty"`
	// URL opens a web form instead of an in-client prompt.
	URL string `json:"url,omitempty"`
	// Mode selects the elicitation presentation.
	Mode string `json:"mode,omitempty"`
}

// ElicitResult is the user's answer to an elicitation.
type ElicitResult struct {
	// Response is the structured answer. Nil when Cancelled.
	Response map[string]any `json:"response,omitempty"`
	// Cancelled reports that the user dismissed the prompt.
	Cancelled bool `json:"cancelled"`
}

// RunOnceOpts configures [Context.RunOnce].
type RunOnceOpts struct {
	// DebounceMs is the window within which a repeat call is suppressed.
	// Defaults to 60000 when zero.
	DebounceMs int `json:"debounceMs"`
}

// RunOnceResult reports whether a [Context.RunOnce] body ran.
type RunOnceResult struct {
	// Executed reports whether the function ran.
	Executed bool
	// Reason explains a skip: "debounced", "in_flight", and so on.
	Reason string
}
