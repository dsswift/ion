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

// ToolServer exposes extension-registered tools as an MCP server
// that the Claude CLI can connect to.
type ToolServer struct {
	mu       sync.Mutex
	listener net.Listener
	tools    map[string]ToolHandler
	sockPath string
	running  bool
}

// ToolHandler executes a tool call and returns the result.
type ToolHandler func(input map[string]interface{}) (*types.ToolResult, error)

// NewToolServer creates a tool server for the given session.
func NewToolServer(sessionID string) *ToolServer {
	home, _ := os.UserHomeDir()
	sockDir := filepath.Join(home, ".ion", "mcp")
	os.MkdirAll(sockDir, 0o700)

	return &ToolServer{
		tools:    make(map[string]ToolHandler),
		sockPath: filepath.Join(sockDir, fmt.Sprintf("sock-%s", sessionID)),
	}
}

// RegisterTool adds a tool to the server.
func (ts *ToolServer) RegisterTool(name string, handler ToolHandler) {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	ts.tools[name] = handler
}

// Start begins listening for MCP tool call requests.
func (ts *ToolServer) Start() error {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	// Clean up stale socket
	os.Remove(ts.sockPath)

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
		ts.listener.Close()
	}
	os.Remove(ts.sockPath)
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
			"ion-extensions": map[string]interface{}{
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
	defer conn.Close()

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

		switch req.Method {
		case "tools/list":
			ts.mu.Lock()
			var toolList []map[string]interface{}
			for name := range ts.tools {
				toolList = append(toolList, map[string]interface{}{
					"name":        name,
					"description": "Extension tool: " + name,
					"inputSchema": map[string]interface{}{
						"type": "object",
					},
				})
			}
			ts.mu.Unlock()

			encoder.Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result":  map[string]interface{}{"tools": toolList},
			})

		case "tools/call":
			var params struct {
				Name      string                 `json:"name"`
				Arguments map[string]interface{} `json:"arguments"`
			}
			json.Unmarshal(req.Params, &params)

			ts.mu.Lock()
			handler, exists := ts.tools[params.Name]
			ts.mu.Unlock()

			if !exists {
				encoder.Encode(map[string]interface{}{
					"jsonrpc": "2.0",
					"id":      req.ID,
					"error":   map[string]interface{}{"code": -32601, "message": "tool not found: " + params.Name},
				})
				continue
			}

			result, err := handler(params.Arguments)
			if err != nil {
				encoder.Encode(map[string]interface{}{
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
				encoder.Encode(map[string]interface{}{
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
			encoder.Encode(map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"error":   map[string]interface{}{"code": -32601, "message": "method not found"},
			})
		}
	}
}
