// Package mcp implements a client for the Model Context Protocol (MCP),
// supporting both stdio (subprocess) and SSE (HTTP) transports.
package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ToolDef describes a tool exposed by an MCP server.
type ToolDef struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"inputSchema"`
}

// McpResource describes a resource exposed by an MCP server.
type McpResource struct {
	URI         string `json:"uri"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}

// McpResourceContent holds the content of a resource read from an MCP server.
type McpResourceContent struct {
	URI      string `json:"uri"`
	MimeType string `json:"mimeType,omitempty"`
	Text     string `json:"text,omitempty"`
	Blob     string `json:"blob,omitempty"` // base64
}

// Package-level connection registry for module-level access.
var (
	connRegistry   = make(map[string]*Connection)
	connRegistryMu sync.RWMutex
)

// registerConnection stores a connection in the package-level registry.
func registerConnection(name string, conn *Connection) {
	connRegistryMu.Lock()
	defer connRegistryMu.Unlock()
	connRegistry[name] = conn
}

// unregisterConnection removes a connection from the registry.
func unregisterConnection(name string) {
	connRegistryMu.Lock()
	defer connRegistryMu.Unlock()
	delete(connRegistry, name)
}

// getConnection retrieves a connection by server name.
func getConnection(name string) *Connection {
	connRegistryMu.RLock()
	defer connRegistryMu.RUnlock()
	return connRegistry[name]
}

// ListMcpResources lists resources from a connected MCP server by name.
func ListMcpResources(serverName string) ([]McpResource, error) {
	conn := getConnection(serverName)
	if conn == nil {
		return nil, fmt.Errorf("MCP server %q not connected", serverName)
	}
	ctx, cancel := context.WithTimeout(context.Background(), DefaultMetadataTimeout)
	defer cancel()
	return conn.ListResources(ctx)
}

// ReadMcpResource reads a resource from a connected MCP server by name and URI.
func ReadMcpResource(serverName, uri string) (*McpResourceContent, error) {
	conn := getConnection(serverName)
	if conn == nil {
		return nil, fmt.Errorf("MCP server %q not connected", serverName)
	}
	ctx, cancel := context.WithTimeout(context.Background(), DefaultMetadataTimeout)
	defer cancel()
	return conn.ReadResource(ctx, uri)
}

const mcpCallTimeoutDefault = 60 * time.Second

// DefaultCallTimeout is the fallback MCP tool call timeout when no per-server
// override is configured. Set at startup from TimeoutsConfig.McpCall().
var DefaultCallTimeout = mcpCallTimeoutDefault

// DefaultMetadataTimeout is the timeout for MCP metadata operations
// (initialize, listTools, listResources, readResource).
var DefaultMetadataTimeout = 30 * time.Second

// SetDefaultCallTimeout overrides the default MCP tool call timeout.
func SetDefaultCallTimeout(d time.Duration) { DefaultCallTimeout = d }

// SetDefaultMetadataTimeout overrides the default MCP metadata timeout.
func SetDefaultMetadataTimeout(d time.Duration) { DefaultMetadataTimeout = d }

// Connection is an active MCP server connection.
type Connection struct {
	name        string
	tools       []ToolDef
	transport   mcpTransport
	nextID      atomic.Int64
	mu          sync.Mutex
	callTimeout time.Duration
	dead        chan struct{} // closed when connection is marked dead (e.g. timeout)
	deadOnce    sync.Once
	deadErr     error // the error that caused the connection to be marked dead
}

// mcpTransport abstracts stdio vs SSE communication.
type mcpTransport interface {
	Send(msg json.RawMessage) error
	Receive() (json.RawMessage, error)
	Close() error
}

// --- JSON-RPC 2.0 types ---

type jsonRPCRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int64  `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// jsonRPCNotification is a JSON-RPC 2.0 notification (no "id" field).
// Per the spec, notifications MUST NOT include an "id" member.
type jsonRPCNotification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

// Connect establishes a connection to an MCP server.
func Connect(name string, config types.McpServerConfig) (*Connection, error) {
	var transport mcpTransport
	var err error

	// Build auth headers from config and OAuth.
	headers := make(map[string]string)
	for k, v := range config.Headers {
		headers[k] = v
	}
	if config.OAuth != nil {
		oauthCfg := &OAuthConfig{
			ClientID:     config.OAuth.ClientID,
			ClientSecret: config.OAuth.ClientSecret,
			AuthURL:      config.OAuth.AuthURL,
			TokenURL:     config.OAuth.TokenURL,
			Scope:        config.OAuth.Scope,
			RedirectURI:  config.OAuth.RedirectURI,
			UsePKCE:      config.OAuth.UsePKCE,
		}
		if authHeaders := resolveOAuthHeaders(name, oauthCfg); authHeaders != nil {
			for k, v := range authHeaders {
				headers[k] = v
			}
		}
	}

	switch config.Type {
	case "stdio", "":
		transport, err = newStdioTransport(config)
	case "sse":
		transport, err = newSSETransport(config)
	case "http":
		transport, err = newHTTPTransport(config.URL, headers)
	case "ws", "websocket":
		transport, err = newWSTransport(config.URL, headers)
	default:
		return nil, fmt.Errorf("unsupported MCP transport type: %s", config.Type)
	}
	if err != nil {
		return nil, fmt.Errorf("mcp connect %s: %w", name, err)
	}

	conn := &Connection{
		name:      name,
		transport: transport,
		dead:      make(chan struct{}),
	}
	if config.TimeoutSeconds > 0 {
		conn.callTimeout = time.Duration(config.TimeoutSeconds) * time.Second
	}

	// Initialize the connection.
	if err := conn.initialize(); err != nil {
		if closeErr := transport.Close(); closeErr != nil {
			utils.Log("mcp", fmt.Sprintf("connect %s: transport close after initialize failure: %v", name, closeErr))
		}
		return nil, fmt.Errorf("mcp initialize %s: %w", name, err)
	}

	// Discover tools.
	tools, err := conn.listTools()
	if err != nil {
		if closeErr := transport.Close(); closeErr != nil {
			utils.Log("mcp", fmt.Sprintf("connect %s: transport close after listTools failure: %v", name, closeErr))
		}
		return nil, fmt.Errorf("mcp list tools %s: %w", name, err)
	}
	conn.tools = tools

	// Register in the package-level registry.
	registerConnection(name, conn)

	return conn, nil
}

func (c *Connection) initialize() error {
	ctx, cancel := context.WithTimeout(context.Background(), DefaultMetadataTimeout)
	defer cancel()
	resp, err := c.call(ctx, "initialize", map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo": map[string]any{
			"name":    "ion-engine",
			"version": "1.0.0",
		},
	})
	if err != nil {
		return err
	}
	_ = resp

	// Send initialized notification (no response expected).
	notif := jsonRPCNotification{
		JSONRPC: "2.0",
		Method:  "notifications/initialized",
	}
	data, _ := json.Marshal(notif)
	return c.transport.Send(data)
}

func (c *Connection) listTools() ([]ToolDef, error) {
	ctx, cancel := context.WithTimeout(context.Background(), DefaultMetadataTimeout)
	defer cancel()
	resp, err := c.call(ctx, "tools/list", nil)
	if err != nil {
		return nil, err
	}

	var result struct {
		Tools []ToolDef `json:"tools"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, fmt.Errorf("parse tools: %w", err)
	}
	return result.Tools, nil
}

func (c *Connection) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	// Fast-fail if the connection was previously marked dead.
	select {
	case <-c.dead:
		return nil, fmt.Errorf("mcp connection %s is dead: %w", c.name, c.deadErr)
	default:
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	timeout := c.callTimeout
	if timeout == 0 {
		timeout = DefaultCallTimeout
	}

	id := c.nextID.Add(1)
	req := jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	}

	data, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	if err := c.transport.Send(data); err != nil {
		return nil, fmt.Errorf("send: %w", err)
	}

	// Read responses in a goroutine so we can enforce a timeout.
	type callResult struct {
		data json.RawMessage
		err  error
	}
	ch := make(chan callResult, 1)
	go func() {
		for {
			respData, err := c.transport.Receive()
			if err != nil {
				ch <- callResult{nil, fmt.Errorf("receive: %w", err)}
				return
			}

			var resp jsonRPCResponse
			if err := json.Unmarshal(respData, &resp); err != nil {
				continue // Skip non-response messages (notifications).
			}

			if resp.ID != id {
				continue // Skip responses for other requests.
			}

			if resp.Error != nil {
				ch <- callResult{nil, fmt.Errorf("rpc error %d: %s", resp.Error.Code, resp.Error.Message)}
				return
			}
			ch <- callResult{resp.Result, nil}
			return
		}
	}()

	select {
	case r := <-ch:
		return r.data, r.err
	case <-ctx.Done():
		c.markDead(fmt.Errorf("mcp call %s: %w", method, ctx.Err()))
		return nil, c.deadErr
	case <-time.After(timeout):
		c.markDead(fmt.Errorf("mcp call %s: timeout after %s", method, timeout))
		return nil, c.deadErr
	}
}

// markDead marks the connection as permanently failed. Subsequent calls will
// fast-fail. The leaked Receive goroutine will be cleaned up when Close() is
// called on the transport.
func (c *Connection) markDead(err error) {
	c.deadOnce.Do(func() {
		c.deadErr = err
		close(c.dead)
	})
}

// CallTool invokes a tool on the MCP server and returns the text result.
func (c *Connection) CallTool(ctx context.Context, toolName string, params map[string]interface{}) (string, error) {
	resp, err := c.call(ctx, "tools/call", map[string]any{
		"name":      toolName,
		"arguments": params,
	})
	if err != nil {
		return "", err
	}

	var result struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return "", fmt.Errorf("unexpected tool response format: %w (raw: %.200s)", err, resp)
	}

	if result.IsError {
		var parts []string
		for _, c := range result.Content {
			if c.Text != "" {
				parts = append(parts, c.Text)
			}
		}
		return "", fmt.Errorf("tool error: %s", strings.Join(parts, "\n"))
	}

	var parts []string
	for _, c := range result.Content {
		if c.Text != "" {
			parts = append(parts, c.Text)
		}
	}
	return strings.Join(parts, "\n"), nil
}

// Tools returns the list of tools available on this connection.
func (c *Connection) Tools() []ToolDef {
	return c.tools
}

// ListResources returns resources available on the MCP server.
func (c *Connection) ListResources(ctx context.Context) ([]McpResource, error) {
	resp, err := c.call(ctx, "resources/list", nil)
	if err != nil {
		return nil, err
	}

	var result struct {
		Resources []McpResource `json:"resources"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, fmt.Errorf("parse resources: %w", err)
	}
	return result.Resources, nil
}

// ReadResource reads a specific resource by URI from the MCP server.
func (c *Connection) ReadResource(ctx context.Context, uri string) (*McpResourceContent, error) {
	resp, err := c.call(ctx, "resources/read", map[string]any{
		"uri": uri,
	})
	if err != nil {
		return nil, err
	}

	var result struct {
		Contents []McpResourceContent `json:"contents"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return nil, fmt.Errorf("parse resource content: %w", err)
	}
	if len(result.Contents) == 0 {
		return nil, fmt.Errorf("no content returned for resource %s", uri)
	}
	return &result.Contents[0], nil
}

// Close shuts down the MCP connection and removes it from the registry.
func (c *Connection) Close() error {
	unregisterConnection(c.name)
	return c.transport.Close()
}

// Name returns the connection name.
func (c *Connection) Name() string {
	return c.name
}

// --- stdio transport ---

type stdioTransport struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	reader *bufio.Reader
}

func newStdioTransport(config types.McpServerConfig) (*stdioTransport, error) {
	if config.Command == "" {
		return nil, fmt.Errorf("stdio transport requires command")
	}

	cmd := exec.Command(config.Command, config.Args...)
	if len(config.Env) > 0 {
		cmd.Env = os.Environ()
		for k, v := range config.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start command: %w", err)
	}

	return &stdioTransport{
		cmd:    cmd,
		stdin:  stdin,
		reader: bufio.NewReader(stdout),
	}, nil
}

func (t *stdioTransport) Send(msg json.RawMessage) error {
	_, err := t.stdin.Write(append(msg, '\n'))
	return err
}

func (t *stdioTransport) Receive() (json.RawMessage, error) {
	for {
		line, err := t.reader.ReadBytes('\n')
		if err != nil {
			return nil, err
		}
		line = []byte(strings.TrimSpace(string(line)))
		if len(line) == 0 {
			continue
		}
		if !json.Valid(line) {
			continue
		}
		return json.RawMessage(line), nil
	}
}

func (t *stdioTransport) Close() error {
	_ = t.stdin.Close()
	_ = t.cmd.Process.Kill()
	// Wait reaps the child process to prevent zombies. The error from Wait is
	// always non-nil after Kill, so we ignore it.
	_ = t.cmd.Wait()
	return nil
}

// --- SSE transport ---

type sseTransport struct {
	baseURL   string
	msgCh     chan json.RawMessage
	client    *http.Client
	done      chan struct{}
	closeOnce sync.Once
	wg        sync.WaitGroup
}

func newSSETransport(config types.McpServerConfig) (*sseTransport, error) {
	if config.URL == "" {
		return nil, fmt.Errorf("SSE transport requires URL")
	}

	t := &sseTransport{
		baseURL: strings.TrimRight(config.URL, "/"),
		msgCh:   make(chan json.RawMessage, 64),
		client:  &http.Client{},
		done:    make(chan struct{}),
	}

	// Start SSE event stream reader goroutine.
	t.wg.Add(1)
	go t.readEventStream()

	return t, nil
}

// readEventStream connects to the SSE endpoint and reads events into msgCh.
func (t *sseTransport) readEventStream() {
	defer t.wg.Done()

	req, err := http.NewRequest(http.MethodGet, t.baseURL, nil)
	if err != nil {
		return
	}
	req.Header.Set("Accept", "text/event-stream")

	resp, err := t.client.Do(req)
	if err != nil {
		return
	}
	defer func() { _ = resp.Body.Close() }()

	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		select {
		case <-t.done:
			return
		default:
		}

		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		data := strings.TrimPrefix(line, "data: ")
		data = strings.TrimSpace(data)
		if len(data) == 0 || !json.Valid([]byte(data)) {
			continue
		}

		select {
		case t.msgCh <- json.RawMessage(data):
		case <-t.done:
			return
		}
	}
}

func (t *sseTransport) Send(msg json.RawMessage) error {
	select {
	case <-t.done:
		return fmt.Errorf("SSE transport closed")
	default:
	}

	req, err := http.NewRequest(http.MethodPost, t.baseURL+"/message", strings.NewReader(string(msg)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("SSE send error (status %d): %s", resp.StatusCode, string(body))
	}

	// Some MCP servers return inline JSON-RPC responses in the POST body
	// rather than via the event stream. Queue them like stream events.
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil // Send succeeded; read failure is non-fatal.
	}
	if len(body) > 0 && json.Valid(body) {
		select {
		case t.msgCh <- json.RawMessage(body):
		case <-t.done:
		}
	}

	return nil
}

func (t *sseTransport) Receive() (json.RawMessage, error) {
	msg, ok := <-t.msgCh
	if !ok {
		return nil, io.EOF
	}
	return msg, nil
}

func (t *sseTransport) Close() error {
	t.closeOnce.Do(func() {
		close(t.done)
		// Wait for the reader goroutine to exit before closing msgCh
		// to prevent send-on-closed-channel panic.
		t.wg.Wait()
		close(t.msgCh)
	})
	return nil
}
