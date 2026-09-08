//go:build windows

package cliprobe

import (
	"path/filepath"
	"testing"
)

func fakeWindowsEnv(vals map[string]string) func(string) string {
	return func(k string) string { return vals[k] }
}

func TestInstallCandidatesWindows(t *testing.T) {
	env := fakeWindowsEnv(map[string]string{
		"APPDATA":       `C:\Users\x\AppData\Roaming`,
		"USERPROFILE":   `C:\Users\x`,
		"LOCALAPPDATA":  `C:\Users\x\AppData\Local`,
		"ProgramFiles":  `C:\Program Files`,
	})
	got := installCandidates("claude", env, "")
	want := []string{
		filepath.Join(`C:\Users\x\AppData\Roaming`, "npm", "claude.cmd"),
		filepath.Join(`C:\Users\x\AppData\Roaming`, "npm", "claude.exe"),
		filepath.Join(`C:\Users\x`, ".local", "bin", "claude.exe"),
		filepath.Join(`C:\Users\x\AppData\Local`, "Programs", "claude", "claude.exe"),
		filepath.Join(`C:\Program Files`, "claude", "claude.exe"),
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("candidate %d: got %q want %q", i, got[i], want[i])
		}
	}
}

func TestInstallCandidatesWindows_MissingEnv(t *testing.T) {
	got := installCandidates("claude", fakeWindowsEnv(nil), "")
	if len(got) != 0 {
		t.Errorf("expected no candidates with no env vars set, got %v", got)
	}
}

func TestSearchDescriptionWindows(t *testing.T) {
	got := searchDescription()
	if got == "" || got == "standard install paths, $PATH, and login shell" {
		t.Errorf("windows description should name windows paths, got %q", got)
	}
}

func TestToolchainCandidatesWindows(t *testing.T) {
	env := fakeWindowsEnv(map[string]string{
		"ProgramFiles": `C:\Program Files`,
		"APPDATA":      `C:\Users\x\AppData\Roaming`,
		"LOCALAPPDATA": `C:\Users\x\AppData\Local`,
	})
	got := toolchainCandidates("node", env)
	want := []string{
		filepath.Join(`C:\Program Files`, "nodejs", "node.exe"),
		filepath.Join(`C:\Users\x\AppData\Roaming`, "npm", "node.cmd"),
		filepath.Join(`C:\Users\x\AppData\Local`, "Programs", "nodejs", "node.exe"),
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("candidate %d: got %q want %q", i, got[i], want[i])
		}
	}
}
