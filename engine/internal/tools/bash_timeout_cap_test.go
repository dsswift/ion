package tools

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// bash_timeout_cap_test.go pins the per-call `timeout` ceiling and the
// timed-out result message (bash.go).
//
// Before the ceiling existed the model's requested value passed straight to
// the backend: conversation 1785107715785-e4b5e9ec1ecb issued 700000ms and
// 5400000ms requests and both were honored. These tests assert on the value
// the BACKEND receives, which is the only place the clamp is observable.

func TestBashTimeout_ClampedToDefaultMaximum(t *testing.T) {
	cases := []struct {
		name      string
		requested float64
	}{
		{"eleven minutes", 700000},
		{"ninety minutes", 5400000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ops := &recordingOps{}
			installRecordingOps(t, ops)

			result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
				"command": "echo hi",
				"timeout": tc.requested,
			}, t.TempDir())
			if err != nil {
				t.Fatalf("ExecuteTool: %v", err)
			}
			if got := ops.lastOptions(t).Timeout; got != 600000*time.Millisecond {
				t.Errorf("backend received timeout %s, want 600000ms", got)
			}
			if !strings.Contains(result.Content, "clamped") {
				t.Errorf("result does not report the clamp; got %q", result.Content)
			}
			if !strings.Contains(result.Content, "run_in_background") {
				t.Errorf("clamp notice does not name the background alternative; got %q", result.Content)
			}
			if !strings.Contains(result.Content, "stub-ran") {
				t.Errorf("clamp notice replaced the command output; got %q", result.Content)
			}
		})
	}
}

func TestBashTimeout_UnderCeilingPassesThrough(t *testing.T) {
	ops := &recordingOps{}
	installRecordingOps(t, ops)

	result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "echo hi",
		"timeout": float64(30000),
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if got := ops.lastOptions(t).Timeout; got != 30*time.Second {
		t.Errorf("backend received timeout %s, want 30s", got)
	}
	if strings.Contains(result.Content, "clamped") {
		t.Errorf("unclamped call carries a clamp notice; got %q", result.Content)
	}
}

func TestBashTimeout_ConfiguredCeilingHonored(t *testing.T) {
	t.Run("lowered", func(t *testing.T) {
		ops := &recordingOps{}
		installRecordingOps(t, ops)

		ctx := types.WithTimeouts(context.Background(), &types.TimeoutsConfig{BashMaxMs: 5000})
		if _, err := ExecuteTool(ctx, "Bash", map[string]any{
			"command": "echo hi",
			"timeout": float64(60000),
		}, t.TempDir()); err != nil {
			t.Fatalf("ExecuteTool: %v", err)
		}
		if got := ops.lastOptions(t).Timeout; got != 5*time.Second {
			t.Errorf("backend received timeout %s, want 5s", got)
		}
	})

	t.Run("raised", func(t *testing.T) {
		ops := &recordingOps{}
		installRecordingOps(t, ops)

		ctx := types.WithTimeouts(context.Background(), &types.TimeoutsConfig{BashMaxMs: 5400000})
		if _, err := ExecuteTool(ctx, "Bash", map[string]any{
			"command": "echo hi",
			"timeout": float64(700000),
		}, t.TempDir()); err != nil {
			t.Fatalf("ExecuteTool: %v", err)
		}
		if got := ops.lastOptions(t).Timeout; got != 700000*time.Millisecond {
			t.Errorf("backend received timeout %s, want 700000ms (below the raised ceiling)", got)
		}
	})

	t.Run("disabled by negative", func(t *testing.T) {
		ops := &recordingOps{}
		installRecordingOps(t, ops)

		ctx := types.WithTimeouts(context.Background(), &types.TimeoutsConfig{BashMaxMs: -1})
		result, err := ExecuteTool(ctx, "Bash", map[string]any{
			"command": "echo hi",
			"timeout": float64(5400000),
		}, t.TempDir())
		if err != nil {
			t.Fatalf("ExecuteTool: %v", err)
		}
		if got := ops.lastOptions(t).Timeout; got != 5400000*time.Millisecond {
			t.Errorf("backend received timeout %s, want the unclamped 5400000ms", got)
		}
		if strings.Contains(result.Content, "clamped") {
			t.Errorf("ceiling-disabled call carries a clamp notice; got %q", result.Content)
		}
	})
}

// TestBashTimeout_DefaultAppliedWhenAbsent pins that omitting `timeout` still
// resolves through bashDefaultMs rather than being caught by the clamp path.
func TestBashTimeout_DefaultAppliedWhenAbsent(t *testing.T) {
	ops := &recordingOps{}
	installRecordingOps(t, ops)

	if _, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "echo hi",
	}, t.TempDir()); err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if got := ops.lastOptions(t).Timeout; got != 120*time.Second {
		t.Errorf("backend received timeout %s, want the 120s default", got)
	}
}

// TestBashTimeout_TimedOutResultNamesBackgroundPath pins the third defect: a
// deadline kill reported "signal: killed" and named neither the limit nor the
// mechanism that outlives it.
func TestBashTimeout_TimedOutResultNamesBackgroundPath(t *testing.T) {
	ops := &recordingOps{
		result: &ExecResult{TimedOut: true},
		err:    errors.New("signal: killed"),
	}
	installRecordingOps(t, ops)

	result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "make test-linux",
		"timeout": float64(30000),
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if !result.IsError {
		t.Fatal("timed-out command did not produce an error result")
	}
	for _, want := range []string{"30000ms", "run_in_background", "notify_on_complete"} {
		if !strings.Contains(result.Content, want) {
			t.Errorf("timeout message missing %q; got %q", want, result.Content)
		}
	}
	if strings.Contains(result.Content, "signal: killed") {
		t.Errorf("timeout message surfaces the raw wait error; got %q", result.Content)
	}
}

// TestBashTimeout_NonTimeoutErrorUnchanged pins that the timed-out branch does
// not swallow ordinary execution failures.
func TestBashTimeout_NonTimeoutErrorUnchanged(t *testing.T) {
	ops := &recordingOps{err: errors.New("fork/exec: permission denied")}
	installRecordingOps(t, ops)

	result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "echo hi",
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if !result.IsError {
		t.Fatal("expected an error result")
	}
	if !strings.Contains(result.Content, "permission denied") {
		t.Errorf("ordinary error was rewritten; got %q", result.Content)
	}
}
