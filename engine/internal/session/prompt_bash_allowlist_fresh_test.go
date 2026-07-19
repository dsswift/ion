package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// writeGlobalEngineAllowlist writes ~/.ion/engine.json (under the test's
// isolated HOME) with the given plan-mode bash allowlist.
func writeGlobalEngineAllowlist(t *testing.T, home string, allowlist []string) {
	t.Helper()
	ionDir := filepath.Join(home, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := map[string]any{
		"limits": map[string]any{"planModeAllowedBashCommands": allowlist},
	}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(ionDir, "engine.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestDispatch_ResolvesBashAllowlistFreshFromEngineJSON is the "no reboot"
// regression test. The engine must read limits.planModeAllowedBashCommands
// FRESH from engine.json at each prompt dispatch, not from a value cached at
// daemon boot. We dispatch twice against the same session, rewriting
// engine.json between the two dispatches, and assert the second run's
// RunOptions reflect the NEW file contents.
//
// Revert proof: the previous implementation read m.config.Limits (the
// boot-cached value), so the second dispatch would still carry the first
// allowlist. This test goes red on that implementation.
func TestDispatch_ResolvesBashAllowlistFreshFromEngineJSON(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	workdir := t.TempDir() // no project .ion — global layer is authoritative

	// First allowlist on disk before boot.
	writeGlobalEngineAllowlist(t, home, []string{"gh"})

	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.SetConfig(&types.EngineRuntimeConfig{})
	// The boot config carries NO allowlist — the whole point is that the value
	// is resolved fresh from disk at dispatch, not from the boot cache.
	cfg := types.EngineConfig{ProfileID: "test", WorkingDirectory: workdir}
	if _, err := mgr.StartSession("fresh-allowlist", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	if err := mgr.SendPrompt("fresh-allowlist", "first turn", nil); err != nil {
		t.Fatalf("SendPrompt 1: %v", err)
	}
	first := latestStartedOpts(t, mb)
	if len(first.PlanModeAllowedBashCommands) != 1 || first.PlanModeAllowedBashCommands[0] != "gh" {
		t.Fatalf("first dispatch: expected [gh], got %v", first.PlanModeAllowedBashCommands)
	}

	// Complete the first run so the second prompt dispatches (rather than
	// enqueuing behind the still-"running" first run in the mock).
	firstRunID := mb.startedInOrder()[0]
	code := 0
	mgr.handleRunExit(firstRunID, &code, nil, "")

	// Operator edits engine.json mid-conversation — no daemon restart.
	writeGlobalEngineAllowlist(t, home, []string{"gh", "git log", "git diff"})

	if err := mgr.SendPrompt("fresh-allowlist", "second turn", nil); err != nil {
		t.Fatalf("SendPrompt 2: %v", err)
	}
	second := latestStartedOpts(t, mb)
	got := second.PlanModeAllowedBashCommands
	if len(got) != 3 || got[0] != "gh" || got[1] != "git log" || got[2] != "git diff" {
		t.Fatalf("second dispatch: expected fresh [gh, git log, git diff], got %v", got)
	}
}

// TestDispatch_SessionOverrideWinsOverEngineJSON pins that a session-scoped
// set_plan_mode override still takes precedence over the engine.json value.
// The engine.json read only fills when the client sent no override, preserving
// the published set_plan_mode.planModeAllowedBashCommands contract.
func TestDispatch_SessionOverrideWinsOverEngineJSON(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	workdir := t.TempDir()
	writeGlobalEngineAllowlist(t, home, []string{"gh"})

	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.SetConfig(&types.EngineRuntimeConfig{})
	cfg := types.EngineConfig{ProfileID: "test", WorkingDirectory: workdir}
	if _, err := mgr.StartSession("override-wins", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// Client sends a session-scoped override (as the desktop's set_plan_mode
	// wire command would). This must win over engine.json's [gh].
	mgr.SetPlanModeBashAllowlist("override-wins", []string{"git status", "kubectl get"})

	if err := mgr.SendPrompt("override-wins", "turn", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	opts := latestStartedOpts(t, mb)
	got := opts.PlanModeAllowedBashCommands
	if len(got) != 2 || got[0] != "git status" || got[1] != "kubectl get" {
		t.Fatalf("expected session override [git status, kubectl get] to win, got %v", got)
	}
}

// TestDispatch_NoAllowlistAnywhereBlocksBash pins the opinionless default: with
// no engine.json allowlist and no session override, the run carries an empty
// allowlist (Bash blocked in plan mode). No ['gh'] is fabricated.
func TestDispatch_NoAllowlistAnywhereBlocksBash(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	workdir := t.TempDir() // no engine.json at all

	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.SetConfig(&types.EngineRuntimeConfig{})
	cfg := types.EngineConfig{ProfileID: "test", WorkingDirectory: workdir}
	if _, err := mgr.StartSession("no-allowlist", cfg); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	if err := mgr.SendPrompt("no-allowlist", "turn", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}
	opts := latestStartedOpts(t, mb)
	if len(opts.PlanModeAllowedBashCommands) != 0 {
		t.Fatalf("expected empty allowlist (Bash blocked), got %v", opts.PlanModeAllowedBashCommands)
	}
}

// latestStartedOpts returns the most recently started run's RunOptions.
func latestStartedOpts(t *testing.T, mb *mockBackend) types.RunOptions {
	t.Helper()
	order := mb.startedInOrder()
	if len(order) == 0 {
		t.Fatal("no run started")
	}
	opts, ok := mb.getStarted(order[len(order)-1])
	if !ok {
		t.Fatal("latest started run not found")
	}
	return opts
}
