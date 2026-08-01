package types

// Tests for SecurityConfig.WorkspaceContainmentEnabled — the resolver behind
// the engine's workspace-containment off-switch.
//
// Default-ENABLED via nil pointer is the load-bearing decision of the
// feature: containment is safety mechanism, not an opt-in extra, so an absent
// config section, an absent field, and a nil receiver must all resolve to
// enabled, and ONLY an explicit false disables. A regression flipping the
// default to opt-in would pass every behavioral containment test (they
// construct their checkers directly), so the resolver is pinned here at its
// own seam.

import (
	"encoding/json"
	"testing"
)

func boolPtr(v bool) *bool { return &v }

func TestWorkspaceContainmentEnabled(t *testing.T) {
	cases := []struct {
		name string
		cfg  *SecurityConfig
		want bool
	}{
		// A consumer with no security section at all gets the protection.
		{name: "nil receiver resolves enabled", cfg: nil, want: true},
		// A security section that only sets other fields gets the protection.
		{name: "nil field resolves enabled", cfg: &SecurityConfig{}, want: true},
		// The one and only way to turn it off.
		{name: "explicit false disables", cfg: &SecurityConfig{WorkspaceContainment: boolPtr(false)}, want: false},
		// Explicit true is redundant but must not invert.
		{name: "explicit true stays enabled", cfg: &SecurityConfig{WorkspaceContainment: boolPtr(true)}, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.cfg.WorkspaceContainmentEnabled(); got != tc.want {
				t.Fatalf("WorkspaceContainmentEnabled() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestWorkspaceContainmentJSONKey pins the wire key end to end: the operator
// writes `security.workspaceContainment` in engine.json, and a struct-tag
// typo would silently strand the off-switch (the field would stay nil and the
// resolver would report enabled forever). Round-trips real config JSON
// through EngineRuntimeConfig, the type engine.json unmarshals into.
func TestWorkspaceContainmentJSONKey(t *testing.T) {
	cases := []struct {
		name string
		json string
		want bool
	}{
		{name: "absent security section", json: `{}`, want: true},
		{name: "empty security section", json: `{"security":{}}`, want: true},
		{name: "explicit false via wire key", json: `{"security":{"workspaceContainment":false}}`, want: false},
		{name: "explicit true via wire key", json: `{"security":{"workspaceContainment":true}}`, want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var cfg EngineRuntimeConfig
			if err := json.Unmarshal([]byte(tc.json), &cfg); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if got := cfg.Security.WorkspaceContainmentEnabled(); got != tc.want {
				t.Fatalf("resolved %v from %s, want %v", got, tc.json, tc.want)
			}
		})
	}
}
