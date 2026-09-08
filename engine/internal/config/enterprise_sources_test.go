package config

import (
	"os"
	"strings"
	"testing"
)

// TestWindowsPolicySources pins the security-relevant source list: HKCU is
// never in it. This asserts against both the windows-tagged file's list and
// the not-windows stub's mirrored list, so the assertion holds regardless of
// which platform runs the test.
func TestWindowsPolicySources(t *testing.T) {
	got := windowsPolicySources()
	want := []string{"programdata", "registry-hklm"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("source %d: got %q want %q", i, got[i], want[i])
		}
	}
	for _, s := range got {
		if strings.Contains(strings.ToUpper(s), "HKCU") || strings.Contains(strings.ToUpper(s), "CURRENT_USER") {
			t.Errorf("windowsPolicySources must never name a user-scoped source, got %q", s)
		}
	}
}

// TestEnterpriseWindowsSourceFileNeverNamesCurrentUser is a grep-style pin:
// the literal CURRENT_USER must never appear in the windows-tagged reader,
// because a user can write their own HKCU\Software\Policies and policy must
// not be self-authored. Run on every platform since it only reads source
// text.
func TestEnterpriseWindowsSourceFileNeverNamesCurrentUser(t *testing.T) {
	data, err := os.ReadFile("enterprise_windows.go")
	if err != nil {
		t.Fatalf("read enterprise_windows.go: %v", err)
	}
	if strings.Contains(string(data), "CURRENT_USER") {
		t.Error("enterprise_windows.go must never reference registry.CURRENT_USER in production code")
	}
}
