package types

import "testing"

func TestParseToolSearchMode(t *testing.T) {
	cases := []struct {
		in      string
		kind    ToolSearchKind
		percent int
		env     string
		set     bool
	}{
		{"", ToolSearchDefault, 0, "", false},
		{"on", ToolSearchOn, 0, "true", true},
		{"TRUE", ToolSearchOn, 0, "true", true},
		{"off", ToolSearchOff, 0, "false", true},
		{"auto", ToolSearchAuto, DefaultToolSearchPercent, "auto:10", true},
		{" auto:5 ", ToolSearchAuto, 5, "auto:5", true},
		{"auto:0", ToolSearchAuto, 0, "auto:0", true},
	}
	for _, c := range cases {
		got, err := ParseToolSearchMode(c.in)
		if err != nil {
			t.Fatalf("%q: %v", c.in, err)
		}
		if got.Kind != c.kind || got.Percent != c.percent {
			t.Errorf("%q: got %+v", c.in, got)
		}
		env, set := got.ClaudeCodeEnv()
		if env != c.env || set != c.set {
			t.Errorf("%q: env %q set %v", c.in, env, set)
		}
	}
	for _, bad := range []string{"sometimes", "auto:", "auto:101", "auto:-1", "auto:x"} {
		if _, err := ParseToolSearchMode(bad); err == nil {
			t.Errorf("%q should not parse", bad)
		}
	}
}
