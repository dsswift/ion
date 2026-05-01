package extension

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Ensure types import is used
var _ = types.ToolResult{}

func TestSDK_FirePermissionRequest(t *testing.T) {
	sdk := NewSDK()

	var received PermissionRequestInfo
	sdk.On(HookPermissionRequest, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(PermissionRequestInfo)
		return nil, nil
	})

	info := PermissionRequestInfo{
		ToolName: "Bash",
		Input:    map[string]interface{}{"command": "rm -rf /"},
		Decision: "pending",
	}
	sdk.FirePermissionRequest(testCtx(), info)

	if received.ToolName != "Bash" {
		t.Fatalf("expected Bash, got %q", received.ToolName)
	}
}

func TestSDK_FirePermissionDenied(t *testing.T) {
	sdk := NewSDK()

	var received PermissionDeniedInfo
	sdk.On(HookPermissionDenied, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(PermissionDeniedInfo)
		return nil, nil
	})

	info := PermissionDeniedInfo{
		ToolName: "Write",
		Input:    map[string]interface{}{"filePath": "/etc/passwd"},
		Reason:   "blocked by policy",
	}
	sdk.FirePermissionDenied(testCtx(), info)

	if received.Reason != "blocked by policy" {
		t.Fatalf("expected 'blocked by policy', got %q", received.Reason)
	}
}

func TestSDK_FireFileChanged(t *testing.T) {
	sdk := NewSDK()

	var received FileChangedInfo
	sdk.On(HookFileChanged, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(FileChangedInfo)
		return nil, nil
	})

	info := FileChangedInfo{Path: "/tmp/foo.ts", Action: "write"}
	sdk.FireFileChanged(testCtx(), info)

	if received.Path != "/tmp/foo.ts" {
		t.Fatalf("expected /tmp/foo.ts, got %q", received.Path)
	}
	if received.Action != "write" {
		t.Fatalf("expected write, got %q", received.Action)
	}
}

func TestSDK_FireTaskCreated(t *testing.T) {
	sdk := NewSDK()

	var received TaskLifecycleInfo
	sdk.On(HookTaskCreated, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(TaskLifecycleInfo)
		return nil, nil
	})

	info := TaskLifecycleInfo{TaskID: "task-1", Name: "do something"}
	sdk.FireTaskCreated(testCtx(), info)

	if received.TaskID != "task-1" {
		t.Fatalf("expected task-1, got %q", received.TaskID)
	}
}

func TestSDK_FireTaskCompleted(t *testing.T) {
	sdk := NewSDK()

	var received TaskLifecycleInfo
	sdk.On(HookTaskCompleted, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(TaskLifecycleInfo)
		return nil, nil
	})

	info := TaskLifecycleInfo{TaskID: "task-1", Status: "completed"}
	sdk.FireTaskCompleted(testCtx(), info)

	if received.Status != "completed" {
		t.Fatalf("expected completed, got %q", received.Status)
	}
}

func TestSDK_FireElicitationRequest_NoHandler(t *testing.T) {
	sdk := NewSDK()

	result, err := sdk.FireElicitationRequest(testCtx(), ElicitationRequestInfo{
		RequestID: "req-1",
		Mode:      "form",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Fatal("expected nil result when no handler")
	}
}

func TestSDK_FireElicitationRequest_WithResponse(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookElicitationRequest, func(ctx *Context, payload interface{}) (interface{}, error) {
		return map[string]interface{}{"choice": "A"}, nil
	})

	result, err := sdk.FireElicitationRequest(testCtx(), ElicitationRequestInfo{
		RequestID: "req-1",
		Mode:      "form",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result["choice"] != "A" {
		t.Fatalf("expected choice A, got %v", result["choice"])
	}
}

func TestSDK_FireElicitationResult(t *testing.T) {
	sdk := NewSDK()

	var received ElicitationResultInfo
	sdk.On(HookElicitationResult, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(ElicitationResultInfo)
		return nil, nil
	})

	info := ElicitationResultInfo{
		RequestID: "req-1",
		Response:  map[string]interface{}{"choice": "A"},
		Cancelled: false,
	}
	sdk.FireElicitationResult(testCtx(), info)

	if received.RequestID != "req-1" {
		t.Fatalf("expected req-1, got %q", received.RequestID)
	}
	if received.Cancelled {
		t.Fatal("expected not cancelled")
	}
}

// --- Per-tool hooks: all 7 tool call hooks ---

func TestSDK_FireOnError_AllCategories(t *testing.T) {
	categories := []ErrorCategory{
		ErrorCategoryTool,
		ErrorCategoryProvider,
		ErrorCategoryPermission,
		ErrorCategoryMcp,
		ErrorCategoryCompaction,
	}

	for _, cat := range categories {
		t.Run(string(cat), func(t *testing.T) {
			sdk := NewSDK()

			var received ErrorInfo
			sdk.On(HookOnError, func(ctx *Context, payload interface{}) (interface{}, error) {
				received = payload.(ErrorInfo)
				return nil, nil
			})

			info := ErrorInfo{
				Message:  "test error",
				Category: cat,
			}
			if err := sdk.FireOnError(testCtx(), info); err != nil {
				t.Fatal(err)
			}
			if received.Category != cat {
				t.Fatalf("expected %q, got %q", cat, received.Category)
			}
		})
	}
}

func TestSDK_FireOnError_WithAllFields(t *testing.T) {
	sdk := NewSDK()

	var received ErrorInfo
	sdk.On(HookOnError, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(ErrorInfo)
		return nil, nil
	})

	info := ErrorInfo{
		Message:      "rate limited",
		ErrorCode:    "RATE_LIMIT",
		Category:     ErrorCategoryProvider,
		Retryable:    true,
		RetryAfterMs: 5000,
		HttpStatus:   429,
	}
	sdk.FireOnError(testCtx(), info)

	if received.ErrorCode != "RATE_LIMIT" {
		t.Errorf("ErrorCode = %q", received.ErrorCode)
	}
	if !received.Retryable {
		t.Error("expected Retryable=true")
	}
	if received.RetryAfterMs != 5000 {
		t.Errorf("RetryAfterMs = %d", received.RetryAfterMs)
	}
	if received.HttpStatus != 429 {
		t.Errorf("HttpStatus = %d", received.HttpStatus)
	}
}

// --- AppendEntry tests ---

func TestSDK_FireSessionEnd(t *testing.T) {
	sdk := NewSDK()
	var called bool
	sdk.On(HookSessionEnd, func(ctx *Context, payload interface{}) (interface{}, error) {
		called = true
		return nil, nil
	})

	sdk.FireSessionEnd(testCtx())
	if !called {
		t.Fatal("expected session_end hook to fire")
	}
}

func TestSDK_FireTurnStart(t *testing.T) {
	sdk := NewSDK()
	var received TurnInfo
	sdk.On(HookTurnStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(TurnInfo)
		return nil, nil
	})

	sdk.FireTurnStart(testCtx(), TurnInfo{TurnNumber: 5})
	if received.TurnNumber != 5 {
		t.Fatalf("expected turn 5, got %d", received.TurnNumber)
	}
}

func TestSDK_FireTurnEnd(t *testing.T) {
	sdk := NewSDK()
	var called bool
	sdk.On(HookTurnEnd, func(ctx *Context, payload interface{}) (interface{}, error) {
		called = true
		return nil, nil
	})

	sdk.FireTurnEnd(testCtx(), TurnInfo{TurnNumber: 3})
	if !called {
		t.Fatal("expected turn_end hook to fire")
	}
}

func TestSDK_FireMessageStart(t *testing.T) {
	sdk := NewSDK()
	var called bool
	sdk.On(HookMessageStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		called = true
		return nil, nil
	})

	sdk.FireMessageStart(testCtx())
	if !called {
		t.Fatal("expected message_start hook to fire")
	}
}

func TestSDK_FireMessageEnd(t *testing.T) {
	sdk := NewSDK()
	var called bool
	sdk.On(HookMessageEnd, func(ctx *Context, payload interface{}) (interface{}, error) {
		called = true
		return nil, nil
	})

	sdk.FireMessageEnd(testCtx())
	if !called {
		t.Fatal("expected message_end hook to fire")
	}
}

func TestSDK_FireMessageUpdate(t *testing.T) {
	sdk := NewSDK()
	var received MessageUpdateInfo
	sdk.On(HookMessageUpdate, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(MessageUpdateInfo)
		return nil, nil
	})

	sdk.FireMessageUpdate(testCtx(), MessageUpdateInfo{Role: "assistant", Content: "partial"})
	if received.Content != "partial" {
		t.Fatalf("expected partial, got %q", received.Content)
	}
}

func TestSDK_FireAgentStart(t *testing.T) {
	sdk := NewSDK()
	var received AgentInfo
	sdk.On(HookAgentStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(AgentInfo)
		return nil, nil
	})

	sdk.FireAgentStart(testCtx(), AgentInfo{Name: "sub-agent", Task: "refactor"})
	if received.Name != "sub-agent" {
		t.Fatalf("expected sub-agent, got %q", received.Name)
	}
}

func TestSDK_FireAgentEnd(t *testing.T) {
	sdk := NewSDK()
	var received AgentInfo
	sdk.On(HookAgentEnd, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(AgentInfo)
		return nil, nil
	})

	sdk.FireAgentEnd(testCtx(), AgentInfo{Name: "sub-agent", Task: "done"})
	if received.Task != "done" {
		t.Fatalf("expected done, got %q", received.Task)
	}
}

func TestSDK_FireSessionCompact(t *testing.T) {
	sdk := NewSDK()
	var received CompactionInfo
	sdk.On(HookSessionCompact, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(CompactionInfo)
		return nil, nil
	})

	sdk.FireSessionCompact(testCtx(), CompactionInfo{Strategy: "summary", MessagesBefore: 30, MessagesAfter: 10})
	if received.Strategy != "summary" {
		t.Fatalf("expected summary, got %q", received.Strategy)
	}
}

func TestSDK_FireSessionFork(t *testing.T) {
	sdk := NewSDK()
	var received ForkInfo
	sdk.On(HookSessionFork, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(ForkInfo)
		return nil, nil
	})

	sdk.FireSessionFork(testCtx(), ForkInfo{SourceSessionKey: "s1", NewSessionKey: "s2", ForkMessageIndex: 5})
	if received.ForkMessageIndex != 5 {
		t.Fatalf("expected fork index 5, got %d", received.ForkMessageIndex)
	}
}

func TestSDK_FireUserBash(t *testing.T) {
	sdk := NewSDK()
	var received string
	sdk.On(HookUserBash, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(string)
		return nil, nil
	})

	sdk.FireUserBash(testCtx(), "echo hello")
	if received != "echo hello" {
		t.Fatalf("expected 'echo hello', got %q", received)
	}
}
