package acp

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Handlers are the ACP-specific callbacks the backend supplies.
type Handlers struct {
	// OnSessionUpdate receives every session/update notification. Called in
	// order on the read loop; must not block.
	OnSessionUpdate func(n SessionUpdateNotification)
	// OnPermission answers a session/request_permission. It may block on a user
	// decision. A nil handler cancels the request.
	OnPermission func(p RequestPermissionParams) PermissionOutcome
	// OnExtRequest handles an agent → client request whose method is not one of
	// the ACP core methods — e.g. cursor's cursor/create_plan and
	// cursor/ask_question extension methods. It returns the JSON-RPC result and
	// a handled flag; when handled is false (or the handler is nil) the client
	// replies with a method-not-found error. Like OnPermission it may block on
	// a user decision.
	OnExtRequest func(method string, params json.RawMessage) (result any, handled bool)
	// OnClosed fires when the transport ends.
	OnClosed func(err error)
}

// Client is a typed ACP endpoint.
type Client struct {
	rpc      *rpcstdio.Client
	handlers Handlers
	tag      string
}

// NewClient wraps an rpcstdio transport pair with ACP semantics. tag names the
// agent in logs (e.g. "grok", "cursor").
func NewClient(stdin ioWriteCloser, stdout ioReader, tag string, h Handlers) *Client {
	c := &Client{handlers: h, tag: tag}
	c.rpc = rpcstdio.NewClient(stdin, stdout, rpcstdio.Options{
		Tag:            "acp." + tag,
		OnNotification: c.onNotification,
		OnRequest:      c.onRequest,
		OnClosed:       h.OnClosed,
	})
	return c
}

// NewClientFromRPC attaches the ACP-typed surface to an already-constructed
// rpcstdio client (built by rpcstdio.Spawn with SpawnOptions).
func NewClientFromRPC(rpc *rpcstdio.Client, tag string, h Handlers) *Client {
	return &Client{rpc: rpc, handlers: h, tag: tag}
}

// SpawnOptions builds the rpcstdio.Options for spawning an ACP agent whose
// notifications and permission requests route to h.
func SpawnOptions(tag string, h Handlers) rpcstdio.Options {
	c := &Client{handlers: h, tag: tag}
	return rpcstdio.Options{
		Tag:            "acp." + tag,
		OnNotification: c.onNotification,
		OnRequest:      c.onRequest,
		OnClosed:       h.OnClosed,
	}
}

func (c *Client) onNotification(method string, params json.RawMessage) {
	if method != NotifSessionUpdate {
		utils.LogWithFields(utils.LevelDebug, "acp", "ignored notification", map[string]any{"tag": c.tag, "method": method})
		return
	}
	var n SessionUpdateNotification
	if err := json.Unmarshal(params, &n); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "session/update decode failed", map[string]any{"tag": c.tag, "error": err.Error()})
		return
	}
	if c.handlers.OnSessionUpdate != nil {
		c.handlers.OnSessionUpdate(n)
	}
}

func (c *Client) onRequest(method string, params json.RawMessage) (any, *rpcstdio.RPCError) {
	if method == ReqRequestPermission {
		var p RequestPermissionParams
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &rpcstdio.RPCError{Code: -32602, Message: "invalid permission params: " + err.Error()}
		}
		if c.handlers.OnPermission == nil {
			return PermissionOutcome{Outcome: OutcomeCancelled}, nil
		}
		outcome := c.handlers.OnPermission(p)
		utils.LogWithFields(utils.LevelInfo, "acp", "permission answered", map[string]any{"tag": c.tag, "tool_call": p.ToolCall.ToolCallID, "outcome": outcome.Outcome})
		return outcome, nil
	}
	// Non-core agent request (cursor/create_plan, cursor/ask_question, …).
	// Route to the extension handler; a handled=false or absent handler is a
	// method-not-found for the agent.
	if c.handlers.OnExtRequest != nil {
		if result, handled := c.handlers.OnExtRequest(method, params); handled {
			return result, nil
		}
	}
	return nil, &rpcstdio.RPCError{Code: -32601, Message: "unhandled acp request: " + method}
}

func (c *Client) call(ctx context.Context, method string, params any, out any) error {
	raw, err := c.rpc.Request(ctx, method, params)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("acp: decode %s result: %w", method, err)
	}
	return nil
}

// Initialize performs the ACP handshake and returns the agent's capabilities,
// auth methods, and any advertised model state.
func (c *Client) Initialize(ctx context.Context, info ClientInfo) (*InitializeResult, error) {
	var res InitializeResult
	err := c.call(ctx, MethodInitialize, InitializeParams{
		ProtocolVersion:    ProtocolVersion,
		ClientInfo:         info,
		ClientCapabilities: ClientCapabilities{},
	}, &res)
	if err != nil {
		return nil, err
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "initialized", map[string]any{"tag": c.tag, "load_session": res.AgentCapabilities.LoadSession, "auth_methods": len(res.AuthMethods)})
	return &res, nil
}

// Authenticate selects an auth method by id.
func (c *Client) Authenticate(ctx context.Context, methodID string) error {
	return c.call(ctx, MethodAuthenticate, AuthenticateParams{MethodID: methodID}, nil)
}

// SessionNew opens a new session and returns its id and any advertised models.
// mcpServers is sent as an empty (non-nil) slice so it serializes as the
// spec-required `[]` rather than being omitted — grok's ACP rejects a session/new
// that lacks the field. The delegated CLI loads its own MCP configuration.
func (c *Client) SessionNew(ctx context.Context, cwd string) (*SessionResult, error) {
	var res SessionResult
	if err := c.call(ctx, MethodSessionNew, SessionNewParams{Cwd: cwd, McpServers: []any{}}, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// SessionLoad reopens an existing session (requires agentCapabilities.loadSession).
// Same empty-slice contract as SessionNew for the required mcpServers field.
func (c *Client) SessionLoad(ctx context.Context, sessionID, cwd string) (*SessionResult, error) {
	var res SessionResult
	if err := c.call(ctx, MethodSessionLoad, SessionLoadParams{SessionID: sessionID, Cwd: cwd, McpServers: []any{}}, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// SessionPrompt runs a prompt to completion and returns the stop reason.
func (c *Client) SessionPrompt(ctx context.Context, sessionID string, prompt []ContentBlock) (*SessionPromptResult, error) {
	var res SessionPromptResult
	if err := c.call(ctx, MethodSessionPrompt, SessionPromptParams{SessionID: sessionID, Prompt: prompt}, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// SessionCancel fires the cancel notification for a session.
func (c *Client) SessionCancel(sessionID string) error {
	return c.rpc.Notify(MethodSessionCancel, SessionCancelParams{SessionID: sessionID})
}

// SessionSetModel switches the active model for a session.
func (c *Client) SessionSetModel(ctx context.Context, sessionID, modelID string) error {
	return c.call(ctx, MethodSessionSetModel, SessionSetModelParams{SessionID: sessionID, ModelID: modelID}, nil)
}

// SessionSetMode switches the active session mode (e.g. into a plan/architect
// mode advertised in the session's availableModes). Session modes are STICKY
// agent-side state: a mode set on a session persists across prompts until
// changed, so callers must reset it explicitly when the mode should not carry
// into the next prompt.
func (c *Client) SessionSetMode(ctx context.Context, sessionID, modeID string) error {
	return c.call(ctx, MethodSessionSetMode, SessionSetModeParams{SessionID: sessionID, ModeID: modeID}, nil)
}

// CursorListModels calls the cursor-specific model listing extension.
func (c *Client) CursorListModels(ctx context.Context) (*CursorListModelsResult, error) {
	var res CursorListModelsResult
	if err := c.call(ctx, MethodCursorListModels, struct{}{}, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// Close shuts down the transport.
func (c *Client) Close() error { return c.rpc.Close() }

type ioWriteCloser = interface {
	Write(p []byte) (int, error)
	Close() error
}
type ioReader = interface {
	Read(p []byte) (int, error)
}
