// Package mcp implements a client for the Model Context Protocol (MCP),
// supporting both stdio (subprocess) and SSE (HTTP) transports.
package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
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

// Register (re)points the package-level registry at a connection.
//
// Connect already registers, so this exists for one specific ordering problem:
// replacing a connection means closing the old one, and Close unregisters by
// NAME — which evicts the new connection's entry, because both share the name.
// A caller that closes a superseded connection after opening its replacement
// calls this to restore the live entry. Without it, ListMcpResources and
// ReadMcpResource would report the server as not connected.
func Register(conn *Connection) {
	if conn == nil {
		return
	}
	registerConnection(conn.name, conn)
	utils.LogWithFields(utils.LevelDebug, "mcp", "connection re-registered in package registry", map[string]any{
		"serverName": conn.name,
	})
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

// mcpProtocolVersion is the MCP protocol revision this client speaks. Sent in
// the initialize handshake, and advisory on the OAuth metadata fetches in
// discovery.go (some gateways route on the header).
const mcpProtocolVersion = "2024-11-05"

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
	// Token resolution runs whether or not an explicit `oauth` block exists:
	// a server authenticated via `ion mcp login` (dynamic registration, no
	// engine.json oauth block) has its client stored, and resolveOAuthHeaders
	// finds it there. Gating this on config.OAuth != nil would make every
	// discovery-authenticated server connect unauthenticated.
	var oauthCfg *OAuthConfig
	if config.OAuth != nil {
		oauthCfg = &OAuthConfig{
			ClientID:     config.OAuth.ClientID,
			ClientSecret: config.OAuth.ClientSecret,
			AuthURL:      config.OAuth.AuthURL,
			TokenURL:     config.OAuth.TokenURL,
			Scope:        config.OAuth.Scope,
			RedirectURI:  config.OAuth.RedirectURI,
			UsePKCE:      config.OAuth.UsePKCE,
		}
	}
	// Build a per-server OAuth resolver. The http transport consults it on
	// every request so a refreshed token reaches the wire mid-session; the SSE
	// and WebSocket transports have no per-request seam here, so they still take
	// a connect-time header (see the notes at their construction below).
	oauthResolver := newTokenResolver(name, oauthCfg)
	if authHeaders := resolveOAuthHeaders(name, oauthCfg); authHeaders != nil {
		for k, v := range authHeaders {
			headers[k] = v
		}
	}

	// Operator-token forwarding (config.forwardUserToken): resolve the
	// signed-in operator's bearer token for this server's declared scope.
	// The closure defers resolution to request time so long-lived
	// connections ride the identity manager's cache + silent refresh
	// instead of pinning a connect-time token.
	var userToken func() (string, error)
	if config.ForwardUserToken {
		scope := config.UserTokenScope
		audience := config.UserTokenAudience
		userToken = func() (string, error) {
			op := auth.Operator()
			if op == nil {
				return "", fmt.Errorf("forwardUserToken configured but no operator identity is available (set auth.identityProvider in engine.json and sign in)")
			}
			return op.GetTokenWithAudience(context.Background(), scope, audience)
		}
	}

	switch config.Type {
	case "stdio", "":
		transport, err = newStdioTransport(name, config)
	case "sse":
		var sseTr *sseTransport
		sseTr, err = newSSETransport(name, config, headers, userToken)
		if sseTr != nil {
			sseTr.oauth = oauthResolver
			transport = sseTr
		}
	case "http":
		var httpTr *httpTransport
		httpTr, err = newHTTPTransport(config.URL, headers, userToken)
		if httpTr != nil {
			// Per-request OAuth resolution + the 401 retry. Without this the
			// Authorization header would stay frozen at its connect-time value
			// and every tool call after the token's expiry would 401 while the
			// stored refresh token went unused.
			httpTr.oauth = oauthResolver
			transport = httpTr
		}
	case "ws", "websocket":
		// WebSocket headers apply once at dial time, so neither an operator
		// token nor this server's OAuth token can be refreshed per request the
		// way http and sse refresh theirs. Both are resolved fresh here and ride
		// the upgrade request; renewing either requires a reconnect. Prefer the
		// http transport for any server whose credential expires -- the
		// connect-time header on a long-lived socket is exactly the staleness the
		// resolver exists to avoid.
		if oauthResolver != nil {
			if value, tokenErr := oauthResolver.Token(); tokenErr != nil {
				utils.LogWithFields(utils.LevelError, "mcp", "oauth token unavailable for websocket dial", map[string]any{
					"serverName": name, "error": tokenErr.Error(),
				})
			} else {
				headers["Authorization"] = value
			}
		}
		if userToken != nil {
			token, tokenErr := userToken()
			if tokenErr != nil {
				return nil, fmt.Errorf("mcp connect %s: %w", name, tokenErr)
			}
			headers["Authorization"] = "Bearer " + token
		}
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
			utils.LogWithFields(utils.LevelInfo, "mcp", "transport close after initialize failure", map[string]any{"tool": name, "error": closeErr.Error()})
		}
		return nil, annotateAuthFailure(name, config, fmt.Errorf("mcp initialize %s: %w", name, err))
	}

	// Discover tools.
	tools, err := conn.listTools()
	if err != nil {
		if closeErr := transport.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp", "transport close after list tools failure", map[string]any{"tool": name, "error": closeErr.Error()})
		}
		return nil, annotateAuthFailure(name, config, fmt.Errorf("mcp list tools %s: %w", name, err))
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
		"protocolVersion": mcpProtocolVersion,
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
	data, _ := json.Marshal(notif) //nolint:errcheck // marshal of a local struct
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
				// Skip non-response messages (notifications). Log at debug so a
				// server emitting only unparseable frames (which loops until
				// timeout) is diagnosable.
				utils.LogWithFields(utils.LevelDebug, "mcp", "skipping unparseable rpc frame", map[string]any{"serverName": c.name, "error": err.Error()})
				continue
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
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	reader     *bufio.Reader
	serverName string
}

func newStdioTransport(serverName string, config types.McpServerConfig) (*stdioTransport, error) {
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

	// Capture stderr so a subprocess crash reason (missing dependency, bad
	// env, panic, auth message) is observable instead of vanishing. Without
	// this, a downstream listTools failure shows only a generic error and the
	// root cause is invisible.
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start command: %w", err)
	}

	go drainStdioStderr(serverName, stderr)

	return &stdioTransport{
		cmd:        cmd,
		stdin:      stdin,
		reader:     bufio.NewReader(stdout),
		serverName: serverName,
	}, nil
}

// drainStdioStderr logs every line the MCP subprocess writes to stderr so a
// crash or auth rejection is visible in the engine log, correlated by server.
func drainStdioStderr(serverName string, stderr io.ReadCloser) {
	scanner := bufio.NewScanner(stderr)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		utils.LogWithFields(utils.LevelDebug, "mcp.stdio", "server stderr", map[string]any{"serverName": serverName, "line": line})
	}
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
			// Non-JSON stdout line (server logging to the wrong stream, or a
			// malformed frame). Skip it, but log so a server that never
			// produces a valid frame is diagnosable instead of timing out.
			utils.LogWithFields(utils.LevelDebug, "mcp.stdio", "skipping non-JSON stdout line", map[string]any{"serverName": t.serverName})
			continue
		}
		return json.RawMessage(line), nil
	}
}

func (t *stdioTransport) Close() error {
	t.stdin.Close()      //nolint:errcheck // resource close
	t.cmd.Process.Kill() //nolint:errcheck // process teardown
	// Wait reaps the child process to prevent zombies. The error from Wait is
	// always non-nil after Kill, so we ignore it.
	t.cmd.Wait() //nolint:errcheck // process teardown
	return nil
}
