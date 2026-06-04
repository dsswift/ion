package backend

import (
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
// Shared between ToolServer (config generation) and CliBackend (allowlist).
const McpServerName = "ion-extensions"

// ToolServer exposes extension-registered tools as an MCP server
// that backend processes can connect to.
type ToolServer struct {
	mu       sync.Mutex
	listener net.Listener
	tools    map[string]toolEntry
	sockPath string
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

// NewToolServer creates a tool server for the given session.
func NewToolServer(sessionID string) *ToolServer {
	home, _ := os.UserHomeDir()
	sockDir := filepath.Join(home, ".ion", "mcp")
	_ = os.MkdirAll(sockDir, 0o700)

	return &ToolServer{
		tools:    make(map[string]toolEntry),
		sockPath: filepath.Join(sockDir, fmt.Sprintf("sock-%s", sessionID)),
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
	utils.Debug("ToolServer", fmt.Sprintf("registered tool %q (desc=%d chars, schema=%v)", name, len(description), inputSchema != nil))
}

// Start begins listening for MCP tool call requests.
func (ts *ToolServer) Start() error {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	// Clean up stale socket
	_ = os.Remove(ts.sockPath)

	listener, err := net.Listen("unix", ts.sockPath)
	if err != nil {
		return fmt.Errorf("tool server listen failed: %w", err)
	}

	ts.listener = listener
	ts.running = true

	go ts.acceptLoop()
	utils.Log("ToolServer", "started at "+ts.sockPath)
	return nil
}

// Stop shuts down the tool server and cleans up.
func (ts *ToolServer) Stop() {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	ts.running = false
	if ts.listener != nil {
		_ = ts.listener.Close()
	}
	_ = os.Remove(ts.sockPath)
}

// SocketPath returns the path to the Unix socket.
func (ts *ToolServer) SocketPath() string {
	return ts.sockPath
}

// McpConfigPath writes MCP config JSON for the Claude CLI --mcp-config flag.
func (ts *ToolServer) McpConfigPath(sessionID string) (string, error) {
	home, _ := os.UserHomeDir()
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

	configPath := filepath.Join(configDir, fmt.Sprintf("config-%s.json", sessionID))
	if err := os.WriteFile(configPath, data, 0o600); err != nil {
		return "", err
	}
	return configPath, nil
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
	defer func() { _ = conn.Close() }()

	decoder := json.NewDecoder(conn)
	encoder := json.NewEncoder(conn)

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

		utils.Debug("ToolServer", fmt.Sprintf("received method=%s id=%v", req.Method, req.ID))

		switch req.Method {
		case "initialize":
			// MCP handshake: echo protocol version, declare tools capability.
			var params struct {
				ProtocolVersion string `json:"protocolVersion"`
			}
			_ = json.Unmarshal(req.Params, &params)
			utils.Log("ToolServer", fmt.Sprintf("MCP initialize: protocolVersion=%s", params.ProtocolVersion))
			_ = encoder.Encode(map[string]interface{}{
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
				utils.Log("ToolServer", fmt.Sprintf(
					"protocol violation: notifications/initialized carried id=%v (JSON-RPC notifications must omit id). Ignoring id; no response sent.",
					req.ID))
			} else {
				utils.Debug("ToolServer", "received notifications/initialized (no-op)")
			}
			continue

		case "ping":
			_ = encoder.Encode(map[string]interface{}{
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

			utils.Debug("ToolServer", fmt.Sprintf("tools/list: returning %d tools", len(toolList)))
			_ = encoder.Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  map[string]interface{}{"tools": toolList},
			})

		case "tools/call":
			var params struct {
				Name      string                 `json:"name"`
				Arguments map[string]interface{} `json:"arguments"`
			}
			_ = json.Unmarshal(req.Params, &params)

			ts.mu.Lock()
			entry, exists := ts.tools[params.Name]
			ts.mu.Unlock()

			if !exists {
				utils.Log("ToolServer", fmt.Sprintf("tool not found: %s", params.Name))
				_ = encoder.Encode(map[string]interface{}{
					"jsonrpc": "2.0",
					"id":      req.ID,
					"error":   map[string]interface{}{"code": -32601, "message": "tool not found: " + params.Name},
				})
				continue
			}

			utils.Debug("ToolServer", fmt.Sprintf("tools/call: invoking %s", params.Name))
			result, err := entry.handler(params.Arguments)
			if err != nil {
				utils.Log("ToolServer", fmt.Sprintf("tool %s error: %v", params.Name, err))
				_ = encoder.Encode(map[string]interface{}{
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
				utils.Debug("ToolServer", fmt.Sprintf("tool %s completed (isError=%v)", params.Name, result.IsError))
				_ = encoder.Encode(map[string]interface{}{
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
			utils.Log("ToolServer", fmt.Sprintf("unknown method: %s", req.Method))
			_ = encoder.Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"error":   map[string]interface{}{"code": -32601, "message": "method not found"},
			})
		}
	}
}
