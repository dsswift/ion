package backend

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// McpServerName is the MCP server name used in config and --allowedTools.
// Shared between ToolServer (config generation) and ClaudeCodeBackend (allowlist).
const McpServerName = "ion-extensions"

// ToolServer exposes extension-registered tools as an MCP server
// that backend processes can connect to.
type ToolServer struct {
	mu       sync.Mutex
	listener net.Listener
	tools    map[string]toolEntry
	sockPath string
	key      string
	running  bool
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
// delimiter in UNIX-CONNECT:<path> — a colon-bearing key silently kills
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

	return &ToolServer{
		tools:    make(map[string]toolEntry),
		key:      sessionID,
		sockPath: filepath.Join(sockDir, fmt.Sprintf("sock-%s", socketToken(sessionID))),
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

	// Clean up stale socket
	os.Remove(ts.sockPath) //nolint:errcheck // stale socket cleanup; absent is fine

	listener, err := net.Listen("unix", ts.sockPath)
	if err != nil {
		return fmt.Errorf("tool server listen failed: %w", err)
	}

	ts.listener = listener
	ts.running = true

	go ts.acceptLoop()
	utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "started for at", map[string]any{
		"key":       ts.key,
		"sock_path": ts.sockPath,
	})
	return nil
}

// Stop shuts down the tool server and cleans up.
func (ts *ToolServer) Stop() {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	ts.running = false
	if ts.listener != nil {
		ts.listener.Close() //nolint:errcheck // listener teardown
	}
	os.Remove(ts.sockPath) //nolint:errcheck // stale socket cleanup; absent is fine
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
	if err := os.WriteFile(configPath, data, 0o600); err != nil {
		return "", err
	}
	return configPath, nil
}

// McpServerSpec returns the tool server as a single structured MCP-server
// entry, for delegated CLIs that take per-session MCP servers as inline params
// rather than a config-file path. The ACP backends (grok, cursor) pass this on
// `session/new`. The shape is the ACP stdio `McpServer` variant — the grok
// agent's serde requires `env` to be present (an empty array is accepted), so
// it is always included. Same socat→Unix-socket bridge as McpConfigPath.
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

func (ts *ToolServer) acceptLoop() {
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
		go ts.handleConnection(conn)
	}
}

func (ts *ToolServer) handleConnection(conn net.Conn) {
	defer func() { conn.Close() }() //nolint:errcheck // connection close

	decoder := json.NewDecoder(conn)
	encoder := json.NewEncoder(conn)

	// send wraps encoder.Encode so a failed write to the CLI (broken pipe,
	// closed connection) is logged instead of silently dropping the reply,
	// which would leave the CLI hanging on a tool call with no explanation.
	send := func(method string, id interface{}, payload map[string]interface{}) {
		if err := encoder.Encode(payload); err != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "reply encode failed", map[string]any{"method": method, "id": id, "error": err.Error()})
		}
	}

	for {
		var req struct {
			JSONRPC string          `json:"jsonrpc"`
			ID      interface{}     `json:"id"`
			Method  string          `json:"method"`
			Params  json.RawMessage `json:"params"`
		}

		if err := decoder.Decode(&req); err != nil {
			return
		}

		utils.LogWithFields(utils.LevelDebug, "backend.tool_server", "received", map[string]any{
			"method": req.Method,
			"id":     req.ID,
		})

		switch req.Method {
		case "initialize":
			// MCP handshake: echo protocol version, declare tools capability.
			var params struct {
				ProtocolVersion string `json:"protocolVersion"`
			}
			if err := json.Unmarshal(req.Params, &params); err != nil {
				utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "initialize params decode failed", map[string]any{"id": req.ID, "error": err.Error()})
			}
			utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "MCP initialize", map[string]any{
				"protocol_version": params.ProtocolVersion,
			})
			send(req.Method, req.ID, map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]interface{}{
					"protocolVersion": params.ProtocolVersion,
					"capabilities": map[string]interface{}{
						"tools": map[string]interface{}{},
					},
					"serverInfo": map[string]interface{}{
						"name":    McpServerName,
						"version": "1.0.0",
					},
				},
			})

		case "notifications/initialized":
			// MCP notification: per JSON-RPC 2.0 §4.1 and the MCP spec,
			// notifications MUST NOT carry an `id` field. A well-
			// behaved client never sends one; if a client mistakenly
			// does, log the protocol violation but still treat the
			// message as a notification (no response). Returning an
			// error response to a notification would itself be a
			// protocol violation (responses go to requests, not
			// notifications), so we cannot tell the bad client.
			//
			// req.ID is `interface{}`; JSON-decoded null and absent
			// fields both leave it nil. A non-nil ID means the JSON
			// payload carried a concrete value (number/string), which
			// signals the violation.
			if req.ID != nil {
				utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "protocol violation: notifications/initialized carried (JSON-RPC notifications must omit id). Ignoring id; no response sent.", map[string]any{
					"id": req.ID,
				})
			} else {
				utils.Debug("ToolServer", "received notifications/initialized (no-op)")
			}
			continue

		case "ping":
			send(req.Method, req.ID, map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  map[string]interface{}{},
			})

		case "tools/list":
			ts.mu.Lock()
			var toolList []map[string]interface{}
			for name, entry := range ts.tools {
				schema := entry.inputSchema
				if schema == nil {
					schema = map[string]interface{}{"type": "object"}
				}
				desc := entry.description
				if desc == "" {
					desc = "Extension tool: " + name
				}
				toolList = append(toolList, map[string]interface{}{
					"name":        name,
					"description": desc,
					"inputSchema": schema,
				})
			}
			ts.mu.Unlock()

			utils.LogWithFields(utils.LevelDebug, "backend.tool_server", "tools/list: returning tools", map[string]any{
				"count": len(toolList),
			})
			send(req.Method, req.ID, map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  map[string]interface{}{"tools": toolList},
			})

		case "tools/call":
			var params struct {
				Name      string                 `json:"name"`
				Arguments map[string]interface{} `json:"arguments"`
			}
			if err := json.Unmarshal(req.Params, &params); err != nil {
				// A decode failure yields an empty name, producing a misleading
				// "tool not found" with no cause. Log the real reason.
				utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "tools/call params decode failed", map[string]any{"id": req.ID, "error": err.Error()})
			}

			ts.mu.Lock()
			entry, exists := ts.tools[params.Name]
			ts.mu.Unlock()

			if !exists {
				utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "tool not found", map[string]any{
					"name": params.Name,
				})
				send(req.Method, req.ID, map[string]interface{}{
					"jsonrpc": "2.0",
					"id":      req.ID,
					"error":   map[string]interface{}{"code": -32601, "message": "tool not found: " + params.Name},
				})
				continue
			}

			utils.LogWithFields(utils.LevelDebug, "backend.tool_server", "tools/call: invoking", map[string]any{
				"name": params.Name,
			})
			result, err := entry.handler(params.Arguments)
			if err != nil {
				utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "tool error", map[string]any{
					"name":  params.Name,
					"error": utils.ErrStr(err),
				})
				send(req.Method, req.ID, map[string]interface{}{
					"jsonrpc": "2.0",
					"id":      req.ID,
					"result": map[string]interface{}{
						"content": []map[string]interface{}{
							{"type": "text", "text": "Error: " + err.Error()},
						},
						"isError": true,
					},
				})
			} else {
				utils.LogWithFields(utils.LevelDebug, "backend.tool_server", "tool completed", map[string]any{
					"name":     params.Name,
					"is_error": result.IsError,
				})
				send(req.Method, req.ID, map[string]interface{}{
					"jsonrpc": "2.0",
					"id":      req.ID,
					"result": map[string]interface{}{
						"content": []map[string]interface{}{
							{"type": "text", "text": result.Content},
						},
						"isError": result.IsError,
					},
				})
			}

		default:
			utils.LogWithFields(utils.LevelInfo, "backend.tool_server", "unknown method", map[string]any{
				"method": req.Method,
			})
			send(req.Method, req.ID, map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"error":   map[string]interface{}{"code": -32601, "message": "method not found"},
			})
		}
	}
}
