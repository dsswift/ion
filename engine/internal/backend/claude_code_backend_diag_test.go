package backend

import (
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// makeRunForDiag creates a minimal claudeCodeRun with the spawn metadata fields
// populated, suitable for bareExitDiagnostic tests.
func makeRunForDiag(binaryPath string, spawnedAt time.Time) *claudeCodeRun {
	return &claudeCodeRun{
		requestID:  "test-req",
		binaryPath: binaryPath,
		spawnedAt:  spawnedAt,
	}
}

// makeCmdForDiag builds a fake exec.Cmd with Process.Pid set via an already-
// started (and immediately finished) process so the Pid field is readable.
func makeCmdForDiag(t *testing.T, args []string) *exec.Cmd {
	t.Helper()
	// exec.Cmd.Process is only populated after Start(); use a trivial real
	// command that exits immediately so we get a real PID.
	cmd := exec.Command("true") // /usr/bin/true exits 0 immediately
	cmd.Args = args             // override Args for our test scenario
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start 'true': %v", err)
	}
	// Wait so the process is reaped; Process.Pid is still set.
	_ = cmd.Wait()
	return cmd
}

// TestBareExitDiagnostic_ContainsCoreFields verifies that bareExitDiagnostic
// includes exit code, no-stderr marker, pid, elapsed, binary path, and model.
func TestBareExitDiagnostic_ContainsCoreFields(t *testing.T) {
	spawnedAt := time.Now().Add(-3 * time.Second)
	run := makeRunForDiag("/usr/local/bin/claude", spawnedAt)
	opts := types.RunOptions{Model: "claude-opus-4-5"}
	cmd := makeCmdForDiag(t, []string{"claude", "-p"})

	msg := bareExitDiagnostic(run, opts, 1, cmd)

	checks := []struct {
		name    string
		contain string
	}{
		{"exit code", "code 1"},
		{"no-stderr marker", "no stderr captured"},
		{"pid present", "pid="},
		{"elapsed present", "elapsed="},
		{"binary path", "/usr/local/bin/claude"},
		{"model", "claude-opus-4-5"},
		{"argv present", "argv="},
	}
	for _, c := range checks {
		if !strings.Contains(msg, c.contain) {
			t.Errorf("%s: %q not found in message:\n%s", c.name, c.contain, msg)
		}
	}
}

// TestBareExitDiagnostic_DefaultsWhenEmpty verifies fallback strings when
// binaryPath and model are empty.
func TestBareExitDiagnostic_DefaultsWhenEmpty(t *testing.T) {
	run := makeRunForDiag("", time.Time{}) // zero spawnedAt, empty path
	opts := types.RunOptions{}             // no model
	cmd := makeCmdForDiag(t, []string{"claude"})

	msg := bareExitDiagnostic(run, opts, 2, cmd)

	if !strings.Contains(msg, "<unknown>") {
		t.Errorf("expected <unknown> for empty binaryPath, got: %s", msg)
	}
	if !strings.Contains(msg, "<default>") {
		t.Errorf("expected <default> for empty model, got: %s", msg)
	}
}

// TestBareExitDiagnostic_CwdInherited verifies that a cmd with empty Dir
// shows "<inherited>" in the output.
func TestBareExitDiagnostic_CwdInherited(t *testing.T) {
	run := makeRunForDiag("/bin/claude", time.Now())
	opts := types.RunOptions{Model: "claude-haiku-3-5"}
	cmd := makeCmdForDiag(t, []string{"claude"})
	cmd.Dir = "" // explicitly empty

	msg := bareExitDiagnostic(run, opts, 1, cmd)

	if !strings.Contains(msg, "<inherited>") {
		t.Errorf("expected <inherited> cwd, got: %s", msg)
	}
}

// TestFormatRedactedArgv_MasksSystemPrompt verifies that --system-prompt and
// --append-system-prompt values are replaced with "<redacted len=N>".
func TestFormatRedactedArgv_MasksSystemPrompt(t *testing.T) {
	secretValue := "You are a helpful assistant with secret instructions."
	args := []string{
		"claude", "-p",
		"--system-prompt", secretValue,
		"--model", "claude-opus-4-5",
		"--append-system-prompt", "extra secret",
	}

	result := formatRedactedArgv(args)

	// Secret values must not appear.
	if strings.Contains(result, secretValue) {
		t.Errorf("system-prompt value leaked into argv: %s", result)
	}
	if strings.Contains(result, "extra secret") {
		t.Errorf("append-system-prompt value leaked into argv: %s", result)
	}

	// Redaction markers must appear with correct lengths.
	expectedSystemLen := fmt.Sprintf("<redacted len=%d>", len(secretValue))
	if !strings.Contains(result, expectedSystemLen) {
		t.Errorf("expected %q in result, got: %s", expectedSystemLen, result)
	}
	expected2 := fmt.Sprintf("<redacted len=%d>", len("extra secret"))
	if !strings.Contains(result, expected2) {
		t.Errorf("expected %q in result, got: %s", expected2, result)
	}

	// Non-sensitive flags must pass through verbatim.
	if !strings.Contains(result, "--model") {
		t.Errorf("--model flag missing from result: %s", result)
	}
	if !strings.Contains(result, "claude-opus-4-5") {
		t.Errorf("model value missing from result: %s", result)
	}
}

// TestFormatRedactedArgv_UserPromptNotInArgv documents that the user prompt is
// delivered over stdin and therefore never appears in argv. This test verifies
// that a realistic argv set (matching what runProcess builds) contains no user
// prompt content — the prompt is never put in args, so it cannot leak.
func TestFormatRedactedArgv_UserPromptNotInArgv(t *testing.T) {
	// Simulate the argv runProcess actually builds: no user prompt argument.
	args := []string{
		"claude", "-p",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-mode", "bypassPermissions",
		"--model", "claude-opus-4-5",
	}

	result := formatRedactedArgv(args)

	// The result should be unchanged (no sensitive flags present).
	joined := strings.Join(args, " ")
	if result != joined {
		t.Errorf("non-sensitive argv modified unexpectedly\nwant: %s\ngot:  %s", joined, result)
	}
}

// TestFormatRedactedArgv_FlagAtEnd verifies graceful handling when a sensitive
// flag appears at the end of argv with no following value (malformed, but must
// not panic or index out of bounds).
func TestFormatRedactedArgv_FlagAtEnd(t *testing.T) {
	args := []string{"claude", "--system-prompt"} // no value follows
	// Must not panic.
	result := formatRedactedArgv(args)
	if !strings.Contains(result, "--system-prompt") {
		t.Errorf("flag missing from result: %s", result)
	}
}
