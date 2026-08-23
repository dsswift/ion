package backend

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"

	"github.com/dsswift/ion/engine/internal/durablefile"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// McpServerName is the MCP server name used in config and --allowedTools.
// Shared between ToolServer (config generation) and ClaudeCodeBackend (allowlist).
const McpServerName = "ion-extensions"

// ToolServer exposes extension-registered tools as an MCP server
// that backend processes can connect to.
type ToolServer struct {
	mu         sync.Mutex
	listener   net.Listener
	tools      map[string]toolEntry
	sockPath   string
	key        string
	running    bool
	configPath string

	server *mcp.Server
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// toolEntry stores a tool's handler alongside its MCP metadata so
// tools/list can serve real descriptions and input schemas.
type toolEntry struct {
	handler     ToolHandler
	description string
	inputSchema map[string]interface{}
}

// ToolHandler executes a tool call and returns the result.
type ToolHandler func(input map[string]interface{}) (*types.ToolResult, error)

// socketToken derives a filesystem- and socat-safe token from a session
// key. The engine treats session keys as opaque (per the engine
// contract, cmd.Key is accepted verbatim from any harness), so a raw key
// can contain characters that are illegal or dangerous in a socket path:
// most importantly a colon, which socat parses as an address-option
// delimiter in UNIX-CONNECT:<path> -- a colon-bearing key silently kills
// every MCP/extension tool. It can also be arbitrarily long, blowing the
// platform sun_path limit. A SHA-256 hex digest is collision-resistant
// and length-bounded (fixed 64 chars, immune to sun_path overflow) where
// a raw key is neither, and character-safe ([0-9a-f] only) for both socat
// and the filesystem. So the socket and MCP-config filenames must be
// derived from this token, never from the raw key.
func socketToken(sessionID string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(sessionID)))
}

// NewToolServer creates a tool server for the given session.
func NewToolServer(sessionID string) *ToolServer {
	home, _ := os.UserHomeDir() //nolint:errcheck // empty home handled by caller
	sockDir := filepath.Join(home, ".ion", "mcp")
	os.MkdirAll(sockDir, 0o700) //nolint:errcheck // dir creation; failure surfaces on listen below

	srv := mcp.NewServer(
		&mcp.Implementation{
			Name:    McpServerName,
			Version: "1.0.0",
		},
		&mcp.ServerOptions{
			Capabilities: &mcp.ServerCapabilities{
				Tools: &mcp.ToolCapabilities{},
			},
		},
	)

	return &ToolServer{
		tools:    make(map[string]toolEntry),
		key:      sessionID,
		sockPath: filepath.Join(sockDir, fmt.Sprintf("sock-%s", socketToken(sessionID))),
		server:   srv,
	}
}

// RegisterTool adds a tool to the server with its full MCP metadata.
func (ts *ToolServer) RegisterTool(name string, handler ToolHandler, description string, inputSchema map[string]interface{}) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.tools[name] = toolEntry{
		handler:     handler,
		description: description,
		inputSchema: inputSchema,
	}

	schema := inputSchema
	if schema == nil {
		schema = map[string]interface{}{"type": "object"}
	}
	// The SDK validates schemas at registration. Extension tool declarations may
	// omit type even though their runtime inputs are objects, so normalize every
	// schema into a concrete object before handing it to the server.
	kind, isString := schema["type"].(string)
	if !isString || kind != "object" {
		copySchema := make(map[string]interface{}, len(schema)+1)
		for key, value := range schema {
			copySchema[key] = value
		}
		copySchema["type"] = "object"
		schema = copySchema
	}
	desc := description
	if desc == "" {
		desc = "Extension tool: " + name
	}

	wrappedHandler := func(h ToolHandler) mcp.ToolHandler {
		return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var args map[string]interface{}
			if req.Params != nil && len(req.Params.Arguments) > 0 {
				if err := json.Unmarshal(req.Params.Arguments, &args); err != nil {
					utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "tools/call args decode failed", map[string]any{"name": name, "error": err.Error()})
					return nil, fmt.Errorf("invalid arguments: %w", err)
				}
			}
			if args == nil {
				args = make(map[string]interface{})
			}

			utils.LogWithFields(utils.LevelDebug, "backend.tool_server", "tools/call: invoking", map[string]any{"name": name})
			result, err := h(args)
			if err != nil {
				utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "tool error", map[string]any{
					"name":  name,
					"error": utils.ErrStr(err),
				})
				return &mcp.CallToolResult{
					Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
					IsError: true,
				}, nil
			}

			utils.LogWithFields(utils.LevelDebug, "backend.tool_server", "tool completed", map[string]any{
				"name":     name,
				"is_error": result.IsError,
			})
			return &mcp.CallToolResult{
				Content: []mcp.Content{&mcp.TextContent{Text: result.Content}},
				IsError: result.IsError,
			}, nil
		}
	}(handler)

	ts.server.AddTool(&mcp.Tool{
		Name:        name,
		Description: desc,
		InputSchema: schema,
	}, wrappedHandler)

	utils.LogWithFields(utils.LevelDebug, "backend.tool_server", "registered tool ( chars, )", map[string]any{
		"name":   name,
		"desc":   len(description),
		"schema": inputSchema != nil,
	})
}

// Start begins listening for MCP tool call requests.
func (ts *ToolServer) Start() error {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	os.Remove(ts.sockPath) //nolint:errcheck // stale socket cleanup; absent is fine

	listener, err := net.Listen("unix", ts.sockPath)
	if err != nil {
		return fmt.Errorf("tool server listen failed: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	ts.listener = listener
	ts.cancel = cancel
	ts.running = true

	ts.wg.Add(1)
	go func() {
		defer ts.wg.Done()
		ts.acceptLoop(ctx)
	}()
	utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "started for at", map[string]any{
		"key":       ts.key,
		"sock_path": ts.sockPath,
	})
	return nil
}

// Stop shuts down the tool server and cleans up the socket and config files.
func (ts *ToolServer) Stop() {
	ts.mu.Lock()
	if ts.cancel != nil {
		ts.cancel()
	}
	ts.running = false
	if ts.listener != nil {
		ts.listener.Close() //nolint:errcheck // listener teardown
	}
	configPath := ts.configPath
	ts.configPath = ""
	ts.mu.Unlock()

	ts.wg.Wait()
	os.Remove(ts.sockPath) //nolint:errcheck // stale socket cleanup; absent is fine
	if configPath != "" {
		os.Remove(configPath) //nolint:errcheck // stale config cleanup; absent is fine
	}
}

// SocketPath returns the path to the Unix socket.
func (ts *ToolServer) SocketPath() string {
	return ts.sockPath
}

// HasTool reports whether a tool of the given name is registered. Exposed for
// tests that assert which tools a delegated-CLI child's tool server carries.
func (ts *ToolServer) HasTool(name string) bool {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	_, ok := ts.tools[name]
	return ok
}

// McpConfigPath writes MCP config JSON for the Claude CLI --mcp-config flag.
func (ts *ToolServer) McpConfigPath(sessionID string) (string, error) {
	home, _ := os.UserHomeDir() //nolint:errcheck // empty home handled by caller
	configDir := filepath.Join(home, ".ion", "mcp")

	config := map[string]interface{}{
		"mcpServers": map[string]interface{}{
			McpServerName: map[string]interface{}{
				"type":    "stdio",
				"command": "socat",
				"args": []string{
					fmt.Sprintf("UNIX-CONNECT:%s", ts.sockPath),
					"STDIO",
				},
			},
		},
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return "", err
	}

	configPath := filepath.Join(configDir, fmt.Sprintf("config-%s.json", socketToken(sessionID)))
	if err := durablefile.Write(configPath, data, 0o600); err != nil {
		return "", err
	}
	ts.mu.Lock()
	ts.configPath = configPath
	ts.mu.Unlock()
	return configPath, nil
}

// McpServerSpec returns the tool server as a single structured MCP-server
// entry, for delegated CLIs that take per-session MCP servers as inline params
// rather than a config-file path. The ACP backends (grok, cursor) pass this on
// `session/new`. The shape is the ACP stdio `McpServer` variant -- the grok
// agent's serde requires `env` to be present (an empty array is accepted), so
// it is always included. Same socat->Unix-socket bridge as McpConfigPath.
func (ts *ToolServer) McpServerSpec() map[string]interface{} {
	return map[string]interface{}{
		"name":    McpServerName,
		"command": "socat",
		"args": []string{
			fmt.Sprintf("UNIX-CONNECT:%s", ts.sockPath),
			"STDIO",
		},
		"env": []interface{}{},
	}
}

func (ts *ToolServer) acceptLoop(ctx context.Context) {
	for {
		conn, err := ts.listener.Accept()
		if err != nil {
			ts.mu.Lock()
			running := ts.running
			ts.mu.Unlock()
			if !running {
				return
			}
			continue
		}
		ts.wg.Add(1)
		go func() {
			defer ts.wg.Done()
			ts.handleConnection(ctx, conn)
		}()
	}
}

func (ts *ToolServer) handleConnection(ctx context.Context, conn net.Conn) {
	defer conn.Close() //nolint:errcheck // connection close

	transport := &mcp.IOTransport{
		Reader: io.NopCloser(conn),
		Writer: &nopWriteCloser{conn},
	}

	connCtx, connCancel := context.WithCancel(ctx)
	defer connCancel()

	ss, err := ts.server.Connect(connCtx, transport, nil)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "MCP session connect failed", map[string]any{"error": err.Error()})
		return
	}

	if waitErr := ss.Wait(); waitErr != nil {
		utils.LogWithFields(utils.LevelDebug, "backend.tool_server", "MCP session ended", map[string]any{"error": waitErr.Error()})
	}
}

type nopWriteCloser struct {
	io.Writer
}

func (nopWriteCloser) Close() error { return nil }
