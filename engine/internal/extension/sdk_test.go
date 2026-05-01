package extension

import (
	"errors"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Ensure types import is used
var _ = types.ToolResult{}

func testCtx() *Context {
	return &Context{
		Cwd:   "/tmp/test",
		Model: &ModelRef{ID: "claude-sonnet-4-20250514", ContextWindow: 200000},
	}
}

func TestSDK_On_And_Fire(t *testing.T) {
	sdk := NewSDK()

	var called int
	sdk.On(HookSessionStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		called++
		return nil, nil
	})
	sdk.On(HookSessionStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		called++
		return nil, nil
	})

	if err := sdk.FireSessionStart(testCtx()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if called != 2 {
		t.Fatalf("expected 2 calls, got %d", called)
	}
}

func TestSDK_Fire_NoHandlers(t *testing.T) {
	sdk := NewSDK()
	// Firing with no handlers should not error
	if err := sdk.FireSessionStart(testCtx()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSDK_Fire_ErrorBoundary(t *testing.T) {
	sdk := NewSDK()

	var secondCalled bool
	sdk.On(HookSessionStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		return nil, errors.New("handler exploded")
	})
	sdk.On(HookSessionStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		secondCalled = true
		return nil, nil
	})

	// Error in first handler should not prevent second from running
	if err := sdk.FireSessionStart(testCtx()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !secondCalled {
		t.Fatal("expected second handler to be called despite first handler error")
	}
}

func TestSDK_RegisterTool(t *testing.T) {
	sdk := NewSDK()

	sdk.RegisterTool(ToolDefinition{
		Name:        "my_tool",
		Description: "A test tool",
		Parameters:  map[string]interface{}{"param": "string"},
		Execute: func(params interface{}, ctx *Context) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "result"}, nil
		},
	})

	tools := sdk.Tools()
	if len(tools) != 1 {
		t.Fatalf("expected 1 tool, got %d", len(tools))
	}
	if tools[0].Name != "my_tool" {
		t.Fatalf("expected tool name 'my_tool', got %q", tools[0].Name)
	}
}

func TestSDK_RegisterCommand(t *testing.T) {
	sdk := NewSDK()

	sdk.RegisterCommand("/test", CommandDefinition{
		Description: "A test command",
		Execute: func(args string, ctx *Context) error {
			return nil
		},
	})

	cmds := sdk.Commands()
	if len(cmds) != 1 {
		t.Fatalf("expected 1 command, got %d", len(cmds))
	}
	if _, ok := cmds["/test"]; !ok {
		t.Fatal("expected /test command to be registered")
	}
}

func TestSDK_Handlers_ReturnsCopy(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookSessionStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		return nil, nil
	})

	handlers := sdk.Handlers(HookSessionStart)
	if len(handlers) != 1 {
		t.Fatalf("expected 1 handler, got %d", len(handlers))
	}

	// Modifying returned slice should not affect SDK
	handlers = append(handlers, func(ctx *Context, payload interface{}) (interface{}, error) {
		return nil, nil
	})
	if len(sdk.Handlers(HookSessionStart)) != 1 {
		t.Fatal("modifying returned handlers should not affect SDK")
	}
}

func TestHost_NewHost(t *testing.T) {
	h := NewHost()
	if h.sdk == nil {
		t.Fatal("expected SDK to be initialized")
	}

	tools := h.Tools()
	if len(tools) != 0 {
		t.Fatalf("expected 0 tools, got %d", len(tools))
	}

	cmds := h.Commands()
	if len(cmds) != 0 {
		t.Fatalf("expected 0 commands, got %d", len(cmds))
	}
}

func TestHost_InProcessExtension(t *testing.T) {
	h := NewHost()

	// Register hooks directly (in-process extension)
	var started bool
	h.SDK().On(HookSessionStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		started = true
		return nil, nil
	})

	if err := h.FireSessionStart(testCtx()); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !started {
		t.Fatal("expected session_start hook to fire through host")
	}
}

// --- New hook fire methods ---

func TestSDK_AppendEntry_WithCallback(t *testing.T) {
	sdk := NewSDK()

	var calledType string
	var calledData interface{}
	sdk.SetAppendEntryFn(func(entryType string, data interface{}) error {
		calledType = entryType
		calledData = data
		return nil
	})

	err := sdk.AppendEntry("label", map[string]string{"text": "checkpoint"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if calledType != "label" {
		t.Fatalf("expected label, got %q", calledType)
	}
	if calledData == nil {
		t.Fatal("expected non-nil data")
	}
}

func TestSDK_AppendEntry_WithoutCallback(t *testing.T) {
	sdk := NewSDK()

	err := sdk.AppendEntry("label", nil)
	if err == nil {
		t.Fatal("expected error when no appendEntryFn set")
	}
}

func TestSDK_AppendEntry_CallbackError(t *testing.T) {
	sdk := NewSDK()

	sdk.SetAppendEntryFn(func(entryType string, data interface{}) error {
		return errors.New("session closed")
	})

	err := sdk.AppendEntry("label", nil)
	if err == nil {
		t.Fatal("expected error propagation from callback")
	}
	if err.Error() != "session closed" {
		t.Fatalf("expected 'session closed', got %q", err.Error())
	}
}

// --- Multiple handlers: ordering ---

func TestSDK_Fire_HandlersCalledInOrder(t *testing.T) {
	sdk := NewSDK()

	var order []int
	sdk.On(HookSessionStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		order = append(order, 1)
		return nil, nil
	})
	sdk.On(HookSessionStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		order = append(order, 2)
		return nil, nil
	})
	sdk.On(HookSessionStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		order = append(order, 3)
		return nil, nil
	})

	sdk.FireSessionStart(testCtx())

	if len(order) != 3 || order[0] != 1 || order[1] != 2 || order[2] != 3 {
		t.Fatalf("expected [1, 2, 3], got %v", order)
	}
}

// --- Multiple handlers: error isolation ---

func TestSDK_Fire_ErrorIsolation(t *testing.T) {
	sdk := NewSDK()

	var results []string
	sdk.On(HookSessionStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		results = append(results, "first-ok")
		return nil, nil
	})
	sdk.On(HookSessionStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		return nil, errors.New("second-fails")
	})
	sdk.On(HookSessionStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		results = append(results, "third-ok")
		return nil, nil
	})

	sdk.FireSessionStart(testCtx())

	if len(results) != 2 || results[0] != "first-ok" || results[1] != "third-ok" {
		t.Fatalf("expected [first-ok, third-ok], got %v", results)
	}
}

// --- Context fields ---

func TestContext_AllFields(t *testing.T) {
	ctx := &Context{
		Cwd:   "/project",
		Model: &ModelRef{ID: "claude-opus-4-20250514", ContextWindow: 200000},
		Config: &ExtensionConfig{
			ExtensionDir:     "/ext",
			Model:            "claude-opus-4-20250514",
			WorkingDirectory: "/project",
		},
	}

	if ctx.Cwd != "/project" {
		t.Errorf("Cwd = %q", ctx.Cwd)
	}
	if ctx.Model.ID != "claude-opus-4-20250514" {
		t.Errorf("Model.ID = %q", ctx.Model.ID)
	}
	if ctx.Model.ContextWindow != 200000 {
		t.Errorf("ContextWindow = %d", ctx.Model.ContextWindow)
	}
	if ctx.Config.ExtensionDir != "/ext" {
		t.Errorf("ExtensionDir = %q", ctx.Config.ExtensionDir)
	}
}

func TestContext_FunctionalGetters(t *testing.T) {
	var aborted bool
	ctx := &Context{
		Cwd:   "/tmp",
		Model: &ModelRef{ID: "test-model", ContextWindow: 100000},
		GetContextUsage: func() *ContextUsage {
			return &ContextUsage{Percent: 42, Tokens: 42000, Cost: 0.05}
		},
		Abort: func() {
			aborted = true
		},
	}

	usage := ctx.GetContextUsage()
	if usage.Percent != 42 {
		t.Errorf("Percent = %d", usage.Percent)
	}
	if usage.Tokens != 42000 {
		t.Errorf("Tokens = %d", usage.Tokens)
	}

	ctx.Abort()
	if !aborted {
		t.Fatal("expected abort to be called")
	}
}

// --- Lifecycle hooks ---
