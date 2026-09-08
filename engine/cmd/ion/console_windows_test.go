//go:build windows

package main

import "testing"

// TestHideOwnConsole_ReportsAnOutcome asserts hideOwnConsole never errors and
// always names which of the three console outcomes occurred. The test binary
// may or may not have a console depending on how the runner invoked it, so
// the outcome is not pinned to one value — that it is one of the known set,
// and never empty, is what callers log.
func TestHideOwnConsole_ReportsAnOutcome(t *testing.T) {
	outcome, err := hideOwnConsole()
	if err != nil {
		t.Fatalf("hideOwnConsole() error = %v, want nil", err)
	}
	switch outcome {
	case consoleNone, consoleHidden, consoleNotOwnWindow:
	default:
		t.Errorf("hideOwnConsole() outcome = %q, want one of the known outcomes", outcome)
	}
}

// TestHideOwnConsole_Idempotent asserts a second call against an
// already-hidden or already-absent console is still a no-error no-op. The
// second call can no longer report consoleHidden: the window it just hid is
// not visible any more, which is exactly the state the ConPTY case starts in.
func TestHideOwnConsole_Idempotent(t *testing.T) {
	if _, err := hideOwnConsole(); err != nil {
		t.Fatalf("first call: %v", err)
	}
	outcome, err := hideOwnConsole()
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if outcome == consoleHidden {
		t.Errorf("second call reported %q; a window hidden by the first call is no longer visible", outcome)
	}
}
