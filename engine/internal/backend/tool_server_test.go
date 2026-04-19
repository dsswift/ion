package backend

import (
	"encoding/json"
	"net"
	"os"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestNewToolServer_CreatesWithSessionID(t *testing.T) {
	ts := NewToolServer("test-session-123")
	if ts == nil {
		t.Fatal("NewToolServer returned nil")
	}
	if !strings.Contains(ts.SocketPath(), "sock-test-session-123") {
		t.Errorf("socket path should contain session ID, got: %s", ts.SocketPath())
	}
}

func TestRegisterTool_AddsTool(t *testing.T) {
	ts := NewToolServer("reg-test")
	ts.RegisterTool("my_tool", func(input map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "ok"}, nil
	})

	ts.mu.Lock()
	_, exists := ts.tools["my_tool"]
	ts.mu.Unlock()

	if !exists {
		t.Error("RegisterTool did not add tool to map")
	}
}

func TestStartStop_Lifecycle(t *testing.T) {
	ts := NewToolServer("lifecycle-test")
	defer ts.Stop()

	if err := ts.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	// Socket file should exist while running.
	sockPath := ts.SocketPath()
	if _, err := os.Stat(sockPath); err != nil {
		t.Errorf("socket file should exist after Start, got: %v", err)
	}

	ts.Stop()

	// Socket file should be cleaned up after stop.
	if _, err := os.Stat(sockPath); !os.IsNotExist(err) {
		t.Errorf("socket file should be removed after Stop")
	}
}

func TestMcpConfigPath_ReturnsValidJSON(t *testing.T) {
	ts := NewToolServer("config-test")

	configPath, err := ts.McpConfigPath("config-test")
	if err != nil {
		t.Fatalf("McpConfigPath failed: %v", err)
	}
	defer os.Remove(configPath)

	if !strings.HasSuffix(configPath, ".json") {
		t.Errorf("config path should end with .json, got: %s", configPath)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("cannot read config file: %v", err)
	}

	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("config file is not valid JSON: %v", err)
	}

	if _, ok := parsed["mcpServers"]; !ok {
		t.Error("config should contain mcpServers key")
	}
}

func TestToolServer_JSONRPCToolsList(t *testing.T) {
	ts := NewToolServer("jsonrpc-test")
	ts.RegisterTool("echo", func(input map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "echoed"}, nil
	})
	defer ts.Stop()

	if err := ts.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	// Connect to the socket.
	conn, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("failed to connect to socket: %v", err)
	}
	defer conn.Close()

	// Send tools/list request.
	req := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      1,
		"method":  "tools/list",
	}
	encoder := json.NewEncoder(conn)
	if err := encoder.Encode(req); err != nil {
		t.Fatalf("failed to send request: %v", err)
	}

	// Read response.
	var resp map[string]interface{}
	decoder := json.NewDecoder(conn)
	if err := decoder.Decode(&resp); err != nil {
		t.Fatalf("failed to read response: %v", err)
	}

	if resp["jsonrpc"] != "2.0" {
		t.Errorf("expected jsonrpc 2.0, got: %v", resp["jsonrpc"])
	}

	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected result object, got: %v", resp["result"])
	}

	tools, ok := result["tools"].([]interface{})
	if !ok {
		t.Fatalf("expected tools array, got: %v", result["tools"])
	}

	if len(tools) != 1 {
		t.Errorf("expected 1 tool, got %d", len(tools))
	}

	tool := tools[0].(map[string]interface{})
	if tool["name"] != "echo" {
		t.Errorf("expected tool name 'echo', got: %v", tool["name"])
	}
}
