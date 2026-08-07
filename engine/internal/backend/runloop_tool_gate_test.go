package backend

// Run-loop enforcement of the client tool gate — the wiring half of
// types.ToolGateConfig. The session package pins the wait/timeout semantics;
// these pin that the tool loop actually consults the callback, records a deny
// as the tool result with the client's reason, emits the client_gate_denied
// failure category, never executes the denied tool, and leaves ungated runs
// untouched.

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestExecuteTools_ClientGateDenyRecordsResult pins the deny path: the
// client's reason lands verbatim in an error tool result, the
// client_gate_denied failure category is emitted, and the tool never runs.
func TestExecuteTools_ClientGateDenyRecordsResult(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "denied.txt")

	b := NewApiBackend()
	var emitted []types.NormalizedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) { emitted = append(emitted, ev) })
	telem := &mockTelemetry{}

	var gateSawTool, gateSawCwd string
	run := &activeRun{
		requestID: "gate-req",
		conv:      &conversation.Conversation{ID: "conv-gate"},
		cfg: &RunConfig{Telemetry: telem, Hooks: RunHooks{
			OnToolGate: func(toolName string, _ map[string]interface{}, cwd string, _ []string) (string, string) {
				gateSawTool, gateSawCwd = toolName, cwd
				return types.GateDecisionDeny, "policy: writes are frozen during release"
			},
		}},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-gate",
		Input: map[string]interface{}{"file_path": target, "content": "x"},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, dir)
	if err != nil {
		t.Fatal(err)
	}

	if gateSawTool != "Write" || gateSawCwd != dir {
		t.Errorf("gate callback saw (%q, %q), want (Write, %q)", gateSawTool, gateSawCwd, dir)
	}
	if len(results) != 1 || !results[0].IsError {
		t.Fatalf("expected one error result, got %+v", results)
	}
	if !strings.Contains(results[0].Content, "policy: writes are frozen during release") {
		t.Errorf("deny reason must reach the model verbatim: %s", results[0].Content)
	}
	if !failureCategories(telem)["client_gate_denied"] {
		t.Error("expected a tool.failure event with category client_gate_denied")
	}
	if _, statErr := os.Stat(target); statErr == nil {
		t.Error("denied Write still created the file")
	}
}

// TestExecuteTools_ClientGateAllowExecutes pins the allow path: an allow
// verdict reaches the tool untouched and the file is written.
func TestExecuteTools_ClientGateAllowExecutes(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "allowed.txt")

	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "gate-allow-req",
		conv:      &conversation.Conversation{ID: "conv-gate-allow"},
		cfg: &RunConfig{Telemetry: telem, Hooks: RunHooks{
			OnToolGate: func(string, map[string]interface{}, string, []string) (string, string) {
				return types.GateDecisionAllow, ""
			},
		}},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-gate-allow",
		Input: map[string]interface{}{"file_path": target, "content": "ok"},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].IsError {
		t.Fatalf("expected one success result, got %+v", results)
	}
	if _, statErr := os.Stat(target); statErr != nil {
		t.Error("allowed Write did not create the file")
	}
}

// TestExecuteTools_ClientGateDenyEmptyReasonGetsDefault pins that a deny with
// no reason still produces an actionable tool result rather than a bare
// "Blocked: ".
func TestExecuteTools_ClientGateDenyEmptyReasonGetsDefault(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "gate-noreason-req",
		conv:      &conversation.Conversation{ID: "conv-gate-noreason"},
		cfg: &RunConfig{Telemetry: telem, Hooks: RunHooks{
			OnToolGate: func(string, map[string]interface{}, string, []string) (string, string) {
				return types.GateDecisionDeny, ""
			},
		}},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-gate-noreason",
		Input: map[string]interface{}{"file_path": filepath.Join(t.TempDir(), "f"), "content": "x"},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].IsError {
		t.Fatalf("expected one error result, got %+v", results)
	}
	if !strings.Contains(results[0].Content, "client tool gate") {
		t.Errorf("empty-reason deny must carry the default message: %s", results[0].Content)
	}
}

// TestExecuteTools_ContainmentPreemptsClientGate pins the ordering contract:
// a call workspace containment refuses never reaches the client gate.
func TestExecuteTools_ContainmentPreemptsClientGate(t *testing.T) {
	checker, worktree, repo := workspaceRunFixture(t)

	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	gateCalled := false
	run := &activeRun{
		requestID: "gate-order-req",
		conv:      &conversation.Conversation{ID: "conv-gate-order"},
		cfg: &RunConfig{Telemetry: telem, WorkspaceChecker: checker, Hooks: RunHooks{
			OnToolGate: func(string, map[string]interface{}, string, []string) (string, string) {
				gateCalled = true
				return types.GateDecisionAllow, ""
			},
		}},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-gate-order",
		Input: map[string]interface{}{"file_path": repo + "/x.go", "content": "x"},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, worktree)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].IsError {
		t.Fatalf("expected the containment refusal, got %+v", results)
	}
	if gateCalled {
		t.Error("client gate consulted for a call workspace containment already refused")
	}
	if !failureCategories(telem)["workspace_containment"] {
		t.Error("expected the workspace_containment category, not a gate category")
	}
}

// TestExecuteTools_ClientGateDenyPreemptsToolCallHook pins the other ordering
// half: the session owner's refusal fires before the extension tool_call hook.
func TestExecuteTools_ClientGateDenyPreemptsToolCallHook(t *testing.T) {
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	hookCalled := false
	run := &activeRun{
		requestID: "gate-hook-req",
		conv:      &conversation.Conversation{ID: "conv-gate-hook"},
		cfg: &RunConfig{Telemetry: telem, Hooks: RunHooks{
			OnToolGate: func(string, map[string]interface{}, string, []string) (string, string) {
				return types.GateDecisionDeny, "denied first"
			},
			OnToolCall: func(ToolCallInfo) (*ToolCallResult, error) {
				hookCalled = true
				return nil, nil
			},
		}},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-gate-hook",
		Input: map[string]interface{}{"file_path": filepath.Join(t.TempDir(), "f"), "content": "x"},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || !results[0].IsError {
		t.Fatalf("expected the gate denial, got %+v", results)
	}
	if hookCalled {
		t.Error("extension tool_call hook fired for a call the client gate denied")
	}
}

// TestExecuteTools_ClientGateReceivesSiblings pins that a multi-call turn
// hands each gate invocation the names of its turn-mates, which is what makes
// turn-isolation policies (e.g. "merge completion must run alone") evaluable.
func TestExecuteTools_ClientGateReceivesSiblings(t *testing.T) {
	dir := t.TempDir()

	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}

	var mu sync.Mutex
	seen := map[string][]string{}
	run := &activeRun{
		requestID: "gate-sib-req",
		conv:      &conversation.Conversation{ID: "conv-gate-sib"},
		cfg: &RunConfig{Telemetry: telem, Hooks: RunHooks{
			OnToolGate: func(toolName string, _ map[string]interface{}, _ string, siblings []string) (string, string) {
				mu.Lock()
				seen[toolName] = append([]string{}, siblings...)
				mu.Unlock()
				return types.GateDecisionAllow, ""
			},
		}},
	}
	blocks := []types.LlmContentBlock{
		{Name: "Write", ID: "tc-sib-1", Input: map[string]interface{}{"file_path": filepath.Join(dir, "a"), "content": "x"}},
		{Name: "Read", ID: "tc-sib-2", Input: map[string]interface{}{"file_path": filepath.Join(dir, "a")}},
	}

	if _, err := b.executeTools(context.Background(), run, blocks, dir); err != nil {
		t.Fatal(err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(seen["Write"]) != 1 || seen["Write"][0] != "Read" {
		t.Errorf("Write gate siblings: want [Read], got %v", seen["Write"])
	}
	if len(seen["Read"]) != 1 || seen["Read"][0] != "Write" {
		t.Errorf("Read gate siblings: want [Write], got %v", seen["Read"])
	}
}
