package codexrpc

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Handlers are the codex-specific callbacks the backend supplies. Notifications
// arrive in order on the read loop; approvals arrive on their own goroutine and
// may block.
type Handlers struct {
	// OnNotification receives every server notification (method + raw params).
	// The backend switches on method and translates to NormalizedEvents.
	OnNotification func(method string, params json.RawMessage)
	// OnCommandApproval answers an item/commandExecution/requestApproval. It
	// may block on a user decision. A nil handler auto-declines.
	OnCommandApproval func(p CommandApprovalParams) string
	// OnFileChangeApproval answers an item/fileChange/requestApproval.
	OnFileChangeApproval func(p FileChangeApprovalParams) string
	// OnClosed fires when the underlying transport ends.
	OnClosed func(err error)
}

// Client is a typed codex app-server endpoint.
type Client struct {
	rpc      *rpcstdio.Client
	handlers Handlers
}

// NewClient wraps an rpcstdio transport pair with codex semantics. It routes
// peer requests (approvals) to the supplied handlers and forwards notifications
// verbatim.
func NewClient(stdin ioWriteCloser, stdout ioReader, h Handlers) *Client {
	c := &Client{handlers: h}
	c.rpc = rpcstdio.NewClient(stdin, stdout, rpcstdio.Options{
		Tag:            "codex",
		OnNotification: h.OnNotification,
		OnRequest:      c.onRequest,
		OnClosed:       h.OnClosed,
	})
	return c
}

// NewClientFromRPC wraps an already-constructed rpcstdio.Client. Used when the
// caller spawns the process via rpcstdio.Spawn (which builds the rpcstdio
// client itself) and needs the codex-typed layer on top.
//
// Because Spawn constructs the rpcstdio client with its own Options, the codex
// request routing is installed via those Options at spawn time (see
// SpawnHandlers); this constructor only attaches the typed method surface.
func NewClientFromRPC(rpc *rpcstdio.Client, h Handlers) *Client {
	return &Client{rpc: rpc, handlers: h}
}

// SpawnHandlers builds the rpcstdio.Options for spawning a codex process whose
// peer requests route to h. Pair with rpcstdio.Spawn, then wrap the resulting
// Process.Client with NewClientFromRPC(proc.Client, h).
func SpawnHandlers(h Handlers) rpcstdio.Options {
	c := &Client{handlers: h}
	return rpcstdio.Options{
		Tag:            "codex",
		OnNotification: h.OnNotification,
		OnRequest:      c.onRequest,
		OnClosed:       h.OnClosed,
	}
}

// onRequest dispatches codex approval server-requests to the handlers.
func (c *Client) onRequest(method string, params json.RawMessage) (any, *rpcstdio.RPCError) {
	switch method {
	case ReqCommandApproval:
		var p CommandApprovalParams
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &rpcstdio.RPCError{Code: -32602, Message: "invalid command approval params: " + err.Error()}
		}
		decision := DecisionDecline
		if c.handlers.OnCommandApproval != nil {
			decision = c.handlers.OnCommandApproval(p)
		}
		utils.LogWithFields(utils.LevelInfo, "codex", "command approval answered", map[string]any{"item_id": p.ItemID, "decision": decision})
		return ApprovalResponse{Decision: decision}, nil
	case ReqFileChangeApproval:
		var p FileChangeApprovalParams
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &rpcstdio.RPCError{Code: -32602, Message: "invalid file change approval params: " + err.Error()}
		}
		decision := DecisionDecline
		if c.handlers.OnFileChangeApproval != nil {
			decision = c.handlers.OnFileChangeApproval(p)
		}
		utils.LogWithFields(utils.LevelInfo, "codex", "file change approval answered", map[string]any{"item_id": p.ItemID, "decision": decision})
		return ApprovalResponse{Decision: decision}, nil
	default:
		utils.LogWithFields(utils.LevelWarn, "codex", "unhandled server request", map[string]any{"method": method})
		return nil, &rpcstdio.RPCError{Code: -32601, Message: "unhandled codex server request: " + method}
	}
}

// call is a small helper that issues a request and unmarshals the result.
func (c *Client) call(ctx context.Context, method string, params any, out any) error {
	raw, err := c.rpc.Request(ctx, method, params)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("codex: decode %s result: %w", method, err)
	}
	return nil
}

// Initialize performs the handshake and sends the initialized notification.
func (c *Client) Initialize(ctx context.Context, info ClientInfo) (*InitializeResult, error) {
	var res InitializeResult
	if err := c.call(ctx, MethodInitialize, InitializeParams{ClientInfo: info}, &res); err != nil {
		return nil, err
	}
	if err := c.rpc.Notify(MethodInitialized, nil); err != nil {
		return nil, fmt.Errorf("codex: initialized notify: %w", err)
	}
	utils.LogWithFields(utils.LevelInfo, "codex", "initialized", map[string]any{"codex_home": res.CodexHome, "platform": res.PlatformOs})
	return &res, nil
}

// AccountRead returns the current account and auth requirement.
func (c *Client) AccountRead(ctx context.Context, refresh bool) (*AccountReadResult, error) {
	var res AccountReadResult
	if err := c.call(ctx, MethodAccountRead, AccountReadParams{RefreshToken: refresh}, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// ModelListAll pages through model/list and returns every model. It follows
// nextCursor until exhausted.
func (c *Client) ModelListAll(ctx context.Context, cwd string) ([]Model, error) {
	var all []Model
	var cursor *string
	var cwdPtr *string
	if cwd != "" {
		cwdPtr = &cwd
	}
	for {
		var page ModelListResult
		if err := c.call(ctx, MethodModelList, ModelListParams{Cursor: cursor, Cwd: cwdPtr}, &page); err != nil {
			return nil, err
		}
		all = append(all, page.Data...)
		if page.NextCursor == nil || *page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	utils.LogWithFields(utils.LevelInfo, "codex", "model list fetched", map[string]any{"count": len(all)})
	return all, nil
}

// ThreadStart opens a new thread and returns its id.
func (c *Client) ThreadStart(ctx context.Context, p ThreadStartParams) (string, error) {
	var res threadResult
	if err := c.call(ctx, MethodThreadStart, p, &res); err != nil {
		return "", err
	}
	return res.Thread.ID, nil
}

// ThreadResume reopens an existing thread and returns its id.
func (c *Client) ThreadResume(ctx context.Context, p ThreadResumeParams) (string, error) {
	var res threadResult
	if err := c.call(ctx, MethodThreadResume, p, &res); err != nil {
		return "", err
	}
	return res.Thread.ID, nil
}

// TurnStart begins a turn and returns its id.
func (c *Client) TurnStart(ctx context.Context, p TurnStartParams) (string, error) {
	var res turnResult
	if err := c.call(ctx, MethodTurnStart, p, &res); err != nil {
		return "", err
	}
	return res.Turn.ID, nil
}

// TurnInterrupt cancels the active turn.
func (c *Client) TurnInterrupt(ctx context.Context, threadID, turnID string) error {
	return c.call(ctx, MethodTurnInterrupt, TurnInterruptParams{ThreadID: threadID, TurnID: turnID}, nil)
}

// TurnSteer injects additional input into the active turn and returns the
// (possibly new) turn id.
func (c *Client) TurnSteer(ctx context.Context, threadID, expectedTurnID string, input []any) (string, error) {
	var res turnSteerResult
	if err := c.call(ctx, MethodTurnSteer, TurnSteerParams{ThreadID: threadID, ExpectedTurnID: expectedTurnID, Input: input}, &res); err != nil {
		return "", err
	}
	return res.TurnID, nil
}

// LoginStart begins an authentication flow.
func (c *Client) LoginStart(ctx context.Context) (*LoginStartResult, error) {
	var res LoginStartResult
	if err := c.call(ctx, MethodLoginStart, struct{}{}, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// LoginCancel aborts an in-flight login.
func (c *Client) LoginCancel(ctx context.Context, loginID string) error {
	return c.call(ctx, MethodLoginCancel, LoginCancelParams{LoginID: loginID}, nil)
}

// Logout clears the stored credential.
func (c *Client) Logout(ctx context.Context) error {
	return c.call(ctx, MethodLogout, nil, nil)
}

// Close shuts down the transport.
func (c *Client) Close() error { return c.rpc.Close() }

// ioWriteCloser and ioReader alias the io interfaces so callers do not need to
// import io just to satisfy NewClient in tests.
type ioWriteCloser = interface {
	Write(p []byte) (int, error)
	Close() error
}
type ioReader = interface {
	Read(p []byte) (int, error)
}
