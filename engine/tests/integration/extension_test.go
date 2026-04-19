//go:build integration

package integration

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// ─── Extension: Host creation ───

func TestExtensionHostCreate(t *testing.T) {
	host := extension.NewHost()
	if host == nil {
		t.Fatal("expected non-nil host")
	}
}

// ─── Extension: SDK creation ───

func TestExtensionSDKAccess(t *testing.T) {
	host := extension.NewHost()
	sdk := host.SDK()
	if sdk == nil {
		t.Fatal("expected non-nil SDK from host")
	}
}

// ─── Extension: Load with nonexistent dir fails gracefully ───

func TestExtensionLoadNonexistentDir(t *testing.T) {
	host := extension.NewHost()

	err := host.Load("/nonexistent/extension/dir", &extension.ExtensionConfig{
		WorkingDirectory: "/tmp",
	})
	// Should either succeed with no extension or return a non-panic error.
	_ = err
}

// ─── Extension: Tools empty before load ───

func TestExtensionToolsEmptyBeforeLoad(t *testing.T) {
	host := extension.NewHost()
	tools := host.Tools()
	if len(tools) != 0 {
		t.Errorf("expected 0 tools before load, got %d", len(tools))
	}
}

// ─── Extension: Commands empty before load ───

func TestExtensionCommandsEmptyBeforeLoad(t *testing.T) {
	host := extension.NewHost()
	cmds := host.Commands()
	if len(cmds) != 0 {
		t.Errorf("expected 0 commands before load, got %d", len(cmds))
	}
}

// ─── Extension: Dispose is safe before load ───

func TestExtensionDisposeBeforeLoad(t *testing.T) {
	host := extension.NewHost()
	host.Dispose()
}

// ─── Extension: Double dispose is safe ───

func TestExtensionDoubleDispose(t *testing.T) {
	host := extension.NewHost()
	host.Dispose()
	host.Dispose()
}

// ─── Extension: Hook registration via SDK (generic On) ───

func TestExtensionHookRegistration(t *testing.T) {
	host := extension.NewHost()
	sdk := host.SDK()

	called := false
	sdk.On(extension.HookSessionStart, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		called = true
		return nil, nil
	})

	ctx := &extension.Context{}
	err := host.FireSessionStart(ctx)
	if err != nil {
		t.Fatalf("FireSessionStart: %v", err)
	}
	if !called {
		t.Error("session_start hook was not called")
	}
}

// ─── Extension: Tool registration via SDK ───

func TestExtensionToolRegistration(t *testing.T) {
	host := extension.NewHost()
	sdk := host.SDK()

	sdk.RegisterTool(extension.ToolDefinition{
		Name:        "test-tool",
		Description: "A test tool",
		Parameters: map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
		},
		Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "test output"}, nil
		},
	})

	tools := host.Tools()
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}
	if tools[0].Name != "test-tool" {
		t.Errorf("expected tool name=test-tool, got %q", tools[0].Name)
	}
}

// ─── Extension: Command registration via SDK ───

func TestExtensionCommandRegistration(t *testing.T) {
	host := extension.NewHost()
	sdk := host.SDK()

	sdk.RegisterCommand("test-cmd", extension.CommandDefinition{
		Description: "A test command",
		Execute: func(args string, ctx *extension.Context) error {
			return nil
		},
	})

	cmds := host.Commands()
	if len(cmds) != 1 {
		t.Fatalf("expected 1 command, got %d", len(cmds))
	}
	if _, ok := cmds["test-cmd"]; !ok {
		t.Error("expected command 'test-cmd' to be registered")
	}
}

// ─── Extension: Multiple hooks fire in order ───

func TestExtensionMultipleHooksFire(t *testing.T) {
	host := extension.NewHost()
	sdk := host.SDK()

	var order []int
	sdk.On(extension.HookSessionStart, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		order = append(order, 1)
		return nil, nil
	})
	sdk.On(extension.HookSessionStart, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		order = append(order, 2)
		return nil, nil
	})

	host.FireSessionStart(&extension.Context{})

	if len(order) != 2 {
		t.Fatalf("expected 2 hooks fired, got %d", len(order))
	}
	if order[0] != 1 || order[1] != 2 {
		t.Errorf("expected hooks in registration order [1,2], got %v", order)
	}
}

// ─── Extension: Tool execution through host ───

func TestExtensionToolExecution(t *testing.T) {
	host := extension.NewHost()
	sdk := host.SDK()

	sdk.RegisterTool(extension.ToolDefinition{
		Name:        "echo",
		Description: "Echo tool",
		Parameters: map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{"text": map[string]interface{}{"type": "string"}},
		},
		Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
			m, ok := params.(map[string]interface{})
			if !ok {
				return &types.ToolResult{Content: "bad params", IsError: true}, nil
			}
			text, _ := m["text"].(string)
			return &types.ToolResult{Content: "Echo: " + text}, nil
		},
	})

	tools := host.Tools()
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}

	result, err := tools[0].Execute(map[string]interface{}{"text": "world"}, &extension.Context{})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if result.Content != "Echo: world" {
		t.Errorf("expected 'Echo: world', got %q", result.Content)
	}
}
