package backend

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// planGateHelper creates an ApiBackend + activeRun wired for plan-mode
// write gate tests. Returns the backend, the run, and a slice that
// collects emitted events.
func planGateHelper(t *testing.T, planMode bool, planFilePath string) (*ApiBackend, *activeRun, *[]types.NormalizedEvent) {
	t.Helper()
	b := NewApiBackend()
	var emitted []types.NormalizedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		emitted = append(emitted, ev)
	})
	run := &activeRun{
		requestID:    "test-req",
		planMode:     planMode,
		planFilePath: planFilePath,
	}
	return b, run, &emitted
}

// Test 1: Write to plan file is allowed
func TestPlanGate_WriteToplanFileAllowed(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "test-plan.md")
	if err := os.WriteFile(planFile, []byte("# plan"), 0644); err != nil {
		t.Fatal(err)
	}
	b, run, _ := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-1",
		Input: map[string]interface{}{"file_path": planFile, "content": "# updated plan"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].IsError {
		t.Errorf("expected Write to plan file to succeed, got error: %s", results[0].Content)
	}
}

// Test 2: Write to wrong file is blocked
func TestPlanGate_WriteToWrongFileBlocked(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "test-plan.md")
	otherFile := filepath.Join(t.TempDir(), "other-file.md")
	b, run, emitted := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-2",
		Input: map[string]interface{}{"file_path": otherFile, "content": "nope"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].IsError {
		t.Error("expected Write to wrong file to be blocked")
	}
	if !strings.Contains(results[0].Content, "Plan mode: cannot write to") {
		t.Errorf("expected plan-mode error message, got: %s", results[0].Content)
	}
	// The file must not exist on disk — the gate blocked before execution.
	if _, err := os.Stat(otherFile); err == nil {
		t.Error("blocked file should not exist on disk")
	}
	// Verify an error event was emitted.
	found := false
	for _, ev := range *emitted {
		if tr, ok := ev.Data.(*types.ToolResultEvent); ok && tr.IsError {
			found = true
		}
	}
	if !found {
		t.Error("expected an error ToolResultEvent to be emitted")
	}
}

// Test 3: Edit to plan file is allowed
func TestPlanGate_EditToPlanFileAllowed(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "test-plan.md")
	if err := os.WriteFile(planFile, []byte("old content"), 0644); err != nil {
		t.Fatal(err)
	}
	b, run, _ := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name: "Edit",
		ID:   "tc-3",
		Input: map[string]interface{}{
			"file_path":  planFile,
			"old_string": "old content",
			"new_string": "new content",
		},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].IsError {
		t.Errorf("expected Edit to plan file to succeed, got error: %s", results[0].Content)
	}
}

// Test 4: Edit to wrong file is blocked
func TestPlanGate_EditToWrongFileBlocked(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "test-plan.md")
	otherFile := filepath.Join(t.TempDir(), "other.md")
	b, run, _ := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name: "Edit",
		ID:   "tc-4",
		Input: map[string]interface{}{
			"file_path":  otherFile,
			"old_string": "a",
			"new_string": "b",
		},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].IsError {
		t.Error("expected Edit to wrong file to be blocked")
	}
	if !strings.Contains(results[0].Content, "Plan mode: cannot write to") {
		t.Errorf("expected plan-mode error message, got: %s", results[0].Content)
	}
}

// Test 5: Path normalization — equivalent paths that differ in string form
// This is the exact bug that caused the original incident. The model emits
// a path like "/tmp/plans/../plans/plan.md" which is equivalent to
// "/tmp/plans/plan.md". With filepath.Clean both resolve to the same path.
func TestPlanGate_PathNormalizationAllowed(t *testing.T) {
	dir := t.TempDir()
	planDir := filepath.Join(dir, "plans")
	if err := os.MkdirAll(planDir, 0755); err != nil {
		t.Fatal(err)
	}
	planFile := filepath.Join(planDir, "happy-jumping-rabbit.md")
	if err := os.WriteFile(planFile, []byte("# plan"), 0644); err != nil {
		t.Fatal(err)
	}
	b, run, _ := planGateHelper(t, true, planFile)

	// Model uses an equivalent but string-different path.
	normalizedEquivalent := filepath.Join(dir, "plans", "..", "plans", "happy-jumping-rabbit.md")
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-5",
		Input: map[string]interface{}{"file_path": normalizedEquivalent, "content": "# updated plan"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].IsError {
		t.Errorf("expected normalized-equivalent path to be allowed, got error: %s", results[0].Content)
	}
}

// Test 6: Plan mode off — Write to any file is not gated
func TestPlanGate_PlanModeOff_NoGate(t *testing.T) {
	anyFile := filepath.Join(t.TempDir(), "any-file.md")
	b, run, _ := planGateHelper(t, false, "")

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-6",
		Input: map[string]interface{}{"file_path": anyFile, "content": "hello"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// The Write tool will execute (and succeed or fail based on tool logic),
	// but the plan mode gate must NOT fire. We check that there's no
	// "Plan mode: cannot write to" error — the gate didn't intervene.
	if results[0].IsError && strings.Contains(results[0].Content, "Plan mode:") {
		t.Error("plan mode gate should not fire when planMode is false")
	}
}

// Test 7: Read-only tools are allowed in plan mode
func TestPlanGate_ReadOnlyToolsAllowed(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "test-plan.md")
	b, run, _ := planGateHelper(t, true, planFile)

	// Read tool — targets a file that exists.
	readTarget := filepath.Join(t.TempDir(), "readable.txt")
	if err := os.WriteFile(readTarget, []byte("content"), 0644); err != nil {
		t.Fatal(err)
	}

	blocks := []types.LlmContentBlock{{
		Name:  "Read",
		ID:    "tc-7",
		Input: map[string]interface{}{"file_path": readTarget},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// Read should succeed (not blocked by plan gate). It may have its own
	// errors, but not plan-mode errors.
	if results[0].IsError && strings.Contains(results[0].Content, "Plan mode:") {
		t.Error("Read tool should not be blocked by plan mode write gate")
	}
}

// Test 8: ExitPlanMode sentinel is intercepted in plan mode
func TestPlanGate_ExitPlanModeIntercepted(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "test-plan.md")
	b, run, _ := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name:  tools.ExitPlanModeName,
		ID:    "tc-8",
		Input: map[string]interface{}{},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// ExitPlanMode is intercepted — it's not routed to a real tool executor.
	// The run should be flagged for exit.
	run.mu.Lock()
	exited := run.exitPlanMode
	run.mu.Unlock()
	if !exited {
		t.Error("expected ExitPlanMode to set run.exitPlanMode = true")
	}
	// The result should not be an error (it's a successful interception).
	if results[0].IsError {
		t.Errorf("ExitPlanMode result should not be an error, got: %s", results[0].Content)
	}
}

// Test 9: ExitPlanMode in auto mode with session-level planFilePath is intercepted
func TestPlanGate_ExitPlanModeAutoModeIntercepted(t *testing.T) {
	// Simulate prompt-level plan mode: run has planMode=false, planFilePath=""
	// but the session retains the planFilePath from a prior plan-mode run.
	sessionPlanFile := filepath.Join(t.TempDir(), "session-plan.md")
	if err := os.WriteFile(sessionPlanFile, []byte("# plan"), 0644); err != nil {
		t.Fatal(err)
	}
	b, run, emitted := planGateHelper(t, false, "")
	// Wire the GetSessionPlanFilePath hook to return the session-level path.
	run.cfg = &RunConfig{}
	run.cfg.Hooks.GetSessionPlanFilePath = func() string { return sessionPlanFile }

	blocks := []types.LlmContentBlock{{
		Name:  tools.ExitPlanModeName,
		ID:    "tc-9",
		Input: map[string]interface{}{},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// ExitPlanMode should succeed because the session-level planFilePath was resolved.
	if results[0].IsError {
		t.Errorf("expected ExitPlanMode in auto mode to succeed (intercepted), got error: %s", results[0].Content)
	}
	if !strings.Contains(results[0].Content, "Plan mode exited") {
		t.Errorf("expected 'Plan mode exited' result, got: %s", results[0].Content)
	}
	// The run should be flagged for exit, just like in plan mode.
	run.mu.Lock()
	exited := run.exitPlanMode
	denials := len(run.permissionDenials)
	run.mu.Unlock()
	if !exited {
		t.Error("expected ExitPlanMode in auto mode to set run.exitPlanMode = true")
	}
	if denials != 1 {
		t.Errorf("expected 1 permission denial, got %d", denials)
	}
	// Verify the denial carries the resolved planFilePath.
	if denials > 0 {
		input := run.permissionDenials[0].ToolInput
		if input["planFilePath"] != sessionPlanFile {
			t.Errorf("expected denial planFilePath=%s, got %v", sessionPlanFile, input["planFilePath"])
		}
	}
	// Verify a PlanProposalEvent was emitted with the resolved path.
	foundProposal := false
	for _, ev := range *emitted {
		if pp, ok := ev.Data.(*types.PlanProposalEvent); ok && pp.Kind == "exit" {
			foundProposal = true
			if pp.PlanFilePath != sessionPlanFile {
				t.Errorf("expected PlanProposalEvent.PlanFilePath=%s, got %s", sessionPlanFile, pp.PlanFilePath)
			}
		}
	}
	if !foundProposal {
		t.Error("expected a PlanProposalEvent{Kind:exit} to be emitted")
	}
}

// Test 10: ExitPlanMode in auto mode without any planFilePath returns error
func TestPlanGate_ExitPlanModeAutoModeNoPlanFile(t *testing.T) {
	b, run, emitted := planGateHelper(t, false, "")

	blocks := []types.LlmContentBlock{{
		Name:  tools.ExitPlanModeName,
		ID:    "tc-10",
		Input: map[string]interface{}{},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// With no planFilePath anywhere, the engine should return an error
	// to the model instead of emitting a useless plan_proposal.
	if !results[0].IsError {
		t.Errorf("expected ExitPlanMode with no planFilePath to return error, got success: %s", results[0].Content)
	}
	if !strings.Contains(results[0].Content, "not active") {
		t.Errorf("expected error about plan mode not active, got: %s", results[0].Content)
	}
	// The run should NOT be flagged for exit.
	run.mu.Lock()
	exited := run.exitPlanMode
	denials := len(run.permissionDenials)
	run.mu.Unlock()
	if exited {
		t.Error("expected run.exitPlanMode to remain false when no planFilePath")
	}
	if denials != 0 {
		t.Errorf("expected 0 permission denials, got %d", denials)
	}
	// Verify NO PlanProposalEvent was emitted.
	for _, ev := range *emitted {
		if _, ok := ev.Data.(*types.PlanProposalEvent); ok {
			t.Error("expected no PlanProposalEvent when planFilePath is empty")
		}
	}
}

// ─────────────────────────────────────────────────────────────────────
// Plan-mode Bash allowlist gate
// ─────────────────────────────────────────────────────────────────────
//
// The Bash gate at engine/internal/backend/runloop_tools.go:258-300
// short-circuits before executing the Bash tool when the run is in
// plan mode and the command does not match an allowlist prefix.
// Structural twin of the Write gate above; tests here mirror the Write
// gate tests in shape.
//
// Token-based matching is the load-bearing piece of behavior: the
// commit message specifically calls out the `gh` vs `ghost` collision,
// and the gate splits commands on whitespace so a prefix entry must
// match a full leading token (not a substring). These tests pin that
// guarantee.
//
// All tests use `tools.BashName` for the tool name where the actual
// Bash tool would also be registered; the gate fires before tool
// execution so we never need to actually run a shell command in the
// test. When the gate allows the command through, the test asserts the
// gate emitted no IsError result; the *subsequent* tool execution
// would either succeed or fail based on the registered Bash handler,
// which is out of scope for the gate test.

// bashGateHelper is the Bash-gate twin of planGateHelper. Adds an
// allowlist on the activeRun so the gate has something to enforce.
func bashGateHelper(t *testing.T, allowedBashCommands []string) (*ApiBackend, *activeRun, *[]types.NormalizedEvent) {
	t.Helper()
	b, run, emitted := planGateHelper(t, true, "")
	run.planModeAllowedBashCommands = allowedBashCommands
	return b, run, emitted
}

// runBashGate runs executeTools with a single Bash invocation and
// returns the results plus whether the result was an IsError block.
// Helper exists because every test below follows the same shape:
// build a one-block call list, run executeTools, inspect results[0].
func runBashGate(t *testing.T, b *ApiBackend, run *activeRun, command string) (results []conversation.ToolResultEntry, isError bool) {
	t.Helper()
	blocks := []types.LlmContentBlock{{
		Name:  "Bash",
		ID:    "bash-gate-test",
		Input: map[string]interface{}{"command": command},
	}}
	res, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatalf("executeTools returned error: %v", err)
	}
	if len(res) != 1 {
		t.Fatalf("expected 1 result, got %d", len(res))
	}
	return res, res[0].IsError
}

// Exact-prefix match: `gh` matches `gh pr view 123`. The gate must
// allow the call through to the Bash tool. Because Bash actually
// executes when allowed, we use a command that returns quickly and
// successfully on a Unix-like CI (printing "ok" via `echo`) — but the
// allowlist is `echo`, not `gh`, so the test does not depend on `gh`
// being installed. The assertion is that the gate did NOT short-
// circuit with an IsError plan-mode block; downstream execution
// success is a happy bonus.
func TestPlanGate_BashAllowlist_ExactPrefixAllowed(t *testing.T) {
	b, run, _ := bashGateHelper(t, []string{"echo"})
	results, isErr := runBashGate(t, b, run, "echo ok")
	if isErr && strings.Contains(results[0].Content, "Plan mode: Bash command") {
		t.Errorf("expected gate to allow 'echo ok' against allowlist [echo], got blocked: %s", results[0].Content)
	}
}

// Token-boundary rejection: `gh` does NOT match `ghost`. This is the
// headline claim from the commit message — the gate splits on
// whitespace and matches tokens exactly, so a substring like `gh` in
// `ghost` is correctly rejected.
//
// Uses a command that the surrounding tool layer would not execute
// even if the gate let it through (no such command), so the only
// observable signal is the gate's own short-circuit IsError result.
func TestPlanGate_BashAllowlist_TokenBoundaryRejected(t *testing.T) {
	b, run, emitted := bashGateHelper(t, []string{"gh"})
	results, isErr := runBashGate(t, b, run, "ghost --foo")
	if !isErr {
		t.Fatalf("expected 'ghost --foo' to be blocked against allowlist [gh]")
	}
	if !strings.Contains(results[0].Content, "not in the allowed list") {
		t.Errorf("expected blocked-command message, got: %s", results[0].Content)
	}
	if !strings.Contains(results[0].Content, "ghost --foo") {
		t.Errorf("expected blocked message to quote the offending command, got: %s", results[0].Content)
	}
	// The gate must also emit a ToolResultEvent so the engine observer
	// stream sees the block (consumers may render it). Mirror the
	// Write gate's event-emission test pattern.
	foundEvent := false
	for _, ev := range *emitted {
		if tre, ok := ev.Data.(*types.ToolResultEvent); ok && tre.IsError {
			foundEvent = true
			if !strings.Contains(tre.Content, "ghost") {
				t.Errorf("expected emitted ToolResultEvent to contain command, got: %s", tre.Content)
			}
		}
	}
	if !foundEvent {
		t.Error("expected an IsError ToolResultEvent to be emitted for the blocked Bash call")
	}
}

// Multi-token prefix: `git log` allows `git log --oneline -10` because
// both leading tokens of the command match both prefix tokens.
func TestPlanGate_BashAllowlist_MultiTokenPrefixAllowed(t *testing.T) {
	b, run, _ := bashGateHelper(t, []string{"git log"})
	results, isErr := runBashGate(t, b, run, "git log --oneline -10")
	if isErr && strings.Contains(results[0].Content, "Plan mode: Bash command") {
		t.Errorf("expected gate to allow 'git log --oneline -10' against allowlist [git log], got blocked: %s", results[0].Content)
	}
}

// Multi-token prefix mismatch: `git log` does NOT match `git status`
// because the second token differs even though the first matches.
// Pins that the gate matches *every* prefix token, not just the first.
func TestPlanGate_BashAllowlist_MultiTokenPrefixMismatch(t *testing.T) {
	b, run, _ := bashGateHelper(t, []string{"git log"})
	results, isErr := runBashGate(t, b, run, "git status --short")
	if !isErr {
		t.Fatalf("expected 'git status --short' to be blocked against allowlist [git log]")
	}
	if !strings.Contains(results[0].Content, "not in the allowed list") {
		t.Errorf("expected blocked-command message, got: %s", results[0].Content)
	}
}

// Empty allowlist: when run.planModeAllowedBashCommands is nil/empty,
// the gate is a no-op — the surrounding tool execution proceeds as
// usual. In practice Bash isn't in the plan-mode tool list when the
// allowlist is empty, but the gate code path must still no-op safely
// because someone could call executeTools with a Bash block and an
// empty allowlist (e.g. a misconfigured run).
//
// The observable signal: no plan-mode block message in the result. We
// pick a command (`echo`) that, if executed, would just return; the
// assertion is on the absence of the plan-mode block, not on tool
// execution success.
func TestPlanGate_BashAllowlist_EmptyAllowlist_NoGate(t *testing.T) {
	b, run, _ := bashGateHelper(t, nil)
	results, isErr := runBashGate(t, b, run, "echo no-gate")
	if isErr && strings.Contains(results[0].Content, "Plan mode: Bash command") {
		t.Errorf("expected empty allowlist to skip the gate (no plan-mode block), got: %s", results[0].Content)
	}
}

// Case sensitivity: `gh` does NOT match `GH pr view`. The gate uses
// strings.Fields + exact-string token comparison, which is case-
// sensitive. Documenting this so a future change that relaxes case
// matching has to update this test deliberately rather than slip
// through unnoticed.
func TestPlanGate_BashAllowlist_CaseSensitive(t *testing.T) {
	b, run, _ := bashGateHelper(t, []string{"gh"})
	results, isErr := runBashGate(t, b, run, "GH pr view 1")
	if !isErr {
		t.Fatalf("expected 'GH pr view 1' to be blocked against allowlist [gh] (case-sensitive matching)")
	}
	if !strings.Contains(results[0].Content, "not in the allowed list") {
		t.Errorf("expected blocked-command message, got: %s", results[0].Content)
	}
}

// Bash gate only fires in plan mode: when run.planMode is false, even
// an empty allowlist must not produce a plan-mode block. Documents
// that the gate's plan-mode predicate is load-bearing.
func TestPlanGate_BashAllowlist_NotInPlanMode_NoGate(t *testing.T) {
	b, run, _ := planGateHelper(t, false, "")
	run.planModeAllowedBashCommands = []string{"gh"}
	results, isErr := runBashGate(t, b, run, "echo not-in-plan-mode")
	if isErr && strings.Contains(results[0].Content, "Plan mode: Bash command") {
		t.Errorf("expected non-plan-mode run to skip the gate, got: %s", results[0].Content)
	}
}

// Lowercase `bash` tool name (the gate accepts both "Bash" and
// "bash"). Some providers emit lowercased tool names; the gate must
// fire for both. Pins the `block.Name == "Bash" || block.Name == "bash"`
// disjunction in the gate.
func TestPlanGate_BashAllowlist_LowercaseBashName(t *testing.T) {
	b, run, _ := bashGateHelper(t, []string{"gh"})
	blocks := []types.LlmContentBlock{{
		Name:  "bash",
		ID:    "lowercase-bash",
		Input: map[string]interface{}{"command": "ghost foo"},
	}}
	res, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !res[0].IsError || !strings.Contains(res[0].Content, "not in the allowed list") {
		t.Errorf("expected lowercase 'bash' to also be gated, got: %s", res[0].Content)
	}
}
