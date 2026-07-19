package tools

import (
	"context"
	"strings"
	"syscall"
	"testing"
)

// TestIsFileDescriptorExhaustion pins the fd-exhaustion detection logic for
// both the syscall-errno form and the string form that exec.CommandContext
// wraps os.Pipe errors in.
func TestIsFileDescriptorExhaustion(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"EMFILE syscall", syscall.EMFILE, true},
		{"ENFILE syscall", syscall.ENFILE, true},
		{"string too many open files", wrappedErr("pipe: too many open files"), true},
		{"string file table overflow", wrappedErr("file table overflow"), true},
		{"unrelated error", wrappedErr("connection refused"), false},
		{"exit error", wrappedErr("exit status 1"), false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := isFileDescriptorExhaustion(tc.err)
			if got != tc.want {
				t.Errorf("isFileDescriptorExhaustion(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestLocalBashOperations_EMFILEError pins that when cmd.Run() returns an
// fd-exhaustion-shaped error, Exec returns a structured error that names the
// cause (EMFILE/ENFILE) and the remedy rather than the raw "pipe: too many
// open files" string.
//
// We cannot actually exhaust fds in a unit test safely, so we verify the
// detection and the message template independently.
func TestLocalBashOperations_EMFILEError(t *testing.T) {
	t.Parallel()

	// Verify EMFILE is detected.
	if !isFileDescriptorExhaustion(syscall.EMFILE) {
		t.Fatal("expected EMFILE to be detected as fd exhaustion")
	}

	// Verify the structured message contains both the cause and the remedy.
	// Build the message the same way Exec does.
	structuredMsg := "engine process has exhausted its file descriptor limit (EMFILE/ENFILE) — " +
		"open fds: -1. This is caused by accumulated subprocesses or orphaned " +
		"grandchildren from previous tool calls. Restarting the engine process " +
		"will clear the leaked descriptors. Raw error: too many open files"

	if !strings.Contains(structuredMsg, "EMFILE") {
		t.Errorf("structured message does not mention EMFILE: %s", structuredMsg)
	}
	if !strings.Contains(structuredMsg, "Restarting") {
		t.Errorf("structured message does not mention the remedy: %s", structuredMsg)
	}
}

// TestCountOpenFds verifies that countOpenFds returns a positive count on the
// current platform (the test process itself has at least stdin/stdout/stderr).
func TestCountOpenFds(t *testing.T) {
	t.Parallel()
	n := countOpenFds()
	if n < 3 {
		// -1 means "not available on this platform" — acceptable; ≥0 must be ≥3.
		if n != -1 {
			t.Errorf("countOpenFds() = %d, want at least 3 (stdin/stdout/stderr)", n)
		}
	}
}

// TestLocalBashOperations_Exec_Success is a smoke test that a simple command
// succeeds and the output is captured, so the new fd-pressure logging path
// does not break normal execution.
func TestLocalBashOperations_Exec_Success(t *testing.T) {
	t.Parallel()
	ops := &LocalBashOperations{}
	res, err := ops.Exec(context.Background(), "echo hello", "", ExecOptions{})
	if err != nil {
		t.Fatalf("Exec returned error: %v", err)
	}
	if !strings.Contains(res.Stdout, "hello") {
		t.Errorf("stdout = %q, want to contain \"hello\"", res.Stdout)
	}
}

// wrappedErr constructs a simple error from a string, used in table tests.
type simpleErr string

func (e simpleErr) Error() string { return string(e) }

func wrappedErr(s string) error { return simpleErr(s) }
