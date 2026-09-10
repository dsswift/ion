//go:build !windows

package cliprobe

import (
	"path/filepath"
	"testing"
)

func TestInstallCandidatesUnix(t *testing.T) {
	got := installCandidates("claude", func(string) string { return "" }, "/home/x")
	want := []string{
		"/usr/local/bin/claude",
		"/opt/homebrew/bin/claude",
		filepath.Join("/home/x", ".npm-global", "bin", "claude"),
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

func TestInstallCandidatesUnix_EmptyHome(t *testing.T) {
	got := installCandidates("claude", func(string) string { return "" }, "")
	if len(got) != 2 {
		t.Fatalf("expected 2 candidates with no home, got %v", got)
	}
}

func TestSearchDescriptionUnix(t *testing.T) {
	if got := searchDescription(); got != "standard install paths, $PATH, and login shell" {
		t.Errorf("unexpected description: %q", got)
	}
}

func TestToolchainCandidatesUnix(t *testing.T) {
	got := toolchainCandidates("node", func(string) string { return "" })
	want := []string{"/opt/homebrew/bin/node", "/usr/local/bin/node"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("got %v, want %v", got, want)
	}
}
