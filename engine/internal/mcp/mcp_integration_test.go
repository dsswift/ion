//go:build integration

package mcp

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

var testServerBin string

func TestMain(m *testing.M) {
	// Compile the test MCP server binary.
	tmp, err := os.MkdirTemp("", "mcp-test-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(tmp)

	bin := filepath.Join(tmp, "mcpserver")
	cmd := exec.Command("go", "build", "-o", bin, "./testdata/mcpserver")
	cmd.Dir = filepath.Join(".")
	// Use the current module context for building.
	cmd.Env = os.Environ()
	if out, err := cmd.CombinedOutput(); err != nil {
		panic("build test server: " + err.Error() + "\n" + string(out))
	}
	testServerBin = bin
	os.Exit(m.Run())
}

func TestStdioConnect_FullLifecycle(t *testing.T) {
	conn, err := Connect("integ-test", types.McpServerConfig{
		Command: testServerBin,
	})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer conn.Close()

	// Verify tool discovery.
	tools := conn.Tools()
	if len(tools) != 2 {
		t.Fatalf("expected 2 tools, got %d", len(tools))
	}

	toolNames := make(map[string]bool)
	for _, tool := range tools {
		toolNames[tool.Name] = true
	}
	if !toolNames["echo"] || !toolNames["get_env"] {
		t.Errorf("unexpected tools: %v", toolNames)
	}

	// Call echo tool.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := conn.CallTool(ctx, "echo", map[string]interface{}{"text": "hello world"})
	if err != nil {
		t.Fatalf("CallTool echo: %v", err)
	}
	if result.Content != "hello world" {
		t.Errorf("echo result = %q, want %q", result.Content, "hello world")
	}
}

func TestStdioConnect_Timeout(t *testing.T) {
	conn, err := Connect("integ-timeout", types.McpServerConfig{
		Command:        testServerBin,
		TimeoutSeconds: 1, // 1s timeout — slow_echo sleeps 5s
	})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer conn.Close()

	ctx := context.Background()
	_, err = conn.CallTool(ctx, "slow_echo", map[string]interface{}{"text": "test"})
	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}
	if !strings.Contains(err.Error(), "timeout") {
		t.Errorf("expected 'timeout' in error, got: %s", err)
	}
}

func TestStdioConnect_EnvInheritance(t *testing.T) {
	conn, err := Connect("integ-env", types.McpServerConfig{
		Command: testServerBin,
		Env:     map[string]string{"CUSTOM_TEST_VAR": "custom_value_42"},
	})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Verify custom env var is passed.
	result, err := conn.CallTool(ctx, "get_env", map[string]interface{}{"name": "CUSTOM_TEST_VAR"})
	if err != nil {
		t.Fatalf("CallTool get_env CUSTOM_TEST_VAR: %v", err)
	}
	if result.Content != "custom_value_42" {
		t.Errorf("CUSTOM_TEST_VAR = %q, want %q", result.Content, "custom_value_42")
	}

	// Verify parent PATH is inherited (not wiped).
	result, err = conn.CallTool(ctx, "get_env", map[string]interface{}{"name": "PATH"})
	if err != nil {
		t.Fatalf("CallTool get_env PATH: %v", err)
	}
	if result.Content == "" {
		t.Error("PATH should not be empty — parent env must be inherited")
	}
}

func TestStdioConnect_CloseReaps(t *testing.T) {
	conn, err := Connect("integ-close", types.McpServerConfig{
		Command: testServerBin,
	})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}

	if err := conn.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// After close, calls should fail.
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	_, err = conn.CallTool(ctx, "echo", map[string]interface{}{"text": "should fail"})
	if err == nil {
		t.Error("expected error after close, got nil")
	}
}
