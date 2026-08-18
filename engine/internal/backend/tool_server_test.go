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
	if strings.Contains(ts.SocketPath(), "test-session-123") {
		t.Errorf("socket path must not contain the raw session ID, got: %s", ts.SocketPath())
	}
	want := "sock-" + socketToken("test-session-123")
	if !strings.Contains(ts.SocketPath(), want) {
		t.Errorf("socket path should contain derived token %q, got: %s", want, ts.SocketPath())
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

	sockPath := ts.SocketPath()
	if _, err := os.Stat(sockPath); err != nil {
		t.Errorf("socket file should exist after Start, got: %v", err)
	}

	ts.Stop()

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

func TestMcpServerSpec_AcpStdioShape(t *testing.T) {
	ts := NewToolServer("spec-test")
	spec := ts.McpServerSpec()

	if spec["name"] != McpServerName {
		t.Errorf("name = %v, want %q", spec["name"], McpServerName)
	}
	if spec["command"] != "socat" {
		t.Errorf("command = %v, want socat", spec["command"])
	}
	args, ok := spec["args"].([]string)
	if !ok || len(args) != 2 || args[1] != "STDIO" {
		t.Errorf("args = %v, want [UNIX-CONNECT:<sock> STDIO]", spec["args"])
	}
	if !strings.HasPrefix(args[0], "UNIX-CONNECT:") || !strings.Contains(args[0], ts.SocketPath()) {
		t.Errorf("args[0] = %q, want UNIX-CONNECT to the tool-server socket %q", args[0], ts.SocketPath())
	}
	if _, hasEnv := spec["env"]; !hasEnv {
		t.Error("spec missing env (grok's stdio McpServer serde requires it)")
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
		data, _ := json.Marshal(params) //nolint:errcheck // test helper
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

// initializeSession performs the MCP initialize handshake on conn. The SDK
// server requires this before it will accept tools/list, tools/call, or ping.
func initializeSession(t *testing.T, conn net.Conn) {
	t.Helper()
	resp := sendJSONRPC(t, conn, "initialize", 0, map[string]interface{}{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]interface{}{},
		"clientInfo": map[string]interface{}{
			"name":    "test-client",
			"version": "1.0.0",
		},
	})
	if resp["error"] != nil {
		t.Fatalf("initialize returned error: %v", resp["error"])
	}

	notif := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "notifications/initialized",
	}
	encoder := json.NewEncoder(conn)
	if err := encoder.Encode(notif); err != nil {
		t.Fatalf("failed to send notifications/initialized: %v", err)
	}
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

	notif := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "notifications/initialized",
	}
	encoder := json.NewEncoder(conn)
	if err := encoder.Encode(notif); err != nil {
		t.Fatalf("failed to send notifications/initialized: %v", err)
	}

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

	initializeSession(t, conn)

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

	initializeSession(t, conn)

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

	conn, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("failed to connect to socket: %v", err)
	}
	defer conn.Close()

	initializeSession(t, conn)

	resp := sendJSONRPC(t, conn, "tools/list", 1, nil)

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

func TestToolServer_ToolsCall(t *testing.T) {
	ts := NewToolServer("call-test")
	ts.RegisterTool("greet", func(input map[string]interface{}) (*types.ToolResult, error) {
		name, _ := input["name"].(string) //nolint:errcheck // test
		return &types.ToolResult{Content: "Hello, " + name}, nil
	}, "Greet a user", map[string]interface{}{
		"type": "object",
		"properties": map[string]interface{}{
			"name": map[string]interface{}{"type": "string"},
		},
	})
	defer ts.Stop()

	if err := ts.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	conn, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()

	initializeSession(t, conn)

	resp := sendJSONRPC(t, conn, "tools/call", 1, map[string]interface{}{
		"name":      "greet",
		"arguments": map[string]interface{}{"name": "World"},
	})

	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected result object, got: %v", resp)
	}

	content, ok := result["content"].([]interface{})
	if !ok || len(content) == 0 {
		t.Fatalf("expected content array with items, got: %v", result["content"])
	}

	first := content[0].(map[string]interface{})
	if first["text"] != "Hello, World" {
		t.Errorf("expected 'Hello, World', got: %v", first["text"])
	}
}

func TestToolServer_ToolsCall_ErrorResult(t *testing.T) {
	ts := NewToolServer("call-err-test")
	ts.RegisterTool("fail", func(input map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "something went wrong", IsError: true}, nil
	}, "Always fails", nil)
	defer ts.Stop()

	if err := ts.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	conn, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()

	initializeSession(t, conn)

	resp := sendJSONRPC(t, conn, "tools/call", 1, map[string]interface{}{
		"name": "fail",
	})

	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected result, got: %v", resp)
	}

	isError, _ := result["isError"].(bool) //nolint:errcheck // test
	if !isError {
		t.Error("expected isError=true for failing tool")
	}
}

func TestToolServer_HasTool(t *testing.T) {
	ts := NewToolServer("hastool-test")
	ts.RegisterTool("present", func(input map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "ok"}, nil
	}, "Present tool", nil)

	if !ts.HasTool("present") {
		t.Error("HasTool should return true for registered tool")
	}
	if ts.HasTool("absent") {
		t.Error("HasTool should return false for unregistered tool")
	}
}

func TestToolServer_MultipleConnections(t *testing.T) {
	ts := NewToolServer("multi-conn-test")
	ts.RegisterTool("echo", func(input map[string]interface{}) (*types.ToolResult, error) {
		return &types.ToolResult{Content: "echoed"}, nil
	}, "Echo tool", nil)
	defer ts.Stop()

	if err := ts.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	conn1, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("failed to connect (1): %v", err)
	}
	defer conn1.Close()

	conn2, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("failed to connect (2): %v", err)
	}
	defer conn2.Close()

	initializeSession(t, conn1)
	initializeSession(t, conn2)

	resp1 := sendJSONRPC(t, conn1, "tools/list", 1, nil)
	resp2 := sendJSONRPC(t, conn2, "tools/list", 1, nil)

	for i, resp := range []map[string]interface{}{resp1, resp2} {
		result, ok := resp["result"].(map[string]interface{})
		if !ok {
			t.Fatalf("conn %d: expected result object", i+1)
		}
		tools, ok := result["tools"].([]interface{})
		if !ok || len(tools) != 1 {
			t.Errorf("conn %d: expected 1 tool, got: %v", i+1, result["tools"])
		}
	}
}
