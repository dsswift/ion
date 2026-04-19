// Package mcp implements a client for the Model Context Protocol (MCP),
// supporting both stdio (subprocess) and SSE (HTTP) transports.
package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/dsswift/ion/engine/internal/types"
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
	return conn.ListResources()
}

// ReadMcpResource reads a resource from a connected MCP server by name and URI.
func ReadMcpResource(serverName, uri string) (*McpResourceContent, error) {
	conn := getConnection(serverName)
	if conn == nil {
		return nil, fmt.Errorf("MCP server %q not connected", serverName)
	}
	return conn.ReadResource(uri)
}

// Connection is an active MCP server connection.
type Connection struct {
	name      string
	tools     []ToolDef
	transport mcpTransport
	nextID    atomic.Int64
	mu        sync.Mutex
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
	}

	// Initialize the connection.
	if err := conn.initialize(); err != nil {
		transport.Close()
		return nil, fmt.Errorf("mcp initialize %s: %w", name, err)
	}

	// Discover tools.
	tools, err := conn.listTools()
	if err != nil {
		transport.Close()
		return nil, fmt.Errorf("mcp list tools %s: %w", name, err)
	}
	conn.tools = tools

	// Register in the package-level registry.
	registerConnection(name, conn)

	return conn, nil
}

func (c *Connection) initialize() error {
	resp, err := c.call("initialize", map[string]any{
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
	notif := jsonRPCRequest{
		JSONRPC: "2.0",
		Method:  "notifications/initialized",
	}
	data, _ := json.Marshal(notif)
	return c.transport.Send(data)
}

func (c *Connection) listTools() ([]ToolDef, error) {
	resp, err := c.call("tools/list", nil)
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

func (c *Connection) call(method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

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

	// Read responses until we get one matching our ID.
	for {
		respData, err := c.transport.Receive()
		if err != nil {
			return nil, fmt.Errorf("receive: %w", err)
		}

		var resp jsonRPCResponse
		if err := json.Unmarshal(respData, &resp); err != nil {
			continue // Skip non-response messages (notifications).
		}

		if resp.ID != id {
			continue // Skip responses for other requests.
		}

		if resp.Error != nil {
			return nil, fmt.Errorf("rpc error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp.Result, nil
	}
}

// CallTool invokes a tool on the MCP server and returns the text result.
func (c *Connection) CallTool(toolName string, params map[string]interface{}) (string, error) {
	resp, err := c.call("tools/call", map[string]any{
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
		return string(resp), nil
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
func (c *Connection) ListResources() ([]McpResource, error) {
	resp, err := c.call("resources/list", nil)
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
func (c *Connection) ReadResource(uri string) (*McpResourceContent, error) {
	resp, err := c.call("resources/read", map[string]any{
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
	for k, v := range config.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
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
	t.stdin.Close()
	return t.cmd.Process.Kill()
}

// --- SSE transport ---

type sseTransport struct {
	baseURL  string
	msgCh    chan json.RawMessage
	client   *http.Client
	cancelFn func()
	done     chan struct{}
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

	return t, nil
}

func (t *sseTransport) Send(msg json.RawMessage) error {
	req, err := http.NewRequest(http.MethodPost, t.baseURL+"/message", strings.NewReader(string(msg)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := t.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("SSE send error (status %d): %s", resp.StatusCode, string(body))
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
	close(t.done)
	return nil
}
