package extension

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Ensure types import is used
var _ = types.ToolResult{}

func TestSDK_FireToolCall_Block(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookToolCall, func(ctx *Context, payload interface{}) (interface{}, error) {
		return &ToolCallResult{Block: true, Reason: "blocked by policy"}, nil
	})

	result, err := sdk.FireToolCall(testCtx(), ToolCallInfo{
		ToolName: "bash",
		ToolID:   "tool_1",
		Input:    map[string]interface{}{"command": "rm -rf /"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil || !result.Block {
		t.Fatal("expected tool call to be blocked")
	}
	if result.Reason != "blocked by policy" {
		t.Fatalf("expected reason 'blocked by policy', got %q", result.Reason)
	}
}

func TestSDK_FireToolCall_Allow(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookToolCall, func(ctx *Context, payload interface{}) (interface{}, error) {
		return nil, nil // no opinion
	})

	result, err := sdk.FireToolCall(testCtx(), ToolCallInfo{
		ToolName: "read",
		ToolID:   "tool_2",
		Input:    map[string]interface{}{"path": "/tmp/test.txt"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Fatal("expected nil result (allow) when no handler blocks")
	}
}

func TestSDK_FirePerToolCall_Block(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookBashToolCall, func(ctx *Context, payload interface{}) (interface{}, error) {
		return &PerToolCallResult{Block: true, Reason: "dangerous command"}, nil
	})

	result, err := sdk.FirePerToolCall(testCtx(), "bash", map[string]interface{}{
		"command": "rm -rf /",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil || !result.Block {
		t.Fatal("expected per-tool call to be blocked")
	}
}

func TestSDK_FirePerToolResult_Modify(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookReadToolResult, func(ctx *Context, payload interface{}) (interface{}, error) {
		return "[redacted]", nil
	})

	content, err := sdk.FirePerToolResult(testCtx(), "read", map[string]interface{}{
		"content": "secret data",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if content != "[redacted]" {
		t.Fatalf("expected redacted content, got %q", content)
	}
}

func TestSDK_FirePerToolCall_AllTools(t *testing.T) {
	tools := []string{"bash", "read", "write", "edit", "grep", "glob", "agent"}
	for _, tool := range tools {
		t.Run(tool, func(t *testing.T) {
			sdk := NewSDK()
			hookName := tool + "_tool_call"

			var called bool
			sdk.On(hookName, func(ctx *Context, payload interface{}) (interface{}, error) {
				called = true
				return nil, nil
			})

			result, err := sdk.FirePerToolCall(testCtx(), tool, map[string]interface{}{})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if result != nil {
				t.Fatal("expected nil result for non-blocking handler")
			}
			if !called {
				t.Fatalf("expected %s handler to be called", hookName)
			}
		})
	}
}

// --- Per-tool hooks: all 7 tool result hooks ---

func TestSDK_FirePerToolResult_AllTools(t *testing.T) {
	tools := []string{"bash", "read", "write", "edit", "grep", "glob", "agent"}
	for _, tool := range tools {
		t.Run(tool, func(t *testing.T) {
			sdk := NewSDK()
			hookName := tool + "_tool_result"

			var called bool
			sdk.On(hookName, func(ctx *Context, payload interface{}) (interface{}, error) {
				called = true
				return "[modified]", nil
			})

			content, err := sdk.FirePerToolResult(testCtx(), tool, map[string]interface{}{})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if content != "[modified]" {
				t.Fatalf("expected [modified], got %q", content)
			}
			if !called {
				t.Fatalf("expected %s handler to be called", hookName)
			}
		})
	}
}

// --- Per-tool call: mutate input ---

func TestSDK_FirePerToolCall_BlockWithMutate(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookReadToolCall, func(ctx *Context, payload interface{}) (interface{}, error) {
		return &PerToolCallResult{
			Block:  true,
			Reason: "redirected",
			Mutate: map[string]interface{}{"file_path": "/safe/path.txt"},
		}, nil
	})

	result, err := sdk.FirePerToolCall(testCtx(), "read", map[string]interface{}{
		"file_path": "/etc/shadow",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result with block+mutate")
	}
	if !result.Block {
		t.Fatal("expected block=true")
	}
	if result.Mutate["file_path"] != "/safe/path.txt" {
		t.Fatalf("expected mutated path, got %v", result.Mutate["file_path"])
	}
}

func TestSDK_FirePerToolCall_MutateWithoutBlock_ReturnsNil(t *testing.T) {
	sdk := NewSDK()

	// When handler returns mutate without block, SDK ignores it
	// (only the host subprocess forwarder handles mutate-without-block)
	sdk.On(HookReadToolCall, func(ctx *Context, payload interface{}) (interface{}, error) {
		return &PerToolCallResult{
			Mutate: map[string]interface{}{"file_path": "/safe/path.txt"},
		}, nil
	})

	result, err := sdk.FirePerToolCall(testCtx(), "read", map[string]interface{}{
		"file_path": "/etc/shadow",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// SDK's FirePerToolCall only returns non-nil when Block=true
	if result != nil {
		t.Fatal("expected nil result when block=false (SDK-level)")
	}
}

// --- Per-tool call: first blocking handler wins ---

func TestSDK_FirePerToolCall_FirstBlockerWins(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookBashToolCall, func(ctx *Context, payload interface{}) (interface{}, error) {
		return &PerToolCallResult{Block: true, Reason: "first"}, nil
	})
	sdk.On(HookBashToolCall, func(ctx *Context, payload interface{}) (interface{}, error) {
		return &PerToolCallResult{Block: true, Reason: "second"}, nil
	})

	result, err := sdk.FirePerToolCall(testCtx(), "bash", map[string]interface{}{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Reason != "first" {
		t.Fatalf("expected first blocker to win, got %q", result.Reason)
	}
}

// --- Per-tool result: no handler ---

func TestSDK_FirePerToolResult_NoHandler(t *testing.T) {
	sdk := NewSDK()

	content, err := sdk.FirePerToolResult(testCtx(), "unknown_tool", map[string]interface{}{})
	if err != nil {
		t.Fatal(err)
	}
	if content != "" {
		t.Fatalf("expected empty string for unknown tool, got %q", content)
	}
}

// --- Error categories ---

func TestSDK_FireToolStart(t *testing.T) {
	sdk := NewSDK()
	var received ToolStartInfo
	sdk.On(HookToolStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(ToolStartInfo)
		return nil, nil
	})

	sdk.FireToolStart(testCtx(), ToolStartInfo{ToolName: "bash", ToolID: "t1"})
	if received.ToolName != "bash" {
		t.Fatalf("expected bash, got %q", received.ToolName)
	}
}

func TestSDK_FireToolEnd(t *testing.T) {
	sdk := NewSDK()
	var called bool
	sdk.On(HookToolEnd, func(ctx *Context, payload interface{}) (interface{}, error) {
		called = true
		return nil, nil
	})

	sdk.FireToolEnd(testCtx())
	if !called {
		t.Fatal("expected tool_end hook to fire")
	}
}

func TestSDK_FireToolResult(t *testing.T) {
	sdk := NewSDK()
	var called bool
	sdk.On(HookToolResult, func(ctx *Context, payload interface{}) (interface{}, error) {
		called = true
		return nil, nil
	})

	sdk.FireToolResult(testCtx(), map[string]interface{}{"content": "result"})
	if !called {
		t.Fatal("expected tool_result hook to fire")
	}
}
