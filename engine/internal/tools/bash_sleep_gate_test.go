package tools

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// bash_sleep_gate_test.go pins the leading-`sleep` refusal (bash_sleep_gate.go).
//
// The gate exists because the park/wake mechanism (ADR-023) was defeated in
// production by a model that started a build with notify_on_complete and then
// slept in the foreground anyway. The tests below pin BOTH directions: the
// blocking shapes are refused (and not executed), and every ambiguous shape
// still runs, because a false positive here has no workaround.

// recordingOps is a BashOperations stub that records every invocation. It is
// how the "blocked" tests prove no process was spawned — asserting only on the
// message would pass against a gate that logs a refusal and executes anyway.
type recordingOps struct {
	mu       sync.Mutex
	calls    []ExecOptions
	commands []string
	result   *ExecResult
	err      error
}

func (r *recordingOps) Exec(_ context.Context, command, _ string, opts ExecOptions) (*ExecResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, opts)
	r.commands = append(r.commands, command)
	if r.result != nil || r.err != nil {
		return r.result, r.err
	}
	return &ExecResult{Stdout: "stub-ran"}, nil
}

func (r *recordingOps) callCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func (r *recordingOps) lastOptions(t *testing.T) ExecOptions {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.calls) == 0 {
		t.Fatal("backend was never invoked")
	}
	return r.calls[len(r.calls)-1]
}

// installRecordingOps swaps in the stub backend for the duration of a test.
func installRecordingOps(t *testing.T, ops *recordingOps) {
	t.Helper()
	prev := GetBashOperations()
	SetBashOperations(ops)
	t.Cleanup(func() { SetBashOperations(prev) })
}

func TestDetectBlockingSleep_BlockedShapes(t *testing.T) {
	threshold := 2 * time.Second
	cases := []struct {
		command  string
		wantSecs int
	}{
		// The exact strings from conversation 1785107715785-e4b5e9ec1ecb.
		{"sleep 600; tail -20 /Users/josh/.ion/tasks/bash-1614901066.out", 600},
		{"sleep 240; tail -5 /Users/josh/.ion/tasks/bash-1614901066.out", 240},
		{"sleep 600", 600},
		{"sleep 5 && make test", 5},
		{"sleep 30 | tee log", 30},
		{"sleep 10 || echo done", 10},
		{"  sleep 120  ; echo hi", 120},
		{"sleep\t60; echo hi", 60},
		{"sleep 2", 2}, // exactly at the threshold
	}
	for _, tc := range cases {
		secs, blocked := detectBlockingSleep(tc.command, threshold)
		if !blocked {
			t.Errorf("detectBlockingSleep(%q) = not blocked, want blocked", tc.command)
			continue
		}
		if secs != tc.wantSecs {
			t.Errorf("detectBlockingSleep(%q) seconds = %d, want %d", tc.command, secs, tc.wantSecs)
		}
	}
}

func TestDetectBlockingSleep_AllowedShapes(t *testing.T) {
	threshold := 2 * time.Second
	cases := []string{
		"sleep 1",                      // below threshold: pacing
		"sleep 0.5",                    // fractional: pacing
		"sleep 1.5",                    // fractional above threshold: still pacing
		"foo | sleep 5",                // not the head
		"make build && sleep 5",        // not the head
		`bash -c "sleep 30"`,           // nested shell
		"while true; do sleep 5; done", // loop body
		`echo "sleep 600"`,             // quoted literal
		"sleep",                        // no duration
		"sleeper 600",                  // different command
		"sleep 600s",                   // not a bare integer
		"env sleep 600",                // not the head token
		"./sleep 600",                  // different binary
		"go test ./... -timeout 600s",  // unrelated
		"",                             // empty
	}
	for _, cmd := range cases {
		if _, blocked := detectBlockingSleep(cmd, threshold); blocked {
			t.Errorf("detectBlockingSleep(%q) = blocked, want allowed", cmd)
		}
	}
}

// TestDetectBlockingSleep_ThresholdHonored pins that the threshold is the
// decision boundary, not a hardcoded constant.
func TestDetectBlockingSleep_ThresholdHonored(t *testing.T) {
	if _, blocked := detectBlockingSleep("sleep 3", 2*time.Second); !blocked {
		t.Error("sleep 3 at 2s threshold = allowed, want blocked")
	}
	if _, blocked := detectBlockingSleep("sleep 3", 5*time.Second); blocked {
		t.Error("sleep 3 at 5s threshold = blocked, want allowed")
	}
}

func TestLeadingCommandSegment(t *testing.T) {
	cases := map[string]string{
		"sleep 600; tail f":  "sleep 600",
		"sleep 5 && make":    "sleep 5",
		"sleep 5 || echo hi": "sleep 5",
		"sleep 5 | tee log":  "sleep 5",
		"  echo hi  ":        "echo hi",
		"echo hi":            "echo hi",
	}
	for in, want := range cases {
		if got := leadingCommandSegment(in); got != want {
			t.Errorf("leadingCommandSegment(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestBashSleepGate_BlockedCommandNeverExecutes is the core end-to-end pin: a
// blocked call returns an error naming the background path AND never reaches
// the backend.
func TestBashSleepGate_BlockedCommandNeverExecutes(t *testing.T) {
	ops := &recordingOps{}
	installRecordingOps(t, ops)

	result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "sleep 600; tail -20 /tmp/out",
		"timeout": float64(700000),
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if !result.IsError {
		t.Fatalf("expected IsError for a blocked sleep; got content %q", result.Content)
	}
	if ops.callCount() != 0 {
		t.Fatalf("backend was invoked %d times for a blocked command; want 0", ops.callCount())
	}
	for _, want := range []string{"run_in_background", "notify_on_complete", "sleep 600", "Poll"} {
		if !strings.Contains(result.Content, want) {
			t.Errorf("refusal message missing %q; got %q", want, result.Content)
		}
	}
}

// TestBashSleepGate_AllowedCommandExecutes pins the pass-through branch.
func TestBashSleepGate_AllowedCommandExecutes(t *testing.T) {
	ops := &recordingOps{}
	installRecordingOps(t, ops)

	result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command": "sleep 1",
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("sub-threshold sleep was refused: %q", result.Content)
	}
	if ops.callCount() != 1 {
		t.Fatalf("backend invoked %d times, want 1", ops.callCount())
	}
}

// TestBashSleepGate_DisabledByNegativeThreshold pins the operator opt-out.
func TestBashSleepGate_DisabledByNegativeThreshold(t *testing.T) {
	ops := &recordingOps{}
	installRecordingOps(t, ops)

	ctx := types.WithTimeouts(context.Background(), &types.TimeoutsConfig{BashBlockingSleepMs: -1})
	result, err := ExecuteTool(ctx, "Bash", map[string]any{
		"command": "sleep 600",
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("gate fired despite being disabled: %q", result.Content)
	}
	if ops.callCount() != 1 {
		t.Fatalf("backend invoked %d times, want 1", ops.callCount())
	}
}

// TestBashSleepGate_ConfiguredThresholdHonored pins that engine.json's
// threshold reaches the gate through the context, not just the default.
func TestBashSleepGate_ConfiguredThresholdHonored(t *testing.T) {
	ops := &recordingOps{}
	installRecordingOps(t, ops)

	ctx := types.WithTimeouts(context.Background(), &types.TimeoutsConfig{BashBlockingSleepMs: 60000})
	result, err := ExecuteTool(ctx, "Bash", map[string]any{
		"command": "sleep 30",
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("sleep 30 refused under a 60s threshold: %q", result.Content)
	}
	if ops.callCount() != 1 {
		t.Fatalf("backend invoked %d times, want 1", ops.callCount())
	}
}

// TestBashSleepGate_RefusesBareBackgroundSleep pins that a bare background
// sleep cannot become a self-addressed wake loop.
func TestBashSleepGate_RefusesBareBackgroundSleep(t *testing.T) {
	clearBashTasks(t)

	result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command":           "sleep 600",
		"run_in_background": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if !result.IsError {
		t.Fatalf("bare background sleep was allowed: %q", result.Content)
	}
	if !strings.Contains(result.Content, "Poll") {
		t.Errorf("background refusal does not name Poll: %q", result.Content)
	}
}

// TestBlockingSleepMessage_NamesReachableProgressPath pins that the refusal
// points at TaskGet only when the Task tools are actually registered (they are
// harness opt-in — see optional.go).
func TestBlockingSleepMessage_NamesReachableProgressPath(t *testing.T) {
	withTasks := blockingSleepMessage(600, 2*time.Second, false, true)
	if !strings.Contains(withTasks, "TaskGet") {
		t.Errorf("message with Task tools registered omits TaskGet: %q", withTasks)
	}
	withoutTasks := blockingSleepMessage(600, 2*time.Second, false, false)
	if strings.Contains(withoutTasks, "TaskGet") {
		t.Errorf("message names TaskGet when the tool is not registered: %q", withoutTasks)
	}
	if !strings.Contains(withoutTasks, "output file") {
		t.Errorf("message without Task tools omits the output-file path: %q", withoutTasks)
	}
}

// TestBashDescription_NamesSleepMechanics guards the tool description in both
// directions (ADR-017): the refusal is a mechanic the model must know about to
// call the tool correctly, but the description must not editorialize about
// workflow.
func TestBashDescription_NamesSleepMechanics(t *testing.T) {
	def := BashTool()
	for _, phrase := range []string{"sleep", "run_in_background"} {
		if !strings.Contains(def.Description, phrase) {
			t.Errorf("Bash description missing mechanic %q; got %q", phrase, def.Description)
		}
	}
	props, _ := def.InputSchema["properties"].(map[string]any)
	timeoutProp, _ := props["timeout"].(map[string]any)
	timeoutDesc, _ := timeoutProp["description"].(string)
	if !strings.Contains(timeoutDesc, "clamped") {
		t.Errorf("timeout schema description does not mention clamping; got %q", timeoutDesc)
	}
	notifyProp, _ := props["notify_on_complete"].(map[string]any)
	notifyDesc, _ := notifyProp["description"].(string)
	for _, phrase := range []string{"only remaining work", "end your turn", "parks the session", "resumes it"} {
		if !strings.Contains(notifyDesc, phrase) {
			t.Errorf("notify_on_complete schema description missing %q; got %q", phrase, notifyDesc)
		}
	}
	lower := strings.ToLower(def.Description)
	for _, opinion := range []string{"you should", "always", "never poll", "best practice"} {
		if strings.Contains(lower, opinion) {
			t.Errorf("Bash description contains workflow-shaping language %q (ADR-017)", opinion)
		}
	}
}
