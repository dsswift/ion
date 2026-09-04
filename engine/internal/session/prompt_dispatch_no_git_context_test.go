package session

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

// TestSendPrompt_DispatchCarriesNoRepositoryState pins that the engine injects
// no git state into a dispatch.
//
// The engine used to resolve `git status` / `git log` on every prompt and hand
// the formatted block to the backend, which re-sent it on every turn of the run
// wrapped in text that claimed it described the current turn. It did not: the
// block was resolved once, at dispatch, so every commit the model made during
// the run left it describing a repository state that no longer existed. Models
// read the trailing block as a fresh instruction, disputed it against their own
// `git status` output, and looped.
//
// Git state now reaches a conversation only through what the operator or a
// harness chooses to send. This test marshals the dispatched RunOptions whole,
// so a revert that re-adds any repository-state field to the run fails here
// rather than shipping.
func TestSendPrompt_DispatchCarriesNoRepositoryState(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init"},
		{"-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "--allow-empty", "-m", "seed"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Skipf("git unavailable for fixture repo: %v: %s", err, out)
		}
	}

	mb := newMockBackend()
	mgr := NewManager(mb)
	cfg := defaultConfig()
	cfg.WorkingDirectory = dir
	if _, err := mgr.StartSession("git-repo-session", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if err := mgr.SendPrompt("git-repo-session", "hello", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	mb.mu.Lock()
	defer mb.mu.Unlock()
	if len(mb.started) == 0 {
		t.Fatal("backend never received a run")
	}
	for id, opts := range mb.started {
		encoded, err := json.Marshal(opts)
		if err != nil {
			t.Fatalf("marshal RunOptions for run %s: %v", id, err)
		}
		for _, forbidden := range []string{"# Git Context", "Current repository state"} {
			if strings.Contains(string(encoded), forbidden) {
				t.Errorf("run %s carries engine-injected repository state %q:\n%s", id, forbidden, encoded)
			}
		}
	}
}
