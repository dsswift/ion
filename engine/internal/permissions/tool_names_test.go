package permissions

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestNormalizeToolName pins both halves of the rule: the engine's own bridge
// prefix is unwrapped, and nothing else is touched. The negative cases are the
// point — folding another MCP server's "Bash" into the engine's shell rails
// would inspect a tool whose input schema we do not know.
func TestNormalizeToolName(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"Bash", "Bash"},
		{"mcp__ion-extensions__Bash", "Bash"},
		{"mcp__ion-extensions__TaskGet", "TaskGet"},
		{"mcp__other-server__Bash", "mcp__other-server__Bash"},
		{"mcp__ion-extensions", "mcp__ion-extensions"},
		{"", ""},
	}
	for _, c := range cases {
		if got := NormalizeToolName(c.in); got != c.want {
			t.Errorf("NormalizeToolName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestCheck_UnwrapsBridgedBashForDangerousPatterns is the regression test for
// the rail that matters most: a destructive command run through the engine's
// bridged Bash must hit the dangerous-pattern rail exactly as the bare name
// does. Revert-check: restoring the literal `info.Tool == "Bash"` comparisons
// makes the bridged call skip the rail and fall through to the mode default,
// which for "ask" mode is a prompt rather than a deny.
func TestCheck_UnwrapsBridgedBashForDangerousPatterns(t *testing.T) {
	e := NewEngine(&types.PermissionPolicy{Mode: "ask"})

	bare := e.Check(CheckInfo{Tool: "Bash", Input: map[string]any{"command": "rm -rf /"}})
	bridged := e.Check(CheckInfo{Tool: EngineMcpToolPrefix + "Bash", Input: map[string]any{"command": "rm -rf /"}})

	if bare.Decision != bridged.Decision || bare.Layer != bridged.Layer {
		t.Fatalf("bridged Bash decided differently: bare=%s/%s bridged=%s/%s",
			bare.Decision, bare.Layer, bridged.Decision, bridged.Layer)
	}
	if bridged.Layer != "dangerous_pattern" {
		t.Fatalf("bridged layer = %q, want dangerous_pattern", bridged.Layer)
	}
}

// TestCheck_UnwrapsBridgedNameForExplicitRules pins that an operator's rule
// written against the bare tool name covers the bridged call too. Without the
// unwrap, a `Bash` rule silently applied to API conversations only.
func TestCheck_UnwrapsBridgedNameForExplicitRules(t *testing.T) {
	e := NewEngine(&types.PermissionPolicy{
		Mode:  "deny",
		Rules: []types.PermissionRule{{Tool: "Bash", Decision: "allow"}},
	})

	got := e.Check(CheckInfo{Tool: EngineMcpToolPrefix + "Bash", Input: map[string]any{"command": "make build"}})
	if got.Decision != "allow" {
		t.Fatalf("decision = %q (layer %q), want allow from the bare-name rule", got.Decision, got.Layer)
	}
}
