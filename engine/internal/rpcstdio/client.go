// Package rpcstdio implements a symmetric JSON-RPC 2.0 client over a pair of
// stdio streams. It is the shared transport primitive for the engine's
// subprocess-delegated backends (codex app-server, ACP agents), factored out
// of the extension host's bespoke RPC loop so each backend does not
// reimplement framing, id correlation, and lifecycle.
//
// The client is symmetric: it originates requests and notifications to the
// peer, and it dispatches peer-originated notifications and requests back to
// the owner via callbacks. Peer requests (e.g. an approval prompt) are handled
// on their own goroutine so a handler that blocks waiting for a user decision
// does not stall the read loop; peer notifications (e.g. streaming deltas) are
// handled inline so their order is preserved.
package rpcstdio

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
	"sync/atomic"

	"github.com/dsswift/ion/engine/internal/utils"
)

// RPCError is a JSON-RPC 2.0 error object. It doubles as a Go error so peer
// error responses surface through the normal error path.
type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("rpc error %d: %s", e.Code, e.Message)
}

// Options configures a Client. All callbacks are optional.
type Options struct {
	// Tag names the client in log lines (e.g. "codex", "acp.grok").
	Tag string
	// OnNotification handles a peer-originated notification (a message with a
	// method but no id). Called inline on the read loop, so it must not block;
	// forward to a channel or emit and return. Nil ignores notifications.
	OnNotification func(method string, params json.RawMessage)
	// OnRequest handles a peer-originated request (a message with both a
	// method and an id). Called on its own goroutine, so it MAY block (e.g.
	// awaiting a user decision). Its return value is marshaled into the JSON-
	// RPC result; a non-nil *RPCError becomes the error response. Nil replies
	// to every peer request with a method-not-found error.
	OnRequest func(method string, params json.RawMessage) (any, *RPCError)
	// OnClosed fires exactly once when the read loop ends (peer EOF, read
	// error, or Close). The error is nil for a clean Close and non-nil for an
	// unexpected end. Nil skips the notification.
	OnClosed func(err error)
}

// response is the internal delivery envelope for a matched peer response.
type response struct {
	result json.RawMessage
	err    *RPCError
}

// Client is a symmetric JSON-RPC 2.0 endpoint over stdio streams.
type Client struct {
	tag   string
	stdin io.WriteCloser

	writeMu sync.Mutex // serializes frames onto stdin

	nextID  atomic.Int64
	pendMu  sync.Mutex
	pending map[int64]chan *response

	dead     atomic.Bool
	deadCh   chan struct{}
	deadOnce sync.Once

	onNotification func(method string, params json.RawMessage)
	onRequest      func(method string, params json.RawMessage) (any, *RPCError)
	onClosed       func(err error)
}

// NewClient wraps a stdin/stdout pair and starts the read loop. The caller
// owns the underlying process (or pipes); Close shuts down writing and unblocks
// pending calls but does not kill a process — use the Spawn helper for that.
func NewClient(stdin io.WriteCloser, stdout io.Reader, opts Options) *Client {
	c := &Client{
		tag:            opts.Tag,
		stdin:          stdin,
		pending:        make(map[int64]chan *response),
		deadCh:         make(chan struct{}),
		onNotification: opts.OnNotification,
		onRequest:      opts.OnRequest,
		onClosed:       opts.OnClosed,
	}
	go c.readLoop(stdout)
	return c
}

// wireRequest is an outgoing client→peer request.
type wireRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

// wireNotification is an outgoing client→peer notification.
type wireNotification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

// wireResponse is an outgoing response to a peer-originated request. The id is
// echoed verbatim (JSON-RPC ids may be numbers or strings).
type wireResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// incoming is a decoded inbound frame. A frame with a method is peer-
// originated (request when id is present, notification otherwise); a frame
// without a method is a response to one of our requests.
type incoming struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// Request sends a JSON-RPC request and waits for the matching response. It
// returns the raw result on success, the peer's *RPCError on an error
// response, or a transport error if the peer dies or ctx is cancelled.
func (c *Client) Request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if c.dead.Load() {
		return nil, fmt.Errorf("%s: peer is closed", c.tag)
	}
	id := c.nextID.Add(1) - 1
	ch := make(chan *response, 1)
	c.pendMu.Lock()
	c.pending[id] = ch
	c.pendMu.Unlock()

	if err := c.writeFrame(wireRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params}); err != nil {
		c.pendMu.Lock()
		delete(c.pending, id)
		c.pendMu.Unlock()
		return nil, fmt.Errorf("%s: send %s: %w", c.tag, method, err)
	}
	utils.LogWithFields(utils.LevelDebug, "rpcstdio", "request sent", map[string]any{"tag": c.tag, "method": method, "id": id})

	select {
	case resp := <-ch:
		if resp.err != nil {
			return nil, resp.err
		}
		return resp.result, nil
	case <-c.deadCh:
		c.pendMu.Lock()
		delete(c.pending, id)
		c.pendMu.Unlock()
		return nil, fmt.Errorf("%s: peer died during %s", c.tag, method)
	case <-ctx.Done():
		c.pendMu.Lock()
		delete(c.pending, id)
		c.pendMu.Unlock()
		return nil, fmt.Errorf("%s: %s cancelled: %w", c.tag, method, ctx.Err())
	}
}

// Notify sends a fire-and-forget JSON-RPC notification.
func (c *Client) Notify(method string, params any) error {
	if c.dead.Load() {
		return fmt.Errorf("%s: peer is closed", c.tag)
	}
	if err := c.writeFrame(wireNotification{JSONRPC: "2.0", Method: method, Params: params}); err != nil {
		return fmt.Errorf("%s: notify %s: %w", c.tag, method, err)
	}
	utils.LogWithFields(utils.LevelDebug, "rpcstdio", "notification sent", map[string]any{"tag": c.tag, "method": method})
	return nil
}

// Close shuts down the endpoint: it marks the peer dead, unblocks every
// pending call, and closes stdin. It is safe to call more than once.
func (c *Client) Close() error {
	c.signalDead(nil)
	return c.stdin.Close()
}

// writeFrame marshals and writes a single newline-delimited JSON frame. Writes
// are serialized so concurrent goroutines cannot interleave partial frames.
func (c *Client) writeFrame(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.stdin.Write(data)
	return err
}

// signalDead marks the peer closed, closes deadCh (once), drains pending calls,
// and invokes OnClosed (once). err records why the loop ended.
func (c *Client) signalDead(err error) {
	c.deadOnce.Do(func() {
		c.dead.Store(true)
		close(c.deadCh)
		c.pendMu.Lock()
		for id, ch := range c.pending {
			close(ch)
			delete(c.pending, id)
		}
		c.pendMu.Unlock()
		if c.onClosed != nil {
			c.onClosed(err)
		}
	})
}

// readLoop consumes newline-delimited frames until EOF or a read error. It
// uses a bufio.Reader (not Scanner) so frames are not bounded by the 64 KiB
// scanner token limit — codex model lists and tool outputs can exceed it.
func (c *Client) readLoop(stdout io.Reader) {
	reader := bufio.NewReader(stdout)
	var loopErr error
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			c.dispatch(line)
		}
		if err != nil {
			if err != io.EOF {
				loopErr = err
			}
			break
		}
	}
	c.signalDead(loopErr)
}

// dispatch routes a single inbound frame.
func (c *Client) dispatch(line []byte) {
	var msg incoming
	if err := json.Unmarshal(line, &msg); err != nil {
		utils.LogWithFields(utils.LevelWarn, "rpcstdio", "non-json frame from peer", map[string]any{"tag": c.tag, "error": err.Error()})
		return
	}
	if msg.Method != "" {
		if len(msg.ID) > 0 && string(msg.ID) != "null" {
			// Peer-originated request: handle off-loop so a blocking handler
			// (e.g. an approval awaiting a user decision) does not stall reads.
			go c.handlePeerRequest(msg.Method, msg.ID, msg.Params)
		} else if c.onNotification != nil {
			// Peer-originated notification: inline to preserve order.
			c.onNotification(msg.Method, msg.Params)
		}
		return
	}
	// Response to one of our requests.
	c.deliverResponse(msg)
}

// handlePeerRequest invokes OnRequest and writes the response back, echoing the
// request id verbatim.
func (c *Client) handlePeerRequest(method string, id json.RawMessage, params json.RawMessage) {
	utils.LogWithFields(utils.LevelDebug, "rpcstdio", "peer request received", map[string]any{"tag": c.tag, "method": method})
	if c.onRequest == nil {
		_ = c.writeFrame(wireResponse{JSONRPC: "2.0", ID: id, Error: &RPCError{Code: -32601, Message: "method not found: " + method}})
		return
	}
	result, rpcErr := c.onRequest(method, params)
	resp := wireResponse{JSONRPC: "2.0", ID: id}
	if rpcErr != nil {
		resp.Error = rpcErr
	} else {
		resp.Result = result
	}
	if err := c.writeFrame(resp); err != nil {
		utils.LogWithFields(utils.LevelWarn, "rpcstdio", "peer response write failed", map[string]any{"tag": c.tag, "method": method, "error": err.Error()})
	}
}

// deliverResponse matches a response to its pending call and delivers it.
func (c *Client) deliverResponse(msg incoming) {
	var id int64
	if err := json.Unmarshal(msg.ID, &id); err != nil {
		utils.LogWithFields(utils.LevelWarn, "rpcstdio", "response with unparseable id", map[string]any{"tag": c.tag, "id": string(msg.ID)})
		return
	}
	c.pendMu.Lock()
	ch, ok := c.pending[id]
	delete(c.pending, id)
	c.pendMu.Unlock()
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "rpcstdio", "response for unknown id (late or duplicate)", map[string]any{"tag": c.tag, "id": id})
		return
	}
	ch <- &response{result: msg.Result, err: msg.Error}
}
