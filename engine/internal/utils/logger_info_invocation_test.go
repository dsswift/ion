package utils

import (
	"os"
	"path/filepath"
	"testing"
)

// Regression tests for the info-invocation log suppression.
//
// The defect: provider registration in internal/providers.init() logs once per
// provider, and the logger initializes lazily on that first call. Because an
// imported package is fully initialized before the importing package's init()
// runs, the log file was created and ~4.5 KB of provider-registration lines
// appended BEFORE main() ever chose a command. So `ion version` — which
// extension build tooling calls on every build — wrote kilobytes into the
// operator's live engine.jsonl and consumed rotation budget belonging to the
// daemon's real output.
//
// The invariant: a process started only to answer a question about the binary
// writes no operational log. The serve path is unaffected.

func TestInfoOnlyInvocationRecognizesQuestionSpellings(t *testing.T) {
	saved := os.Args
	t.Cleanup(func() { os.Args = saved })

	for _, tc := range []struct {
		argv []string
		want bool
	}{
		{[]string{"ion", "version"}, true},
		{[]string{"ion", "--version"}, true},
		{[]string{"ion", "-v"}, true},
		{[]string{"ion", "help"}, true},
		{[]string{"ion", "--help"}, true},
		{[]string{"ion", "-h"}, true},

		// The daemon and every real command must NOT be suppressed.
		{[]string{"ion"}, false},
		{[]string{"ion", "serve"}, false},
		{[]string{"ion", "--model", "claude-opus-5"}, false},
		{[]string{"ion", "status"}, false},
		{[]string{"ion", "prompt", "hello"}, false},

		// A later --version is an option to a real command, not a question
		// about the binary. Suppressing here would silence a genuine run.
		{[]string{"ion", "plugin", "install", "--version", "1.2.3"}, false},
	} {
		os.Args = tc.argv
		if got := infoOnlyInvocation(); got != tc.want {
			t.Errorf("infoOnlyInvocation(%v) = %v, want %v", tc.argv[1:], got, tc.want)
		}
	}
}

// TestInfoInvocationWritesNoLogFile is the end-to-end assertion: with argv set
// to a version query, initLogger must resolve to the discard sink and logging
// must leave the log directory untouched.
//
// HOME is redirected to a temp dir so the test can prove absence of a file
// rather than inferring it, and so it can never touch the operator's ~/.ion.
func TestInfoInvocationWritesNoLogFile(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	savedArgs := os.Args
	t.Cleanup(func() { os.Args = savedArgs })
	os.Args = []string{"ion", "--version"}

	resetLoggerForTest(t, tmp)

	LogWithFields(LevelInfo, "probe", "this must not be written", map[string]any{"k": "v"})
	Log("probe", "nor this")

	path := filepath.Join(tmp, "engine.jsonl")
	if info, err := os.Stat(path); err == nil {
		t.Fatalf("info invocation wrote %d bytes to %s; it must write nothing", info.Size(), path)
	}
}

// TestServeInvocationStillLogs pins that the suppression is scoped. Narrowing
// it wrongly would silence the daemon, which is a far worse defect than the
// noise it was written to remove: the engine is headless, so its log is the
// only observability surface it has.
func TestServeInvocationStillLogs(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("HOME", tmp)

	savedArgs := os.Args
	t.Cleanup(func() { os.Args = savedArgs })
	os.Args = []string{"ion", "serve"}

	resetLoggerForTest(t, tmp)

	LogWithFields(LevelInfo, "probe", "the daemon must still log", map[string]any{"k": "v"})

	path := filepath.Join(tmp, "engine.jsonl")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("serve invocation wrote no log file at %s: %v", path, err)
	}
	if info.Size() == 0 {
		t.Fatal("serve invocation created an empty log file; the daemon's output was suppressed")
	}
}
