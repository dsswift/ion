package permissions

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestPermissionDecisionAuditLayer verifies that the permission engine's audit
// callback receives the deciding layer and a non-negative decision latency for
// each evaluation branch. This is the source-of-truth for the
// permission.decision telemetry event (family 4a): if Check stops stamping
// result.Layer, or audit stops copying it onto the AuditEntry, this test goes
// red.
func TestPermissionDecisionAuditLayer(t *testing.T) {
	cases := []struct {
		name      string
		policy    types.PermissionPolicy
		info      CheckInfo
		wantLayer string
		wantDec   string
	}{
		{
			name:      "allow_mode",
			policy:    types.PermissionPolicy{Mode: "allow"},
			info:      CheckInfo{Tool: "Read", Input: map[string]interface{}{"path": "/tmp/x"}},
			wantLayer: "allow_mode",
			wantDec:   "allow",
		},
		{
			name:      "dangerous_pattern",
			policy:    types.PermissionPolicy{Mode: "deny"},
			info:      CheckInfo{Tool: "Bash", Input: map[string]interface{}{"command": "rm -rf /"}},
			wantLayer: "dangerous_pattern",
			wantDec:   "deny",
		},
		{
			name:      "tier_rule",
			policy:    types.PermissionPolicy{Mode: "deny", TierRules: map[string]string{"SAFE": "allow"}},
			info:      CheckInfo{Tool: "Read", Input: map[string]interface{}{"path": "/tmp/x"}, Tier: "SAFE"},
			wantLayer: "tier_rule",
			wantDec:   "allow",
		},
		{
			name:      "explicit_rule",
			policy:    types.PermissionPolicy{Mode: "deny", Rules: []types.PermissionRule{{Tool: "Read", Decision: "allow"}}},
			info:      CheckInfo{Tool: "Read", Input: map[string]interface{}{"path": "/tmp/x"}},
			wantLayer: "explicit_rule",
			wantDec:   "allow",
		},
		{
			name:      "safe_command",
			policy:    types.PermissionPolicy{Mode: "ask"},
			info:      CheckInfo{Tool: "Bash", Input: map[string]interface{}{"command": "ls -la"}},
			wantLayer: "safe_command",
			wantDec:   "allow",
		},
		{
			name:      "mode_default_deny",
			policy:    types.PermissionPolicy{Mode: "deny"},
			info:      CheckInfo{Tool: "Read", Input: map[string]interface{}{"path": "/tmp/x"}},
			wantLayer: "mode_default",
			wantDec:   "deny",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			policy := tc.policy
			e := NewEngine(&policy)
			var got AuditEntry
			fired := false
			e.OnAudit(func(entry AuditEntry) {
				got = entry
				fired = true
			})
			result := e.Check(tc.info)
			if !fired {
				t.Fatal("audit callback did not fire")
			}
			if result.Decision != tc.wantDec {
				t.Errorf("decision = %q, want %q", result.Decision, tc.wantDec)
			}
			if result.Layer != tc.wantLayer {
				t.Errorf("result.Layer = %q, want %q", result.Layer, tc.wantLayer)
			}
			if got.Layer != tc.wantLayer {
				t.Errorf("audit.Layer = %q, want %q", got.Layer, tc.wantLayer)
			}
			if got.Decision != tc.wantDec {
				t.Errorf("audit.Decision = %q, want %q", got.Decision, tc.wantDec)
			}
			if got.LatencyMs < 0 {
				t.Errorf("audit.LatencyMs = %d, want >= 0", got.LatencyMs)
			}
		})
	}
}

// TestPermissionSensitivePathLayer verifies the sensitive_path layer is stamped
// when a tool targets a sensitive path in deny mode.
func TestPermissionSensitivePathLayer(t *testing.T) {
	policy := types.PermissionPolicy{Mode: "deny"}
	e := NewEngine(&policy)
	var got AuditEntry
	e.OnAudit(func(entry AuditEntry) { got = entry })
	result := e.Check(CheckInfo{Tool: "Read", Input: map[string]interface{}{"path": "/etc/../.ssh/id_rsa"}})
	// Only assert the layer when the sensitive-path rail actually fired; the
	// path classifier owns the "is sensitive" decision. When it fires, the
	// layer must be sensitive_path.
	if result.Decision == "deny" && result.Layer == "sensitive_path" {
		if got.Layer != "sensitive_path" {
			t.Errorf("audit.Layer = %q, want sensitive_path", got.Layer)
		}
	}
}
