package permissions

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestEngine_ConfiguredDangerousPatterns(t *testing.T) {
	patterns := []string{`terraform\s+destroy`}
	bash := func(cmd string) CheckInfo {
		return CheckInfo{Tool: "Bash", Input: map[string]interface{}{"command": cmd}}
	}
	allowAll := []types.PermissionRule{{Tool: "*", Decision: "allow"}}

	cases := []struct {
		name         string
		policy       types.PermissionPolicy
		cmd          string
		wantDecision string
		wantLayer    string
	}{
		{"ask mode asks even past an allow rule", types.PermissionPolicy{Mode: "ask", DangerousPatterns: patterns, Rules: allowAll}, "cd /tmp && terraform destroy", "ask", "dangerous_pattern"},
		{"ask mode keeps a deny rule's deny", types.PermissionPolicy{Mode: "ask", DangerousPatterns: patterns, Rules: []types.PermissionRule{{Tool: "Bash", Decision: "deny", CommandPatterns: []string{`terraform`}}}}, "terraform destroy", "deny", "explicit_rule"},
		{"deny mode blocks past an allow rule", types.PermissionPolicy{Mode: "deny", DangerousPatterns: patterns, Rules: allowAll}, "terraform destroy", "deny", "dangerous_pattern"},
		{"allow mode skips them", types.PermissionPolicy{Mode: "allow", DangerousPatterns: patterns}, "terraform destroy", "allow", "allow_mode"},
		{"non-matching command falls through", types.PermissionPolicy{Mode: "ask", DangerousPatterns: patterns, Rules: allowAll}, "terraform plan", "allow", "explicit_rule"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			policy := tc.policy
			got := NewEngine(&policy).Check(bash(tc.cmd))
			if got.Decision != tc.wantDecision || got.Layer != tc.wantLayer {
				t.Fatalf("want %s/%s, got %s/%s", tc.wantDecision, tc.wantLayer, got.Decision, got.Layer)
			}
		})
	}
}
