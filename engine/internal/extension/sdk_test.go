package extension

import (
	"errors"
	"strings"
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

func TestSDK_FireBeforePrompt_ModifiesPrompt(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookBeforePrompt, func(ctx *Context, payload interface{}) (interface{}, error) {
		return "modified prompt", nil
	})

	result, sysPrompt, err := sdk.FireBeforePrompt(testCtx(), "original prompt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "modified prompt" {
		t.Fatalf("expected modified prompt, got %q", result)
	}
	if sysPrompt != "" {
		t.Fatalf("expected empty systemPrompt, got %q", sysPrompt)
	}
}

func TestSDK_FireBeforePrompt_LastWins(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookBeforePrompt, func(ctx *Context, payload interface{}) (interface{}, error) {
		return "first", nil
	})
	sdk.On(HookBeforePrompt, func(ctx *Context, payload interface{}) (interface{}, error) {
		return "second", nil
	})

	result, _, err := sdk.FireBeforePrompt(testCtx(), "original")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "second" {
		t.Fatalf("expected last handler to win, got %q", result)
	}
}

func TestSDK_FireBeforePrompt_NoModification(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookBeforePrompt, func(ctx *Context, payload interface{}) (interface{}, error) {
		return nil, nil // no opinion
	})

	result, sysPrompt, err := sdk.FireBeforePrompt(testCtx(), "original")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "original" {
		t.Fatalf("expected original prompt when no handler modifies, got %q", result)
	}
	if sysPrompt != "" {
		t.Fatalf("expected empty systemPrompt, got %q", sysPrompt)
	}
}

func TestSDK_FireBeforePrompt_SystemPromptOverride(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookBeforePrompt, func(ctx *Context, payload interface{}) (interface{}, error) {
		return BeforePromptResult{
			Prompt:       "rewritten prompt",
			SystemPrompt: "extra system context",
		}, nil
	})

	result, sysPrompt, err := sdk.FireBeforePrompt(testCtx(), "original")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "rewritten prompt" {
		t.Fatalf("expected rewritten prompt, got %q", result)
	}
	if sysPrompt != "extra system context" {
		t.Fatalf("expected system prompt override, got %q", sysPrompt)
	}
}

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

func TestSDK_FireSessionBeforeCompact_Cancel(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookSessionBeforeCompact, func(ctx *Context, payload interface{}) (interface{}, error) {
		return true, nil // cancel compaction
	})

	cancel, err := sdk.FireSessionBeforeCompact(testCtx(), CompactionInfo{
		Strategy:       "truncate",
		MessagesBefore: 100,
		MessagesAfter:  50,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cancel {
		t.Fatal("expected compaction to be cancelled")
	}
}

func TestSDK_FireSessionBeforeCompact_Allow(t *testing.T) {
	sdk := NewSDK()

	cancel, err := sdk.FireSessionBeforeCompact(testCtx(), CompactionInfo{
		Strategy:       "summarize",
		MessagesBefore: 50,
		MessagesAfter:  25,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cancel {
		t.Fatal("expected compaction to proceed with no handlers")
	}
}

func TestSDK_FireInput_Modify(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookInput, func(ctx *Context, payload interface{}) (interface{}, error) {
		prompt := payload.(string)
		return prompt + " [enhanced]", nil
	})

	result, err := sdk.FireInput(testCtx(), "hello")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != "hello [enhanced]" {
		t.Fatalf("expected modified input, got %q", result)
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

func TestSDK_FireContextDiscover_Reject(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookContextDiscover, func(ctx *Context, payload interface{}) (interface{}, error) {
		info := payload.(ContextDiscoverInfo)
		if info.Path == "/secret/.env" {
			return true, nil // reject
		}
		return nil, nil
	})

	rejected, err := sdk.FireContextDiscover(testCtx(), ContextDiscoverInfo{
		Path:   "/secret/.env",
		Source: "auto",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !rejected {
		t.Fatal("expected context to be rejected")
	}

	rejected, err = sdk.FireContextDiscover(testCtx(), ContextDiscoverInfo{
		Path:   "/project/CLAUDE.md",
		Source: "auto",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rejected {
		t.Fatal("expected context to be accepted")
	}
}

func TestSDK_FireContextLoad_ModifyContent(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookContextLoad, func(ctx *Context, payload interface{}) (interface{}, error) {
		return "injected content", nil
	})

	content, rejected, err := sdk.FireContextLoad(testCtx(), ContextLoadInfo{
		Path:    "/project/CLAUDE.md",
		Content: "original content",
		Source:  "auto",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rejected {
		t.Fatal("expected not rejected")
	}
	if content != "injected content" {
		t.Fatalf("expected modified content, got %q", content)
	}
}

func TestSDK_FireContextLoad_Reject(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookContextLoad, func(ctx *Context, payload interface{}) (interface{}, error) {
		return true, nil // reject
	})

	_, rejected, err := sdk.FireContextLoad(testCtx(), ContextLoadInfo{
		Path:    "/secret/data",
		Content: "sensitive",
		Source:  "auto",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !rejected {
		t.Fatal("expected context load to be rejected")
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

func TestSDK_FireSessionBeforeFork_Cancel(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookSessionBeforeFork, func(ctx *Context, payload interface{}) (interface{}, error) {
		return true, nil
	})

	cancel, err := sdk.FireSessionBeforeFork(testCtx(), ForkInfo{
		SourceSessionKey: "sess_1",
		NewSessionKey:    "sess_2",
		ForkMessageIndex: 5,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cancel {
		t.Fatal("expected fork to be cancelled")
	}
}

func TestSDK_FireModelSelect_Override(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookModelSelect, func(ctx *Context, payload interface{}) (interface{}, error) {
		return "claude-opus-4-20250514", nil
	})

	model, err := sdk.FireModelSelect(testCtx(), ModelSelectInfo{
		RequestedModel:  "claude-sonnet-4-20250514",
		AvailableModels: []string{"claude-sonnet-4-20250514", "claude-opus-4-20250514"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if model != "claude-opus-4-20250514" {
		t.Fatalf("expected model override, got %q", model)
	}
}

func TestSDK_FireModelSelect_NoOverride(t *testing.T) {
	sdk := NewSDK()

	model, err := sdk.FireModelSelect(testCtx(), ModelSelectInfo{
		RequestedModel: "claude-sonnet-4-20250514",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if model != "claude-sonnet-4-20250514" {
		t.Fatalf("expected original model, got %q", model)
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

func TestSDK_FireBeforeAgentStart(t *testing.T) {
	sdk := NewSDK()
	var received AgentInfo
	sdk.On(HookBeforeAgentStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(AgentInfo)
		return nil, nil
	})

	sdk.FireBeforeAgentStart(testCtx(), AgentInfo{Name: "pre-agent"})
	if received.Name != "pre-agent" {
		t.Fatalf("expected pre-agent, got %q", received.Name)
	}
}

func TestSDK_FireBeforeProviderRequest(t *testing.T) {
	sdk := NewSDK()
	var called bool
	sdk.On(HookBeforeProviderRequest, func(ctx *Context, payload interface{}) (interface{}, error) {
		called = true
		return nil, nil
	})

	sdk.FireBeforeProviderRequest(testCtx(), map[string]interface{}{"model": "test"})
	if !called {
		t.Fatal("expected before_provider_request hook to fire")
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

func TestSDK_FireSessionBeforeSwitch(t *testing.T) {
	sdk := NewSDK()
	var called bool
	sdk.On(HookSessionBeforeSwitch, func(ctx *Context, payload interface{}) (interface{}, error) {
		called = true
		return nil, nil
	})

	sdk.FireSessionBeforeSwitch(testCtx())
	if !called {
		t.Fatal("expected session_before_switch hook to fire")
	}
}

func TestSDK_FireContext(t *testing.T) {
	sdk := NewSDK()
	var called bool
	sdk.On(HookContext, func(ctx *Context, payload interface{}) (interface{}, error) {
		called = true
		return nil, nil
	})

	sdk.FireContext(testCtx(), map[string]interface{}{"key": "value"})
	if !called {
		t.Fatal("expected context hook to fire")
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

func TestSDK_FireInstructionLoad(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookInstructionLoad, func(ctx *Context, payload interface{}) (interface{}, error) {
		return "modified instructions", nil
	})

	content, rejected, err := sdk.FireInstructionLoad(testCtx(), ContextLoadInfo{
		Path:    "/project/.claude/instructions.md",
		Content: "original instructions",
		Source:  "auto",
	})
	if err != nil {
		t.Fatal(err)
	}
	if rejected {
		t.Fatal("expected not rejected")
	}
	if content != "modified instructions" {
		t.Fatalf("expected modified, got %q", content)
	}
}

func TestSDK_FireInstructionLoad_Reject(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookInstructionLoad, func(ctx *Context, payload interface{}) (interface{}, error) {
		return true, nil
	})

	_, rejected, err := sdk.FireInstructionLoad(testCtx(), ContextLoadInfo{
		Path:    "/secret/data",
		Content: "sensitive",
		Source:  "auto",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !rejected {
		t.Fatal("expected rejection")
	}
}

// --- External hook manager tests ---

func TestExternalHookManager_NewEmpty(t *testing.T) {
	mgr := NewExternalHookManager(nil)
	events := mgr.RegisteredEvents()
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
}

func TestExternalHookManager_RegisteredEvents(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"session_start": []interface{}{
			[]interface{}{"echo", "start"},
		},
		"session_end": []interface{}{
			[]interface{}{"echo", "end"},
		},
	})

	events := mgr.RegisteredEvents()
	if len(events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(events))
	}

	has := make(map[string]bool)
	for _, e := range events {
		has[e] = true
	}
	if !has["session_start"] || !has["session_end"] {
		t.Fatalf("expected session_start and session_end, got %v", events)
	}
}

func TestExternalHookManager_UpdateConfig(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"session_start": []interface{}{
			[]interface{}{"echo", "old"},
		},
	})

	events := mgr.RegisteredEvents()
	if len(events) != 1 || events[0] != "session_start" {
		t.Fatalf("expected [session_start], got %v", events)
	}

	mgr.UpdateConfig(map[string]interface{}{
		"on_error": []interface{}{
			[]interface{}{"echo", "error"},
		},
	})

	events = mgr.RegisteredEvents()
	if len(events) != 1 || events[0] != "on_error" {
		t.Fatalf("expected [on_error], got %v", events)
	}
}

func TestExternalHookManager_FireUnknownEvent(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"session_start": []interface{}{
			[]interface{}{"echo", "hi"},
		},
	})

	err := mgr.Fire("nonexistent_event", nil)
	if err != nil {
		t.Fatalf("expected no error for unknown event, got %v", err)
	}
}

func TestExternalHookManager_FireAwaited(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"test_event": []interface{}{
			map[string]interface{}{
				"command": []interface{}{"true"},
				"await":   true,
				"timeout": float64(5000),
			},
		},
	})

	err := mgr.Fire("test_event", map[string]interface{}{"key": "value"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestExternalHookManager_PayloadTruncation(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"big_event": []interface{}{
			map[string]interface{}{
				"command": []interface{}{"true"},
				"await":   true,
				"timeout": float64(5000),
			},
		},
	})

	// Build a payload larger than 1MB
	bigPayload := map[string]interface{}{
		"data": strings.Repeat("x", 2*1024*1024),
	}
	err := mgr.Fire("big_event", bigPayload)
	if err != nil {
		t.Fatalf("expected no error for large payload, got %v", err)
	}
}

func TestExternalHookManager_ParseObjectFormat(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"tool_call": []interface{}{
			map[string]interface{}{
				"command": []interface{}{"python3", "audit.py"},
				"await":   true,
				"timeout": float64(5000),
			},
		},
	})

	events := mgr.RegisteredEvents()
	if len(events) != 1 || events[0] != "tool_call" {
		t.Fatalf("expected [tool_call], got %v", events)
	}
}

func TestExternalHookManager_ParseArrayFormat(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"session_start": []interface{}{
			[]interface{}{"bash", "-c", "echo hello"},
		},
	})

	events := mgr.RegisteredEvents()
	if len(events) != 1 || events[0] != "session_start" {
		t.Fatalf("expected [session_start], got %v", events)
	}
}

func TestExternalHookManager_IgnoresInvalidEntries(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"bad_event": "not an array",
	})

	events := mgr.RegisteredEvents()
	if len(events) != 0 {
		t.Fatalf("expected 0 events for invalid config, got %d", len(events))
	}
}

func TestExternalHookManager_EmptyConfig(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{})

	events := mgr.RegisteredEvents()
	if len(events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(events))
	}
}

func TestExternalHookManager_FireAndForget(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"test_event": []interface{}{
			[]interface{}{"true"},
		},
	})

	// Fire-and-forget should not block and should not error
	err := mgr.Fire("test_event", map[string]interface{}{"key": "value"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestExternalHookManager_MultipleHooksPerEvent(t *testing.T) {
	mgr := NewExternalHookManager(map[string]interface{}{
		"on_error": []interface{}{
			map[string]interface{}{
				"command": []interface{}{"true"},
				"await":   true,
				"timeout": float64(5000),
			},
			map[string]interface{}{
				"command": []interface{}{"true"},
				"await":   true,
				"timeout": float64(5000),
			},
		},
	})

	err := mgr.Fire("on_error", map[string]interface{}{"msg": "test"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// --- Context Inject Tests ---

func TestSDK_FireContextInject(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookContextInject, func(ctx *Context, payload interface{}) (interface{}, error) {
		return []ContextEntry{
			{Label: "custom-rules", Content: "rule 1\nrule 2"},
			{Label: "team-config", Content: "team: alpha"},
		}, nil
	})

	entries := sdk.FireContextInject(testCtx(), ContextInjectInfo{
		WorkingDirectory: "/project",
		DiscoveredPaths:  []string{"/project/ION.md"},
	})

	if len(entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(entries))
	}
	if entries[0].Label != "custom-rules" {
		t.Errorf("expected label 'custom-rules', got %q", entries[0].Label)
	}
	if entries[1].Content != "team: alpha" {
		t.Errorf("expected content 'team: alpha', got %q", entries[1].Content)
	}
}

func TestSDK_FireContextInject_MultipleHandlers(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookContextInject, func(ctx *Context, payload interface{}) (interface{}, error) {
		return ContextEntry{Label: "a", Content: "from handler 1"}, nil
	})
	sdk.On(HookContextInject, func(ctx *Context, payload interface{}) (interface{}, error) {
		return ContextEntry{Label: "b", Content: "from handler 2"}, nil
	})

	entries := sdk.FireContextInject(testCtx(), ContextInjectInfo{WorkingDirectory: "/p"})
	if len(entries) != 2 {
		t.Fatalf("expected 2 entries from 2 handlers, got %d", len(entries))
	}
}

// --- Capability Registry Tests ---

func TestSDK_RegisterCapability(t *testing.T) {
	sdk := NewSDK()

	sdk.RegisterCapability(Capability{
		ID:          "skill:deploy",
		Name:        "Deploy",
		Description: "Deploy the application",
		Mode:        CapabilityModeTool,
		InputSchema: map[string]interface{}{"type": "object"},
	})

	caps := sdk.Capabilities()
	if len(caps) != 1 {
		t.Fatalf("expected 1 capability, got %d", len(caps))
	}
	if caps[0].ID != "skill:deploy" {
		t.Errorf("expected ID 'skill:deploy', got %q", caps[0].ID)
	}
}

func TestSDK_UnregisterCapability(t *testing.T) {
	sdk := NewSDK()
	sdk.RegisterCapability(Capability{ID: "a", Name: "A", Mode: CapabilityModeTool})
	sdk.RegisterCapability(Capability{ID: "b", Name: "B", Mode: CapabilityModePrompt})

	sdk.UnregisterCapability("a")

	caps := sdk.Capabilities()
	if len(caps) != 1 {
		t.Fatalf("expected 1 capability after unregister, got %d", len(caps))
	}
	if caps[0].ID != "b" {
		t.Errorf("expected remaining cap ID 'b', got %q", caps[0].ID)
	}
}

func TestSDK_CapabilitiesByMode(t *testing.T) {
	sdk := NewSDK()
	sdk.RegisterCapability(Capability{ID: "tool1", Mode: CapabilityModeTool})
	sdk.RegisterCapability(Capability{ID: "prompt1", Mode: CapabilityModePrompt})
	sdk.RegisterCapability(Capability{ID: "both1", Mode: CapabilityModeTool | CapabilityModePrompt})

	toolCaps := sdk.CapabilitiesByMode(CapabilityModeTool)
	if len(toolCaps) != 2 {
		t.Errorf("expected 2 tool capabilities, got %d", len(toolCaps))
	}

	promptCaps := sdk.CapabilitiesByMode(CapabilityModePrompt)
	if len(promptCaps) != 2 {
		t.Errorf("expected 2 prompt capabilities, got %d", len(promptCaps))
	}
}

// --- Capability Match Tests ---

func TestSDK_FireCapabilityMatch(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookCapabilityMatch, func(ctx *Context, payload interface{}) (interface{}, error) {
		info := payload.(CapabilityMatchInfo)
		if strings.HasPrefix(info.Input, "/deploy") {
			return &CapabilityMatchResult{
				MatchedIDs: []string{"skill:deploy"},
				Args:       map[string]interface{}{"env": "prod"},
			}, nil
		}
		return nil, nil
	})

	result := sdk.FireCapabilityMatch(testCtx(), CapabilityMatchInfo{
		Input:        "/deploy prod",
		Capabilities: []string{"skill:deploy", "skill:test"},
	})

	if result == nil {
		t.Fatal("expected match result, got nil")
	}
	if len(result.MatchedIDs) != 1 || result.MatchedIDs[0] != "skill:deploy" {
		t.Errorf("unexpected matched IDs: %v", result.MatchedIDs)
	}
}

func TestSDK_FireCapabilityMatch_NoMatch(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookCapabilityMatch, func(ctx *Context, payload interface{}) (interface{}, error) {
		return nil, nil
	})

	result := sdk.FireCapabilityMatch(testCtx(), CapabilityMatchInfo{
		Input:        "hello",
		Capabilities: []string{"skill:deploy"},
	})

	if result != nil {
		t.Errorf("expected nil result for no match, got %+v", result)
	}
}

func TestSDK_FireCapabilityDiscover(t *testing.T) {
	sdk := NewSDK()

	sdk.On(HookCapabilityDiscover, func(ctx *Context, payload interface{}) (interface{}, error) {
		return []Capability{
			{ID: "ext:hello", Name: "Hello", Mode: CapabilityModePrompt, Prompt: "Say hello"},
		}, nil
	})

	caps := sdk.FireCapabilityDiscover(testCtx())
	if len(caps) != 1 {
		t.Fatalf("expected 1 discovered capability, got %d", len(caps))
	}
	if caps[0].ID != "ext:hello" {
		t.Errorf("expected ID 'ext:hello', got %q", caps[0].ID)
	}
}
