package plugins

import "testing"

func TestParseHookOutput_PlainText(t *testing.T) {
	out := ParseHookOutput("CAVEMAN MODE ACTIVE\n\nDrop articles.")
	want := "CAVEMAN MODE ACTIVE\n\nDrop articles."
	if out != want {
		t.Errorf("got %q, want %q", out, want)
	}
}

func TestParseHookOutput_Empty(t *testing.T) {
	if out := ParseHookOutput(""); out != "" {
		t.Errorf("got %q, want empty", out)
	}
	if out := ParseHookOutput("   \n  "); out != "" {
		t.Errorf("got %q, want empty for whitespace", out)
	}
}

func TestParseHookOutput_JSONHookSpecificOutput(t *testing.T) {
	raw := `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"CAVEMAN MODE ACTIVE (full)."}}`
	out := ParseHookOutput(raw)
	want := "CAVEMAN MODE ACTIVE (full)."
	if out != want {
		t.Errorf("got %q, want %q", out, want)
	}
}

func TestParseHookOutput_BlockDecision(t *testing.T) {
	raw := `{"decision":"block","reason":"something"}`
	out := ParseHookOutput(raw)
	if out != "" {
		t.Errorf("block decision should return empty, got %q", out)
	}
}

func TestParseHookOutput_JSONNoContext(t *testing.T) {
	raw := `{"hookSpecificOutput":{"hookEventName":"SessionStart"}}`
	out := ParseHookOutput(raw)
	if out != "" {
		t.Errorf("missing additionalContext should return empty, got %q", out)
	}
}

func TestSplitCommand(t *testing.T) {
	tests := []struct {
		input string
		want  []string
	}{
		{"node foo.js", []string{"node", "foo.js"}},
		{`node "path with spaces/foo.js"`, []string{"node", "path with spaces/foo.js"}},
		{"node", []string{"node"}},
		{"", nil},
	}
	for _, tc := range tests {
		got := splitCommand(tc.input)
		if len(got) != len(tc.want) {
			t.Errorf("splitCommand(%q) = %v, want %v", tc.input, got, tc.want)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("splitCommand(%q)[%d] = %q, want %q", tc.input, i, got[i], tc.want[i])
			}
		}
	}
}
