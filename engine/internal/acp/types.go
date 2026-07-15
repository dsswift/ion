// Package acp is a typed client for the Agent Client Protocol (ACP), the
// JSON-RPC 2.0 over stdio protocol spoken by Zed-style agent CLIs (grok's
// `grok agent stdio`, cursor's `agent acp`). It layers over internal/rpcstdio
// and owns the ACP wire shapes; the ACP backend translates these into engine
// NormalizedEvents.
//
// Wire shapes are transcribed from the ACP generated schema (protocol version
// 1). Only the subset the engine uses is modeled.
package acp

import "encoding/json"

// ProtocolVersion is the ACP wire version the engine negotiates.
const ProtocolVersion = 1

// --- method strings (client → agent requests) ---

const (
	MethodInitialize       = "initialize"
	MethodAuthenticate     = "authenticate"
	MethodSessionNew       = "session/new"
	MethodSessionLoad      = "session/load"
	MethodSessionPrompt    = "session/prompt"
	MethodSessionSetModel  = "session/set_model"
	MethodCursorListModels = "cursor/list_available_models"
)

// MethodSessionCancel is a client → agent notification (no response).
const MethodSessionCancel = "session/cancel"

// NotifSessionUpdate is the agent → client streaming notification.
const NotifSessionUpdate = "session/update"

// ReqRequestPermission is the agent → client approval request.
const ReqRequestPermission = "session/request_permission"

// --- session/update discriminator values (the "sessionUpdate" field) ---

const (
	UpdateAgentMessageChunk = "agent_message_chunk"
	UpdateAgentThoughtChunk = "agent_thought_chunk"
	UpdateToolCall          = "tool_call"
	UpdateToolCallUpdate    = "tool_call_update"
	UpdatePlan              = "plan"
)

// --- permission outcome + option kinds ---

const (
	OutcomeSelected  = "selected"
	OutcomeCancelled = "cancelled"
)

// --- handshake ---

// ClientInfo identifies the connecting client.
type ClientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// ClientCapabilities advertises what the client supports. The engine keeps
// filesystem/terminal delegation off; the agent runs its own tools.
type ClientCapabilities struct {
	FS       FSCapability `json:"fs"`
	Terminal bool         `json:"terminal"`
}

// FSCapability declares filesystem-delegation support (both off for Ion).
type FSCapability struct {
	ReadTextFile  bool `json:"readTextFile"`
	WriteTextFile bool `json:"writeTextFile"`
}

// InitializeParams is the "initialize" request payload.
type InitializeParams struct {
	ProtocolVersion    int                `json:"protocolVersion"`
	ClientInfo         ClientInfo         `json:"clientInfo"`
	ClientCapabilities ClientCapabilities `json:"clientCapabilities"`
}

// AuthMethod is one authentication option the agent offers.
type AuthMethod struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// AgentCapabilities describes what the agent supports. LoadSession gates
// session/load.
type AgentCapabilities struct {
	LoadSession bool `json:"loadSession"`
}

// ModelInfo is one selectable model.
type ModelInfo struct {
	ModelID     string `json:"modelId"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// ModelState carries the current and available models.
type ModelState struct {
	CurrentModelID  string      `json:"currentModelId"`
	AvailableModels []ModelInfo `json:"availableModels"`
}

// InitializeResult is the "initialize" response payload.
type InitializeResult struct {
	ProtocolVersion   int               `json:"protocolVersion"`
	AgentCapabilities AgentCapabilities `json:"agentCapabilities"`
	AuthMethods       []AuthMethod      `json:"authMethods"`
	Meta              *struct {
		ModelState *ModelState `json:"modelState,omitempty"`
	} `json:"_meta,omitempty"`
}

// --- authenticate ---

// AuthenticateParams is the "authenticate" request payload.
type AuthenticateParams struct {
	MethodID string `json:"methodId"`
}

// --- session lifecycle ---

// SessionNewParams is the "session/new" request payload.
type SessionNewParams struct {
	Cwd        string `json:"cwd"`
	McpServers []any  `json:"mcpServers,omitempty"`
}

// SessionResult is the shared result of session/new and session/load.
type SessionResult struct {
	SessionID string      `json:"sessionId,omitempty"`
	Models    *ModelState `json:"models,omitempty"`
}

// SessionLoadParams is the "session/load" request payload.
type SessionLoadParams struct {
	SessionID  string `json:"sessionId"`
	Cwd        string `json:"cwd"`
	McpServers []any  `json:"mcpServers,omitempty"`
}

// --- prompt ---

// ContentBlock is a single prompt content block. Only text is produced by the
// engine; richer blocks decode but are not emitted.
type ContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// NewTextPrompt builds a single-text-block prompt.
func NewTextPrompt(text string) []ContentBlock {
	return []ContentBlock{{Type: "text", Text: text}}
}

// SessionPromptParams is the "session/prompt" request payload.
type SessionPromptParams struct {
	SessionID string         `json:"sessionId"`
	Prompt    []ContentBlock `json:"prompt"`
}

// PromptUsage is the optional token/cost usage in a prompt result.
type PromptUsage struct {
	Used int `json:"used"`
	Size int `json:"size"`
}

// SessionPromptResult is the "session/prompt" response payload. StopReason is
// one of end_turn, max_tokens, max_turn_requests, refusal, cancelled.
type SessionPromptResult struct {
	StopReason string       `json:"stopReason"`
	Usage      *PromptUsage `json:"usage,omitempty"`
}

// --- cancel / set model ---

// SessionCancelParams is the "session/cancel" notification payload.
type SessionCancelParams struct {
	SessionID string `json:"sessionId"`
}

// SessionSetModelParams is the "session/set_model" request payload.
type SessionSetModelParams struct {
	SessionID string `json:"sessionId"`
	ModelID   string `json:"modelId"`
}

// --- cursor model extension ---

// CursorModel is one model from cursor/list_available_models.
type CursorModel struct {
	Value string `json:"value"`
	Name  string `json:"name"`
}

// CursorListModelsResult is the cursor/list_available_models response.
type CursorListModelsResult struct {
	Models []CursorModel `json:"models"`
}

// --- session/update notification ---

// SessionUpdateNotification is the "session/update" payload envelope.
type SessionUpdateNotification struct {
	SessionID string        `json:"sessionId"`
	Update    SessionUpdate `json:"update"`
}

// SessionUpdate is the discriminated update union, flattened. SessionUpdate
// names the variant; the other fields are populated per variant.
type SessionUpdate struct {
	SessionUpdate string        `json:"sessionUpdate"`
	Content       *ContentBlock `json:"content,omitempty"`
	ToolCallID    string        `json:"toolCallId,omitempty"`
	Title         string        `json:"title,omitempty"`
	Kind          string        `json:"kind,omitempty"`
	Status        string        `json:"status,omitempty"`
	// ToolContent carries tool_call/tool_call_update output blocks.
	ToolContent json.RawMessage `json:"toolContent,omitempty"`
}

// --- session/request_permission ---

// PermissionOption is one approval choice offered by the agent.
type PermissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
}

// ToolCallRef identifies the tool call an approval is gating.
type ToolCallRef struct {
	ToolCallID string `json:"toolCallId"`
	Title      string `json:"title,omitempty"`
	Kind       string `json:"kind,omitempty"`
}

// RequestPermissionParams is the "session/request_permission" request payload.
type RequestPermissionParams struct {
	SessionID string             `json:"sessionId"`
	ToolCall  ToolCallRef        `json:"toolCall"`
	Options   []PermissionOption `json:"options"`
}

// PermissionOutcome is the reply to a permission request. When Outcome is
// "selected", OptionID names the chosen option; "cancelled" omits it.
type PermissionOutcome struct {
	Outcome  string `json:"outcome"`
	OptionID string `json:"optionId,omitempty"`
}
