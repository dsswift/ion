package config

import (
	"reflect"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestEnforceEnterprise_Permissions pins the enterprise permission seal and
// that sealing an already sealed config changes nothing further.
func TestEnforceEnterprise_Permissions(t *testing.T) {
	enterprise := &types.EnterpriseConfig{Permissions: &types.PermissionPolicy{
		Mode:          "ask",
		Rules:         []types.PermissionRule{{Tool: "Bash", Decision: "deny", CommandPatterns: []string{"rm *"}}},
		ReadOnlyPaths: []string{"/etc"},
	}}

	t.Run("no user policy", func(t *testing.T) {
		got := EnforceEnterprise(DefaultConfig(), enterprise)
		if got.Permissions == nil || got.Permissions.Mode != "ask" || len(got.Permissions.Rules) != 1 {
			t.Fatalf("permissions = %+v", got.Permissions)
		}
	})

	t.Run("user allow cannot weaken; user deny stands", func(t *testing.T) {
		user := DefaultConfig()
		user.Permissions = &types.PermissionPolicy{Mode: "allow", Rules: []types.PermissionRule{{Tool: "Write", Decision: "allow"}}, ReadOnlyPaths: []string{"/home"}}
		got := EnforceEnterprise(user, enterprise)
		if got.Permissions.Mode != "ask" {
			t.Errorf("mode = %q, want ask", got.Permissions.Mode)
		}
		if len(got.Permissions.Rules) != 2 || got.Permissions.Rules[0].Tool != "Bash" {
			t.Errorf("enterprise rules must come first: %+v", got.Permissions.Rules)
		}
		if !reflect.DeepEqual(got.Permissions.ReadOnlyPaths, []string{"/home", "/etc"}) {
			t.Errorf("readOnlyPaths = %v", got.Permissions.ReadOnlyPaths)
		}
		if user.Permissions.Mode != "allow" || len(user.Permissions.Rules) != 1 {
			t.Error("EnforceEnterprise mutated the user policy")
		}

		again := EnforceEnterprise(got, enterprise)
		if !reflect.DeepEqual(again.Permissions, got.Permissions) {
			t.Errorf("sealing twice changed the policy: %+v vs %+v", again.Permissions, got.Permissions)
		}

		user.Permissions.Mode = "deny"
		if got := EnforceEnterprise(user, enterprise); got.Permissions.Mode != "deny" {
			t.Errorf("a stricter user mode must stand, got %q", got.Permissions.Mode)
		}
	})
}
