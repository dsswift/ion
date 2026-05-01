package extension

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Ensure types import is used
var _ = types.ToolResult{}

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

func TestSDK_FireBeforeAgentStart(t *testing.T) {
	sdk := NewSDK()
	var received AgentInfo
	sdk.On(HookBeforeAgentStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		received = payload.(AgentInfo)
		return BeforeAgentStartResult{SystemPrompt: "You are the Chief of Staff."}, nil
	})

	sysPrompt, err := sdk.FireBeforeAgentStart(testCtx(), AgentInfo{Name: "pre-agent"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if received.Name != "pre-agent" {
		t.Fatalf("expected pre-agent, got %q", received.Name)
	}
	if sysPrompt != "You are the Chief of Staff." {
		t.Fatalf("expected system prompt, got %q", sysPrompt)
	}
}

func TestSDK_FireBeforeAgentStart_MapResult(t *testing.T) {
	sdk := NewSDK()
	sdk.On(HookBeforeAgentStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		return map[string]interface{}{"systemPrompt": "From subprocess"}, nil
	})

	sysPrompt, err := sdk.FireBeforeAgentStart(testCtx(), AgentInfo{Name: "test"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if sysPrompt != "From subprocess" {
		t.Fatalf("expected 'From subprocess', got %q", sysPrompt)
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
