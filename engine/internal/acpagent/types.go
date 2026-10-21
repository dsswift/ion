// Package acpagent serves a running Ion engine to an Agent Client Protocol
// client. The `ion acp` command runs one Agent per client process: the
// client (T3 Code, Zed, any ACP editor) speaks JSON-RPC over the process's
// stdio, and the Agent translates every call into engine socket commands
// and every engine event back into ACP session updates.
//
// The engine side is the daemon's ordinary NDJSON socket: an ACP session is
// an engine session whose key the Agent minted, so it lives beside every
// other session in the daemon, including the engine-scoped extension hosts.
// The engine knows nothing about ACP; this package is a client of it.
//
// Wire shapes below are transcribed from the ACP v1 schema
// (schema/v1/schema.json). Only the subset the agent emits or reads is
// modeled; `engine/internal/acp` owns the client-side subset the engine's
// ACP backend speaks to Cursor and Grok.
package acpagent

import "encoding/json"

// ProtocolVersion is the ACP version the agent serves.
const ProtocolVersion = 1

// Agent-side method names (client → agent).
const (
	MethodInitialize             = "initialize"
	MethodAuthenticate           = "authenticate"
	MethodSessionNew             = "session/new"
	MethodSessionLoad            = "session/load"
	MethodSessionPrompt          = "session/prompt"
	MethodSessionCancel          = "session/cancel"
	MethodSessionSetMode         = "session/set_mode"
	MethodSessionSetConfigOption = "session/set_config_option"
)

// Client-side method names (agent → client).
const (
	NotifSessionUpdate      = "session/update"
	ReqRequestPermission    = "session/request_permission"
	ReqElicitationCreate    = "elicitation/create"
	NotifElicitationComplet = "elicitation/complete"
)

// session/update discriminators.
const (
	UpdateUserMessageChunk  = "user_message_chunk"
	UpdateAgentMessageChunk = "agent_message_chunk"
	UpdateAgentThoughtChunk = "agent_thought_chunk"
	UpdateToolCall          = "tool_call"
	UpdateToolCallUpdate    = "tool_call_update"
	UpdateAvailableCommands = "available_commands_update"
	UpdateCurrentMode       = "current_mode_update"
	UpdateConfigOption      = "config_option_update"
	UpdateUsage             = "usage_update"
	UpdateNotice            = "notice"
)

// Stop reasons a prompt turn ends with.
const (
	StopEndTurn         = "end_turn"
	StopMaxTurnRequests = "max_turn_requests"
	StopCancelled       = "cancelled"
)

// Session modes the agent advertises. Build is the engine's ordinary run;
// Plan is engine plan mode (set_plan_mode).
const (
	ModeBuild = "build"
	ModePlan  = "plan"
)

// Config option ids the agent advertises.
const (
	ConfigProfile = "profile"
	ConfigModel   = "model"
	// ProfileNone is the profile value that loads no extensions.
	ProfileNone = "none"
)

// Implementation identifies the client or the agent.
type Implementation struct {
	Name    string `json:"name"`
	Title   string `json:"title,omitempty"`
	Version string `json:"version"`
}

// ClientCapabilities is the subset of the client's declared capabilities the
// agent reads: whether notices and form elicitation reach the user.
type ClientCapabilities struct {
	Session     *ClientSessionCapabilities `json:"session,omitempty"`
	Elicitation *ElicitationCapabilities   `json:"elicitation,omitempty"`
}

// ClientSessionCapabilities carries the session-level client extensions.
type ClientSessionCapabilities struct {
	Notices       json.RawMessage `json:"notices,omitempty"`
	ConfigOptions json.RawMessage `json:"configOptions,omitempty"`
}

// ElicitationCapabilities says which elicitation modes the client renders.
type ElicitationCapabilities struct {
	Form json.RawMessage `json:"form,omitempty"`
	URL  json.RawMessage `json:"url,omitempty"`
}

// InitializeRequest is the "initialize" params.
type InitializeRequest struct {
	ProtocolVersion    int                `json:"protocolVersion"`
	ClientCapabilities ClientCapabilities `json:"clientCapabilities"`
	ClientInfo         *Implementation    `json:"clientInfo,omitempty"`
}

// PromptCapabilities lists the prompt content the agent accepts.
type PromptCapabilities struct {
	Image           bool `json:"image"`
	Audio           bool `json:"audio"`
	EmbeddedContext bool `json:"embeddedContext"`
}

// AgentCapabilities is what the agent advertises on initialize.
type AgentCapabilities struct {
	LoadSession         bool               `json:"loadSession"`
	PromptCapabilities  PromptCapabilities `json:"promptCapabilities"`
	McpCapabilities     map[string]bool    `json:"mcpCapabilities"`
	SessionCapabilities map[string]any     `json:"sessionCapabilities"`
}

// InitializeResponse is the "initialize" result.
type InitializeResponse struct {
	ProtocolVersion   int               `json:"protocolVersion"`
	AgentCapabilities AgentCapabilities `json:"agentCapabilities"`
	AuthMethods       []any             `json:"authMethods"`
	AgentInfo         Implementation    `json:"agentInfo"`
}

// NewSessionRequest is the "session/new" params. McpServers are accepted and
// ignored: the engine's own MCP configuration governs a session.
type NewSessionRequest struct {
	Cwd        string            `json:"cwd"`
	McpServers []json.RawMessage `json:"mcpServers"`
}

// LoadSessionRequest is the "session/load" params.
type LoadSessionRequest struct {
	SessionID  string            `json:"sessionId"`
	Cwd        string            `json:"cwd"`
	McpServers []json.RawMessage `json:"mcpServers"`
}

// SessionMode is one selectable mode.
type SessionMode struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// SessionModeState is the current and available modes.
type SessionModeState struct {
	CurrentModeID  string        `json:"currentModeId"`
	AvailableModes []SessionMode `json:"availableModes"`
}

// SelectOption is one value of a select config option.
type SelectOption struct {
	Value       string `json:"value"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// ConfigOption is a select config option (the agent exposes no booleans).
type ConfigOption struct {
	ID           string         `json:"id"`
	Name         string         `json:"name"`
	Description  string         `json:"description,omitempty"`
	Category     string         `json:"category,omitempty"`
	Type         string         `json:"type"`
	CurrentValue string         `json:"currentValue"`
	Options      []SelectOption `json:"options"`
}

// SessionResponse is the result of session/new and session/load.
type SessionResponse struct {
	SessionID     string            `json:"sessionId,omitempty"`
	Modes         *SessionModeState `json:"modes,omitempty"`
	ConfigOptions []ConfigOption    `json:"configOptions"`
}

// SetSessionModeRequest is the "session/set_mode" params.
type SetSessionModeRequest struct {
	SessionID string `json:"sessionId"`
	ModeID    string `json:"modeId"`
}

// SetConfigOptionRequest is the "session/set_config_option" params. Value is
// the selected value id (a string) for the select options the agent offers.
type SetConfigOptionRequest struct {
	SessionID string          `json:"sessionId"`
	ConfigID  string          `json:"configId"`
	Value     json.RawMessage `json:"value"`
}

// SetConfigOptionResponse returns every option with its current value.
type SetConfigOptionResponse struct {
	ConfigOptions []ConfigOption `json:"configOptions"`
}

// ContentBlock is a prompt or output content block. Text and image are the
// kinds the agent produces; embedded resources decode to their text.
type ContentBlock struct {
	Type     string            `json:"type"`
	Text     string            `json:"text,omitempty"`
	Data     string            `json:"data,omitempty"`
	MimeType string            `json:"mimeType,omitempty"`
	URI      string            `json:"uri,omitempty"`
	Resource *EmbeddedResource `json:"resource,omitempty"`
}

// EmbeddedResource is the payload of a "resource" content block.
type EmbeddedResource struct {
	URI      string `json:"uri"`
	MimeType string `json:"mimeType,omitempty"`
	Text     string `json:"text,omitempty"`
}

// PromptRequest is the "session/prompt" params.
type PromptRequest struct {
	SessionID string         `json:"sessionId"`
	Prompt    []ContentBlock `json:"prompt"`
}

// PromptResponse is the "session/prompt" result.
type PromptResponse struct {
	StopReason string `json:"stopReason"`
}

// CancelNotification is the "session/cancel" params.
type CancelNotification struct {
	SessionID string `json:"sessionId"`
}

// ToolCallContent is one output block of a tool call.
type ToolCallContent struct {
	Type    string       `json:"type"`
	Content ContentBlock `json:"content"`
}

// AvailableCommand is one slash command the session accepts.
type AvailableCommand struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Cost is a cumulative session cost.
type Cost struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

// SessionUpdate is the flattened update union: SessionUpdate names the
// variant and the other fields are set per variant.
type SessionUpdate struct {
	SessionUpdate string `json:"sessionUpdate"`
	// user_message_chunk, agent_message_chunk, agent_thought_chunk
	Content *ContentBlock `json:"content,omitempty"`
	// tool_call, tool_call_update
	ToolCallID  string            `json:"toolCallId,omitempty"`
	Title       string            `json:"title,omitempty"`
	Name        string            `json:"name,omitempty"`
	Kind        string            `json:"kind,omitempty"`
	Status      string            `json:"status,omitempty"`
	ToolContent []ToolCallContent `json:"-"`
	RawInput    json.RawMessage   `json:"rawInput,omitempty"`
	// available_commands_update
	AvailableCommands []AvailableCommand `json:"availableCommands,omitempty"`
	// current_mode_update
	CurrentModeID string `json:"currentModeId,omitempty"`
	// config_option_update
	ConfigOptions []ConfigOption `json:"configOptions,omitempty"`
	// usage_update
	Used *int  `json:"used,omitempty"`
	Size *int  `json:"size,omitempty"`
	Cost *Cost `json:"cost,omitempty"`
	// notice
	Severity    string `json:"severity,omitempty"`
	Description string `json:"description,omitempty"`
}

// MarshalJSON writes the tool-call content under its wire name ("content")
// without colliding with the chunk variants' single content block.
func (u SessionUpdate) MarshalJSON() ([]byte, error) {
	type plain SessionUpdate
	if u.ToolContent == nil {
		return json.Marshal(plain(u))
	}
	base, err := json.Marshal(plain(u))
	if err != nil {
		return nil, err
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(base, &m); err != nil {
		return nil, err
	}
	content, err := json.Marshal(u.ToolContent)
	if err != nil {
		return nil, err
	}
	m["content"] = content
	return json.Marshal(m)
}

// UnmarshalJSON reads "content" back as a single block (the chunk
// variants) or a list of tool-call content (the tool variants).
func (u *SessionUpdate) UnmarshalJSON(data []byte) error {
	type plain SessionUpdate
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return err
	}
	content, hasContent := m["content"]
	if hasContent && len(content) > 0 && content[0] == '[' {
		delete(m, "content")
		data, _ = json.Marshal(m) //nolint:errcheck // re-encoding a map of raw messages cannot fail
		var p plain
		if err := json.Unmarshal(data, &p); err != nil {
			return err
		}
		*u = SessionUpdate(p)
		return json.Unmarshal(content, &u.ToolContent)
	}
	var p plain
	if err := json.Unmarshal(data, &p); err != nil {
		return err
	}
	*u = SessionUpdate(p)
	return nil
}

// SessionNotification is the "session/update" params.
type SessionNotification struct {
	SessionID string        `json:"sessionId"`
	Update    SessionUpdate `json:"update"`
}

// PermissionOption is one approval choice.
type PermissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
}

// ToolCallRef identifies the tool call an approval gates.
type ToolCallRef struct {
	ToolCallID string          `json:"toolCallId"`
	Title      string          `json:"title,omitempty"`
	Kind       string          `json:"kind,omitempty"`
	RawInput   json.RawMessage `json:"rawInput,omitempty"`
}

// RequestPermissionRequest is the "session/request_permission" params.
type RequestPermissionRequest struct {
	SessionID string             `json:"sessionId"`
	ToolCall  ToolCallRef        `json:"toolCall"`
	Options   []PermissionOption `json:"options"`
}

// PermissionOutcome is the reply's outcome: selected (with optionId) or
// cancelled.
type PermissionOutcome struct {
	Outcome  string `json:"outcome"`
	OptionID string `json:"optionId,omitempty"`
}

// RequestPermissionResponse is the "session/request_permission" result.
type RequestPermissionResponse struct {
	Outcome PermissionOutcome `json:"outcome"`
}

// ElicitationCreateRequest is the "elicitation/create" params in form mode.
type ElicitationCreateRequest struct {
	Mode            string         `json:"mode"`
	Message         string         `json:"message"`
	SessionID       string         `json:"sessionId"`
	RequestedSchema map[string]any `json:"requestedSchema"`
}

// ElicitationCreateResponse is the client's answer: accept with content,
// decline, or cancel.
type ElicitationCreateResponse struct {
	Action  string         `json:"action"`
	Content map[string]any `json:"content,omitempty"`
}
