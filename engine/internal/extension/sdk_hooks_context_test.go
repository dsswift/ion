package extension

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Ensure types import is used
var _ = types.ToolResult{}

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
