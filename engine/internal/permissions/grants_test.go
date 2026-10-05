package permissions

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func askPolicy() *types.PermissionPolicy { return &types.PermissionPolicy{Mode: "ask"} }

func TestCheck_GrantSettlesAsk(t *testing.T) {
	e := NewEngine(askPolicy())
	info := CheckInfo{Tool: "Bash", Input: map[string]interface{}{"command": "git commit -m x"}}

	if got := e.Check(info); got.Decision != "ask" {
		t.Fatalf("baseline should ask, got %s", got.Decision)
	}

	info.Grants = []types.PermissionRule{{Tool: "Bash", Decision: "allow", CommandPatterns: []string{"git commit *"}}}
	got := e.Check(info)
	if got.Decision != "allow" || got.Layer != "skill_grant" {
		t.Fatalf("grant should settle ask as allow/skill_grant, got %s/%s", got.Decision, got.Layer)
	}
}

func TestCheck_GrantNeverOverridesDeny(t *testing.T) {
	e := NewEngine(&types.PermissionPolicy{Mode: "ask", Rules: []types.PermissionRule{{Tool: "Bash", Decision: "deny", CommandPatterns: []string{"git push*"}}}})
	info := CheckInfo{
		Tool:   "Bash",
		Input:  map[string]interface{}{"command": "git push"},
		Grants: []types.PermissionRule{{Tool: "Bash", Decision: "allow"}},
	}
	if got := e.Check(info); got.Decision != "deny" {
		t.Fatalf("a grant must not override deny, got %s", got.Decision)
	}
}

func TestCheck_GrantMustMatchPattern(t *testing.T) {
	e := NewEngine(askPolicy())
	info := CheckInfo{
		Tool:   "Bash",
		Input:  map[string]interface{}{"command": "deploy-thing --now"},
		Grants: []types.PermissionRule{{Tool: "Bash", Decision: "allow", CommandPatterns: []string{"git *"}}},
	}
	if got := e.Check(info); got.Decision != "ask" {
		t.Fatalf("non-matching grant must leave ask, got %s", got.Decision)
	}
}
