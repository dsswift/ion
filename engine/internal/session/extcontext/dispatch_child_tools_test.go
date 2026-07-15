package extcontext

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// newHostWithTools builds an extension.Host whose SDK registry carries the
// given tool definitions, without spawning a subprocess. This exercises the
// same Host.Tools() surface wireChildExtensionTools reads in production.
func newHostWithTools(t *testing.T, defs ...extension.ToolDefinition) *extension.Host {
	t.Helper()
	h := extension.NewHost()
	for _, def := range defs {
		h.SDK().RegisterTool(def)
	}
	return h
}

// TestWireChildExtensionTools_WiresDefsAndRouter pins the fix for the
// dispatched-children-have-no-extension-tools gap: loadChildExtension loaded
// the child extension (hooks fired, persona composed) but its registered
// tools never reached the child RunConfig, so a dispatched lead's tool list
// was missing the harness's own dispatch tool — making the documented
// lead→specialist delegation chain physically impossible. On the unfixed
// code, ExternalTools and McpToolRouter stay nil and this test fails.
func TestWireChildExtensionTools_WiresDefsAndRouter(t *testing.T) {
	host := newHostWithTools(t,
		extension.ToolDefinition{
			Name:        "dispatch_agent",
			Description: "harness dispatch tool",
			Parameters:  map[string]interface{}{"type": "object"},
			Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
				return &types.ToolResult{Content: "dispatched-from-child"}, nil
			},
		},
		extension.ToolDefinition{
			Name:         "ops",
			Description:  "file ops",
			PlanModeSafe: true,
			Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
				return &types.ToolResult{Content: "ok"}, nil
			},
		},
	)

	cfg := &backend.RunConfig{}
	wireChildExtensionTools(noopSA{}, nil, host, cfg, 1, "disp-wire-test")

	if len(cfg.ExternalTools) != 2 {
		t.Fatalf("expected 2 ExternalTools, got %d", len(cfg.ExternalTools))
	}
	byName := map[string]types.LlmToolDef{}
	for _, td := range cfg.ExternalTools {
		byName[td.Name] = td
	}
	if _, ok := byName["dispatch_agent"]; !ok {
		t.Fatal("dispatch_agent missing from child ExternalTools — the delegation chain is broken")
	}
	if !byName["ops"].PlanModeSafe {
		t.Error("PlanModeSafe not carried through to LlmToolDef")
	}
	if byName["dispatch_agent"].Description != "harness dispatch tool" {
		t.Errorf("Description not carried through, got %q", byName["dispatch_agent"].Description)
	}

	if cfg.McpToolRouter == nil {
		t.Fatal("McpToolRouter not wired — child tool calls have no execution path")
	}

	// Route a call through the router and confirm it reaches the tool.
	result, err := cfg.McpToolRouter(context.Background(), "dispatch_agent", map[string]interface{}{"agent": "x"})
	if err != nil {
		t.Fatalf("router returned error: %v", err)
	}
	if result == nil || result.Content != "dispatched-from-child" {
		t.Fatalf("router did not execute the extension tool, got %+v", result)
	}
}

// TestWireChildExtensionTools_UnknownTool verifies the router surfaces a
// clean error for a tool name not registered on the child host.
func TestWireChildExtensionTools_UnknownTool(t *testing.T) {
	host := newHostWithTools(t, extension.ToolDefinition{
		Name: "only_tool",
		Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
			return &types.ToolResult{Content: "ok"}, nil
		},
	})

	cfg := &backend.RunConfig{}
	wireChildExtensionTools(noopSA{}, nil, host, cfg, 1, "disp-unknown-test")

	_, err := cfg.McpToolRouter(context.Background(), "missing_tool", nil)
	if err == nil {
		t.Fatal("expected error for unknown tool, got nil")
	}
	if !strings.Contains(err.Error(), "missing_tool") {
		t.Errorf("error should name the missing tool, got %q", err.Error())
	}
}

// TestWireChildExtensionTools_ToolError verifies an execute error is
// converted into an error ToolResult (matching the root-session router
// semantics in prompt_runconfig.go) rather than propagated as a router error.
func TestWireChildExtensionTools_ToolError(t *testing.T) {
	host := newHostWithTools(t, extension.ToolDefinition{
		Name: "failing_tool",
		Execute: func(params interface{}, ctx *extension.Context) (*types.ToolResult, error) {
			return nil, context.DeadlineExceeded
		},
	})

	cfg := &backend.RunConfig{}
	wireChildExtensionTools(noopSA{}, nil, host, cfg, 1, "disp-err-test")

	result, err := cfg.McpToolRouter(context.Background(), "failing_tool", nil)
	if err != nil {
		t.Fatalf("execute errors must surface as error ToolResults, not router errors: %v", err)
	}
	if result == nil || !result.IsError {
		t.Fatalf("expected IsError result, got %+v", result)
	}
}

// TestWireChildExtensionTools_NoTools verifies the no-op path: a child
// extension with zero registered tools leaves the RunConfig untouched.
func TestWireChildExtensionTools_NoTools(t *testing.T) {
	host := extension.NewHost()
	cfg := &backend.RunConfig{}
	wireChildExtensionTools(noopSA{}, nil, host, cfg, 1, "disp-none-test")

	if cfg.ExternalTools != nil {
		t.Errorf("expected nil ExternalTools for a toolless host, got %v", cfg.ExternalTools)
	}
	if cfg.McpToolRouter != nil {
		t.Error("expected nil McpToolRouter for a toolless host")
	}
}
