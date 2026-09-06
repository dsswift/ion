package backend

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestGenerateSettingsJSON_MatcherGroupShape pins the structure the CLI actually
// reads. Each entry under "PreToolUse" is a matcher GROUP carrying a nested
// "hooks" array; commands placed directly on the group are silently ignored,
// because a group with no hooks means "run nothing" and that is not an error.
//
// This shipped wrong. The hook server listened on a port that never received a
// single request for the whole time it existed, so every permission decision on
// a delegated-CLI run went unconsulted, with nothing in any log to say so.
// Verified against claude 2.1.259 with an A/B probe under bypassPermissions: the
// nested shape delivers a PreToolUse payload, the flat shape delivers nothing.
//
// Revert-check: move "type"/"command" back onto the group and the nested lookup
// below fails.
func TestGenerateSettingsJSON_MatcherGroupShape(t *testing.T) {
	s, err := NewPermissionHookServer(nil)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	t.Cleanup(s.Close)

	var settings struct {
		Hooks struct {
			PreToolUse []struct {
				Matcher string `json:"matcher"`
				Hooks   []struct {
					Type    string `json:"type"`
					Command string `json:"command"`
				} `json:"hooks"`
			} `json:"PreToolUse"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(s.GenerateSettingsJSON("tok"), &settings); err != nil {
		t.Fatalf("unmarshal settings: %v", err)
	}

	groups := settings.Hooks.PreToolUse
	if len(groups) != 1 {
		t.Fatalf("PreToolUse groups = %d, want 1", len(groups))
	}
	// "*" and not a single tool name: this server is the run's permission rail,
	// so a narrower matcher would exempt every unnamed tool from policy.
	if groups[0].Matcher != "*" {
		t.Errorf("matcher = %q, want \"*\"", groups[0].Matcher)
	}
	if len(groups[0].Hooks) != 1 {
		t.Fatalf("nested hooks = %d, want 1 — a group with no hooks runs nothing", len(groups[0].Hooks))
	}
	hook := groups[0].Hooks[0]
	if hook.Type != "command" {
		t.Errorf("hook type = %q, want command", hook.Type)
	}
	if !strings.Contains(hook.Command, s.URL("tok")) {
		t.Errorf("hook command does not post to this server's URL: %q", hook.Command)
	}
}
