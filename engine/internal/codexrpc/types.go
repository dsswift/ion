// Package codexrpc is a typed client for the OpenAI `codex app-server`
// JSON-RPC 2.0 protocol, layered over internal/rpcstdio. It owns the wire
// shapes and method strings; the codex backend (internal/backend) translates
// these into engine NormalizedEvents and drives the run lifecycle.
//
// Wire shapes are transcribed from the codex app-server generated schema.
// Only the subset the engine uses is modeled; unmodeled fields decode into
// json.RawMessage or are ignored.
package codexrpc

import "encoding/json"

// --- Method strings (client → server requests) ---

const (
	MethodInitialize    = "initialize"
	MethodAccountRead   = "account/read"
	MethodModelList     = "model/list"
	MethodThreadStart   = "thread/start"
	MethodThreadResume  = "thread/resume"
	MethodTurnStart     = "turn/start"
	MethodTurnInterrupt = "turn/interrupt"
	MethodTurnSteer     = "turn/steer"
	MethodLoginStart    = "account/login/start"
	MethodLoginCancel   = "account/login/cancel"
	MethodLogout        = "account/logout"
)

// --- Notification methods (client → server) ---

const MethodInitialized = "initialized"

// --- Notification methods (server → client) ---

const (
	NotifThreadStarted      = "thread/started"
	NotifAgentMessageDelta  = "item/agentMessage/delta"
	NotifReasoningTextDelta = "item/reasoning/textDelta"
	NotifCommandOutputDelta = "item/commandExecution/outputDelta"
	NotifItemStarted        = "item/started"
	NotifItemCompleted      = "item/completed"
	NotifTokenUsageUpdated  = "thread/tokenUsage/updated"
	NotifTurnCompleted      = "turn/completed"
	NotifError              = "error"
	NotifLoginCompleted     = "account/login/completed"
)

// --- Server → client request methods (approvals) ---

const (
	ReqCommandApproval    = "item/commandExecution/requestApproval"
	ReqFileChangeApproval = "item/fileChange/requestApproval"
)

// Approval decision values (the "decision" field of an approval response).
const (
	DecisionAccept           = "accept"
	DecisionAcceptForSession = "acceptForSession"
	DecisionDecline          = "decline"
	DecisionCancel           = "cancel"
)

// --- Handshake ---

// ClientInfo identifies the connecting client in the initialize handshake.
type ClientInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Title   string `json:"title,omitempty"`
}

// InitializeParams is the "initialize" request payload.
type InitializeParams struct {
	ClientInfo ClientInfo `json:"clientInfo"`
}

// InitializeResult is the "initialize" response payload.
type InitializeResult struct {
	CodexHome      string `json:"codexHome"`
	PlatformFamily string `json:"platformFamily"`
	PlatformOs     string `json:"platformOs"`
	UserAgent      string `json:"userAgent"`
}

// --- account/read ---

// AccountReadParams is the "account/read" request payload.
type AccountReadParams struct {
	RefreshToken bool `json:"refreshToken,omitempty"`
}

// Account is the discriminated account descriptor. Type is one of "apiKey",
// "chatgpt", or "amazonBedrock". Email/PlanType are populated only for chatgpt.
type Account struct {
	Type     string `json:"type"`
	Email    string `json:"email,omitempty"`
	PlanType string `json:"planType,omitempty"`
}

// AccountReadResult is the "account/read" response payload. Account is nil when
// unauthenticated; RequiresOpenaiAuth signals a login is required.
type AccountReadResult struct {
	Account            *Account `json:"account"`
	RequiresOpenaiAuth bool     `json:"requiresOpenaiAuth"`
}

// --- model/list ---

// ModelListParams is the "model/list" request payload. Cursor drives
// pagination; nil fetches the first page.
type ModelListParams struct {
	Cursor *string `json:"cursor,omitempty"`
	Cwd    *string `json:"cwd,omitempty"`
}

// ReasoningEffortOption is one supported reasoning-effort level for a model.
type ReasoningEffortOption struct {
	ReasoningEffort string `json:"reasoningEffort"`
}

// ServiceTier is one service (speed) tier for a model.
type ServiceTier struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Model is one entry in a model/list page.
type Model struct {
	Model                     string                  `json:"model"`
	DisplayName               string                  `json:"displayName"`
	Description               string                  `json:"description,omitempty"`
	InputModalities           []string                `json:"inputModalities,omitempty"`
	DefaultReasoningEffort    string                  `json:"defaultReasoningEffort"`
	SupportedReasoningEfforts []ReasoningEffortOption `json:"supportedReasoningEfforts"`
	ServiceTiers              []ServiceTier           `json:"serviceTiers,omitempty"`
	DefaultServiceTier        string                  `json:"defaultServiceTier,omitempty"`
}

// ModelListResult is the "model/list" response page. NextCursor is nil/absent
// on the last page.
type ModelListResult struct {
	Data       []Model `json:"data"`
	NextCursor *string `json:"nextCursor,omitempty"`
}

// --- thread lifecycle ---

// ThreadStartParams is the "thread/start" request payload. All fields are
// optional; codex applies its own defaults for unset values.
type ThreadStartParams struct {
	Cwd            string `json:"cwd,omitempty"`
	Model          string `json:"model,omitempty"`
	ServiceTier    string `json:"serviceTier,omitempty"`
	ApprovalPolicy string `json:"approvalPolicy,omitempty"`
	Sandbox        string `json:"sandbox,omitempty"`
}

// ThreadResumeParams is the "thread/resume" request payload.
type ThreadResumeParams struct {
	ThreadID       string `json:"threadId"`
	Cwd            string `json:"cwd,omitempty"`
	Model          string `json:"model,omitempty"`
	ServiceTier    string `json:"serviceTier,omitempty"`
	ApprovalPolicy string `json:"approvalPolicy,omitempty"`
	Sandbox        string `json:"sandbox,omitempty"`
}

// Thread is the thread descriptor returned by thread/start and thread/resume.
type Thread struct {
	ID    string `json:"id"`
	Cwd   string `json:"cwd,omitempty"`
	Model string `json:"model,omitempty"`
}

// threadResult wraps a thread in the start/resume response envelope.
type threadResult struct {
	Thread Thread `json:"thread"`
}

// --- turn lifecycle ---

// TextInput is a text user-input item for turn/start and turn/steer.
type TextInput struct {
	Type string `json:"type"` // always "text"
	Text string `json:"text"`
}

// NewTextInput builds a single-element text input slice.
func NewTextInput(text string) []any {
	return []any{TextInput{Type: "text", Text: text}}
}

// SandboxPolicy is the tagged sandbox policy for a turn. Type is one of
// "dangerFullAccess", "readOnly", "workspaceWrite", "externalSandbox".
type SandboxPolicy struct {
	Type string `json:"type"`
}

// TurnStartParams is the "turn/start" request payload.
type TurnStartParams struct {
	ThreadID       string         `json:"threadId"`
	Input          []any          `json:"input"`
	Model          string         `json:"model,omitempty"`
	Effort         string         `json:"effort,omitempty"`
	ServiceTier    string         `json:"serviceTier,omitempty"`
	ApprovalPolicy string         `json:"approvalPolicy,omitempty"`
	SandboxPolicy  *SandboxPolicy `json:"sandboxPolicy,omitempty"`
}

// turnResult wraps the turn descriptor in the turn/start response.
type turnResult struct {
	Turn struct {
		ID string `json:"id"`
	} `json:"turn"`
}

// TurnInterruptParams is the "turn/interrupt" request payload.
type TurnInterruptParams struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
}

// TurnSteerParams is the "turn/steer" request payload.
type TurnSteerParams struct {
	ThreadID       string `json:"threadId"`
	ExpectedTurnID string `json:"expectedTurnId"`
	Input          []any  `json:"input"`
}

// turnSteerResult is the "turn/steer" response payload.
type turnSteerResult struct {
	TurnID string `json:"turnId"`
}

// --- login ---

// LoginStartResult is the "account/login/start" response union. Type is one of
// "apiKey", "chatgpt", "chatgptDeviceCode", "chatgptAuthTokens". AuthURL/LoginID
// are set for "chatgpt"; UserCode/VerificationURL for "chatgptDeviceCode".
type LoginStartResult struct {
	Type            string `json:"type"`
	AuthURL         string `json:"authUrl,omitempty"`
	LoginID         string `json:"loginId,omitempty"`
	UserCode        string `json:"userCode,omitempty"`
	VerificationURL string `json:"verificationUrl,omitempty"`
}

// LoginCancelParams is the "account/login/cancel" request payload.
type LoginCancelParams struct {
	LoginID string `json:"loginId"`
}

// --- notification payloads (server → client) ---

// DeltaNotification is the shared shape of the streaming delta notifications
// (agentMessage, reasoning textDelta, commandExecution outputDelta).
type DeltaNotification struct {
	Delta    string `json:"delta"`
	ItemID   string `json:"itemId,omitempty"`
	ThreadID string `json:"threadId,omitempty"`
	TurnID   string `json:"turnId,omitempty"`
}

// ThreadStartedNotification is the "thread/started" payload.
type ThreadStartedNotification struct {
	ThreadID string `json:"threadId"`
}

// ThreadItem is a lifecycle item carried by item/started and item/completed.
// Type discriminates the union ("agentMessage", "commandExecution",
// "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "reasoning",
// ...); only the fields the engine translates are modeled.
type ThreadItem struct {
	Type             string          `json:"type"`
	ID               string          `json:"id"`
	Text             string          `json:"text,omitempty"`
	Command          string          `json:"command,omitempty"`
	Cwd              string          `json:"cwd,omitempty"`
	AggregatedOutput string          `json:"aggregatedOutput,omitempty"`
	ExitCode         *int            `json:"exitCode,omitempty"`
	Status           string          `json:"status,omitempty"`
	Name             string          `json:"name,omitempty"`
	Raw              json.RawMessage `json:"-"`
}

// ItemNotification is the payload of item/started and item/completed.
type ItemNotification struct {
	Item     ThreadItem `json:"item"`
	ThreadID string     `json:"threadId"`
	TurnID   string     `json:"turnId"`
}

// TokenUsageBreakdown is a single usage snapshot (last turn or cumulative).
type TokenUsageBreakdown struct {
	CachedInputTokens     int `json:"cachedInputTokens"`
	InputTokens           int `json:"inputTokens"`
	OutputTokens          int `json:"outputTokens"`
	ReasoningOutputTokens int `json:"reasoningOutputTokens"`
	TotalTokens           int `json:"totalTokens"`
}

// TokenUsageNotification is the "thread/tokenUsage/updated" payload.
type TokenUsageNotification struct {
	ThreadID   string `json:"threadId"`
	TurnID     string `json:"turnId"`
	TokenUsage struct {
		Last               TokenUsageBreakdown `json:"last"`
		Total              TokenUsageBreakdown `json:"total"`
		ModelContextWindow *int                `json:"modelContextWindow,omitempty"`
	} `json:"tokenUsage"`
}

// TurnCompletedNotification is the "turn/completed" payload.
type TurnCompletedNotification struct {
	ThreadID string `json:"threadId"`
	Turn     struct {
		ID string `json:"id"`
	} `json:"turn"`
}

// ErrorNotification is the "error" payload. willRetry indicates codex will
// retry the turn internally.
type ErrorNotification struct {
	ThreadID  string `json:"threadId"`
	TurnID    string `json:"turnId"`
	WillRetry bool   `json:"willRetry"`
	Error     struct {
		Message           string `json:"message"`
		AdditionalDetails string `json:"additionalDetails,omitempty"`
	} `json:"error"`
}

// LoginCompletedNotification is the "account/login/completed" payload.
type LoginCompletedNotification struct {
	Success bool   `json:"success"`
	LoginID string `json:"loginId,omitempty"`
	Error   string `json:"error,omitempty"`
}

// --- server request payloads (approvals) ---

// CommandApprovalParams is the "item/commandExecution/requestApproval" payload.
type CommandApprovalParams struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
	ItemID   string `json:"itemId"`
	Command  string `json:"command"`
	Cwd      string `json:"cwd"`
	Reason   string `json:"reason,omitempty"`
}

// FileChangeApprovalParams is the "item/fileChange/requestApproval" payload.
type FileChangeApprovalParams struct {
	ThreadID string `json:"threadId"`
	TurnID   string `json:"turnId"`
	ItemID   string `json:"itemId"`
	Reason   string `json:"reason,omitempty"`
}

// ApprovalResponse is the reply to an approval request; Decision is one of the
// Decision* constants.
type ApprovalResponse struct {
	Decision string `json:"decision"`
}
