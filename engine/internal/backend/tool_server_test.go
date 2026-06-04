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
	}, "My test tool", nil)

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

	servers, ok := parsed["mcpServers"].(map[string]interface{})
	if !ok {
		t.Fatal("config should contain mcpServers key")
	}
	if _, ok := servers[McpServerName]; !ok {
		t.Errorf("config should contain server %q, got keys: %v", McpServerName, servers)
	}
}

func TestMcpServerName_Constant(t *testing.T) {
	if McpServerName != "ion-extensions" {
		t.Errorf("McpServerName should be 'ion-extensions', got: %s", McpServerName)
	}
}

// sendJSONRPC sends a request and reads the response over a connection.
func sendJSONRPC(t *testing.T, conn net.Conn, method string, id interface{}, params interface{}) map[string]interface{} {
	t.Helper()
	req := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  method,
	}
	if params != nil {
		data, _ := json.Marshal(params)
		req["params"] = json.RawMessage(data)
	}
	encoder := json.NewEncoder(conn)
	if err := encoder.Encode(req); err != nil {
		t.Fatalf("failed to send %s request: %v", method, err)
	}
	var resp map[string]interface{}
	decoder := json.NewDecoder(conn)
	if err := decoder.Decode(&resp); err != nil {
		t.Fatalf("failed to read %s response: %v", method, err)
	}
	return resp
}

func TestToolServer_MCPInitializeHandshake(t *testing.T) {
	ts := NewToolServer("init-test")
	ts.RegisterTool("echo", func(input map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "echoed"}, nil
	}, "Echo tool", nil)
	defer ts.Stop()

	if err := ts.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	conn, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("failed to connect to socket: %v", err)
	}
	defer conn.Close()

	// Step 1: Send initialize
	resp := sendJSONRPC(t, conn, "initialize", 1, map[string]interface{}{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]interface{}{},
		"clientInfo": map[string]interface{}{
			"name":    "test-client",
			"version": "1.0.0",
		},
	})

	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected result object, got: %v", resp)
	}
	if result["protocolVersion"] != "2024-11-05" {
		t.Errorf("expected echoed protocolVersion, got: %v", result["protocolVersion"])
	}
	caps, ok := result["capabilities"].(map[string]interface{})
	if !ok {
		t.Fatal("expected capabilities object")
	}
	if _, ok := caps["tools"]; !ok {
		t.Error("capabilities should declare tools")
	}
	info, ok := result["serverInfo"].(map[string]interface{})
	if !ok {
		t.Fatal("expected serverInfo object")
	}
	if info["name"] != McpServerName {
		t.Errorf("serverInfo.name should be %q, got: %v", McpServerName, info["name"])
	}

	// Step 2: Send notifications/initialized (notification, no id)
	// This is a notification so we send it without expecting a response.
	notif := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "notifications/initialized",
	}
	encoder := json.NewEncoder(conn)
	if err := encoder.Encode(notif); err != nil {
		t.Fatalf("failed to send notifications/initialized: %v", err)
	}

	// Step 3: Verify tools/list works after handshake
	resp = sendJSONRPC(t, conn, "tools/list", 2, nil)
	listResult, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected result object for tools/list, got: %v", resp)
	}
	tools, ok := listResult["tools"].([]interface{})
	if !ok {
		t.Fatalf("expected tools array, got: %v", listResult["tools"])
	}
	if len(tools) != 1 {
		t.Errorf("expected 1 tool, got %d", len(tools))
	}
}

func TestToolServer_Ping(t *testing.T) {
	ts := NewToolServer("ping-test")
	defer ts.Stop()

	if err := ts.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	conn, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()

	resp := sendJSONRPC(t, conn, "ping", 1, nil)
	if resp["error"] != nil {
		t.Errorf("ping should not return error, got: %v", resp["error"])
	}
	if resp["result"] == nil {
		t.Error("ping should return a result")
	}
}

func TestToolServer_ToolMetadataInList(t *testing.T) {
	ts := NewToolServer("metadata-test")
	schema := map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"query": map[string]interface{}{
				"type":        "string",
				"description": "Search query",
			},
		},
		"required": []interface{}{"query"},
	}
	ts.RegisterTool("search", func(input map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "found"}, nil
	}, "Search for items", schema)
	defer ts.Stop()

	if err := ts.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	conn, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()

	resp := sendJSONRPC(t, conn, "tools/list", 1, nil)
	result := resp["result"].(map[string]interface{})
	tools := result["tools"].([]interface{})

	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}

	tool := tools[0].(map[string]interface{})
	if tool["name"] != "search" {
		t.Errorf("expected tool name 'search', got: %v", tool["name"])
	}
	if tool["description"] != "Search for items" {
		t.Errorf("expected real description, got: %v", tool["description"])
	}

	toolSchema, ok := tool["inputSchema"].(map[string]interface{})
	if !ok {
		t.Fatal("expected inputSchema object")
	}
	if toolSchema["type"] != "object" {
		t.Errorf("expected schema type 'object', got: %v", toolSchema["type"])
	}
	props, ok := toolSchema["properties"].(map[string]interface{})
	if !ok {
		t.Fatal("expected properties in schema")
	}
	if _, ok := props["query"]; !ok {
		t.Error("expected 'query' property in schema")
	}
}

func TestToolServer_JSONRPCToolsList(t *testing.T) {
	ts := NewToolServer("jsonrpc-test")
	ts.RegisterTool("echo", func(input map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "echoed"}, nil
	}, "Echo tool", nil)
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

// TestToolServer_NotificationsInitialized_RejectsWithID verifies the
// protocol guard added for `notifications/initialized`. Per JSON-RPC
// 2.0 §4.1 and MCP, notifications MUST NOT carry an `id` field.
//
// The handler accepts the malformed message (a request-shaped frame
// with method=notifications/initialized) and treats it as a
// notification — no response is sent. The behavior under test:
//
//   - The server does NOT send a response to the malformed notification
//     (sending a response would itself violate JSON-RPC because
//     notifications never get responses).
//   - Subsequent normal traffic (e.g. tools/list) still works — the
//     malformed notification does not desync the channel or wedge
//     the handler loop.
//
// The protocol-violation log line is emitted at INFO via utils.Log;
// the test does not assert on log output (utils log capture is not
// wired into the backend tests) but does pin the no-response and
// post-violation-still-works contract.
func TestToolServer_NotificationsInitialized_RejectsWithID(t *testing.T) {
	ts := NewToolServer("notif-id-test")
	ts.RegisterTool("echo", func(input map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "echoed"}, nil
	}, "Echo tool", nil)
	defer ts.Stop()

	if err := ts.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	conn, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("failed to connect to socket: %v", err)
	}
	defer conn.Close()

	// Send a malformed notification: method=notifications/initialized
	// WITH an id field. A well-behaved client never does this; the
	// handler must log + ignore, not respond.
	malformed := map[string]interface{}{
		"jsonrpc": "2.0",
		"id":      42, // <-- the violation: notifications must omit id
		"method":  "notifications/initialized",
	}
	encoder := json.NewEncoder(conn)
	if err := encoder.Encode(malformed); err != nil {
		t.Fatalf("failed to send malformed notification: %v", err)
	}

	// Verify no response was sent for the malformed notification.
	// We probe by sending a follow-up tools/list request and reading
	// its response — if the server had erroneously responded to the
	// notification, we'd see that response here instead of the
	// tools/list reply. sendJSONRPC reads exactly one response frame
	// and asserts its shape (tools array), so this dual-purpose
	// check confirms both invariants in one round-trip.
	resp := sendJSONRPC(t, conn, "tools/list", 99, nil)
	if resp["id"] != float64(99) {
		t.Errorf("expected response.id=99 for tools/list, got %v — possibly a stray response to the malformed notification", resp["id"])
	}
	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected tools/list result, got: %v", resp)
	}
	tools, ok := result["tools"].([]interface{})
	if !ok || len(tools) != 1 {
		t.Errorf("tools/list after malformed notification must still work, got: %v", result)
	}
}

// TestToolServer_NotificationsInitialized_ProperlyOmittedID verifies
// the happy path: a notification with no `id` field is accepted
// silently and the channel stays usable.
func TestToolServer_NotificationsInitialized_ProperlyOmittedID(t *testing.T) {
	ts := NewToolServer("notif-no-id-test")
	ts.RegisterTool("echo", func(input map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "echoed"}, nil
	}, "Echo tool", nil)
	defer ts.Stop()

	if err := ts.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	conn, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("failed to connect to socket: %v", err)
	}
	defer conn.Close()

	// Send a properly-shaped notification: no `id` field at all.
	proper := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "notifications/initialized",
	}
	encoder := json.NewEncoder(conn)
	if err := encoder.Encode(proper); err != nil {
		t.Fatalf("failed to send proper notification: %v", err)
	}

	// Subsequent request must still work.
	resp := sendJSONRPC(t, conn, "tools/list", 1, nil)
	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected tools/list result, got: %v", resp)
	}
	tools, ok := result["tools"].([]interface{})
	if !ok || len(tools) != 1 {
		t.Errorf("tools/list after proper notification must work, got: %v", result)
	}
}
