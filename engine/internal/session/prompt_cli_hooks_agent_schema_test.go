package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/tools"
)

func TestAgentStatusToolSchemaIsReadOnlyAndOptionalFilter(t *testing.T) {
	def := tools.AgentStatusTool()
	if def.Name != tools.AgentStatusToolName {
		t.Fatalf("AgentStatus tool name = %q, want %q", def.Name, tools.AgentStatusToolName)
	}
	if tools.AgentStatusToolName != "AgentStatus" {
		t.Fatalf("AgentStatus canonical name changed to %q", tools.AgentStatusToolName)
	}
	if !def.PlanModeSafe {
		t.Fatal("AgentStatus must remain plan-mode safe")
	}
	properties, ok := def.InputSchema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("AgentStatus properties type = %T", def.InputSchema["properties"])
	}
	if _, ok := properties["dispatch_id"]; !ok {
		t.Fatal("AgentStatus schema missing optional dispatch_id")
	}
	if required, ok := def.InputSchema["required"]; ok && required != nil {
		t.Fatalf("AgentStatus unexpectedly requires input: %v", required)
	}
}

// TestAgentToolSchema_HasRequiredProperties pins the canonical Agent tool's
// input-schema shape so the CLI-backend MCP tool (registered as "ion_agent"
// in prompt_cli_hooks.go) does not silently lose a property when a future
// change touches tools.AgentTool().
//
// Why this test lives in session/ rather than tools/ — the consumer at risk
// is the MCP-tool registration in this package; if tools.AgentTool() drops
// (say) "model" from its properties map, the CLI backend's MCP wire
// description loses it too. Pinning the contract from the consumer's
// perspective surfaces the failure where it would actually break the
// ClaudeCodeBackend's user-facing behavior. Cross-tested with the existing
// session-package tests so a regression here also fails alongside any
// other CLI-backend regression in the same run.
func TestAgentToolSchema_HasRequiredProperties(t *testing.T) {
	def := tools.AgentTool()

	if def == nil {
		t.Fatal("tools.AgentTool() returned nil")
	}
	if def.Description == "" {
		t.Error("AgentTool: Description must be non-empty (the CLI backend forwards it verbatim as the MCP tool description)")
	}
	if def.InputSchema == nil {
		t.Fatal("AgentTool: InputSchema must be non-nil (the CLI backend's MCP tools/list request requires it)")
	}

	// The schema is a JSON-Schema-shaped map. Drill into properties and
	// the required array; both are part of the contract the CLI backend's
	// MCP tool inherits.
	props, ok := def.InputSchema["properties"].(map[string]any)
	if !ok {
		t.Fatalf("AgentTool.InputSchema.properties: expected map[string]any, got %T", def.InputSchema["properties"])
	}

	// Explicit wait field controls the only foreground path; omitted Agent calls
	// return dispatch stubs and receive automatic terminal delivery.
	if _, present := props["wait_for_completion"]; !present {
		t.Error("AgentTool.InputSchema.properties: missing wait_for_completion")
	}

	// The four properties the CLI-backend MCP tool depends on. The
	// previous hand-rolled schema in prompt_cli_hooks.go duplicated these
	// four; routing through tools.AgentTool() means dropping any of them
	// here breaks the CLI-backend MCP wire surface.
	want := []string{"prompt", "name", "description", "model"}
	for _, name := range want {
		if _, present := props[name]; !present {
			t.Errorf("AgentTool.InputSchema.properties: missing %q — adding/removing fields here is a contract change for ClaudeCodeBackend's MCP tool registration in prompt_cli_hooks.go", name)
		}
	}

	required, ok := def.InputSchema["required"].([]string)
	if !ok {
		t.Fatalf("AgentTool.InputSchema.required: expected []string, got %T", def.InputSchema["required"])
	}
	if len(required) != 1 || required[0] != "prompt" {
		t.Errorf("AgentTool.InputSchema.required: expected [\"prompt\"], got %v — the CLI-backend MCP tool inherits this required list verbatim", required)
	}
}
