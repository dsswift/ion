package mcp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	mcpgo "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/dsswift/ion/engine/internal/utils"
)

// wsTransport adapts custom MCP-over-WebSocket servers to the official SDK's
// logical JSON-RPC transport. WebSocket is a configured compatibility transport;
// the SDK still owns MCP version negotiation on top of this connection.
type wsTransport struct {
	serverName string
	url        string
	httpClient *http.Client
	headers    http.Header
}

func newWSTransport(serverName, endpoint string, httpClient *http.Client, headers http.Header) (*wsTransport, error) {
	if endpoint == "" {
		return nil, fmt.Errorf("WebSocket transport requires URL")
	}
	return &wsTransport{serverName: serverName, url: endpoint, httpClient: httpClient, headers: headers}, nil
}

func (t *wsTransport) Connect(ctx context.Context) (mcpgo.Connection, error) {
	conn, _, err := websocket.Dial(ctx, t.url, &websocket.DialOptions{
		HTTPClient:      t.httpClient,
		HTTPHeader:      t.headers,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, fmt.Errorf("websocket dial %s: %w", t.serverName, err)
	}
	utils.LogWithFields(utils.LevelInfo, "mcp.ws", "websocket transport connected", map[string]any{"serverName": t.serverName, "url": t.url})
	return &wsConnection{serverName: t.serverName, conn: conn, done: make(chan struct{})}, nil
}

var _ mcpgo.Transport = (*wsTransport)(nil)

type wsConnection struct {
	serverName string
	conn       *websocket.Conn
	writeMu    sync.Mutex
	done       chan struct{}
	closeOnce  sync.Once
	closeErr   error
}

func (c *wsConnection) Read(ctx context.Context) (jsonrpc.Message, error) {
	_, data, err := c.conn.Read(ctx)
	if err != nil {
		if c.isClosed() || websocket.CloseStatus(err) != -1 {
			return nil, io.EOF
		}
		return nil, fmt.Errorf("websocket read %s: %w", c.serverName, err)
	}
	message, err := jsonrpc.DecodeMessage(data)
	if err != nil {
		return nil, fmt.Errorf("decode websocket JSON-RPC message from %s: %w", c.serverName, err)
	}
	return message, nil
}

func (c *wsConnection) Write(ctx context.Context, message jsonrpc.Message) error {
	encoded, err := jsonrpc.EncodeMessage(message)
	if err != nil {
		return fmt.Errorf("encode websocket JSON-RPC message for %s: %w", c.serverName, err)
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.isClosed() {
		return mcpgo.ErrConnectionClosed
	}
	if err := c.conn.Write(ctx, websocket.MessageText, encoded); err != nil {
		return fmt.Errorf("websocket write %s: %w", c.serverName, err)
	}
	return nil
}

func (c *wsConnection) Close() error {
	c.closeOnce.Do(func() {
		close(c.done)
		c.closeErr = c.conn.Close(websocket.StatusNormalClosure, "ion MCP client closing")
		if c.closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp.ws", "websocket transport close failed", map[string]any{"serverName": c.serverName, "error": c.closeErr.Error()})
			return
		}
		utils.LogWithFields(utils.LevelInfo, "mcp.ws", "websocket transport closed", map[string]any{"serverName": c.serverName})
	})
	return c.closeErr
}

func (c *wsConnection) SessionID() string { return "" }

func (c *wsConnection) isClosed() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

var _ mcpgo.Connection = (*wsConnection)(nil)
