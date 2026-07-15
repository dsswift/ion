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
	if !strings.Contains(results[0].Content, "not the plan file for this session") {
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
	if !strings.Contains(results[0].Content, "not the plan file for this session") {
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

// Test 11: Write to a stray plan-shaped path (inside the plans dir but not
// the canonical file) returns IsError=true and names the canonical path.
// The physical write still lands at the canonical path (the redirect runs),
// so the canonical file must contain the written content.
func TestPlanGate_StrayPlanShapedPathRedirectIsError(t *testing.T) {
	cwd := t.TempDir()
	plansDir := filepath.Join(cwd, ".ion", "plans")
	if err := os.MkdirAll(plansDir, 0755); err != nil {
		t.Fatal(err)
	}
	canonicalFile := filepath.Join(plansDir, "canonical-plan.md")
	strayFile := filepath.Join(plansDir, "old-stray-plan.md")
	b, run, _ := planGateHelper(t, true, canonicalFile)

	content := "# my plan content"
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-11",
		Input: map[string]interface{}{"file_path": strayFile, "content": content},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, cwd)
	if err != nil {
		t.Fatal(err)
	}

	// Result must be an error — redirect is a behavioral correction, not silent success.
	if !results[0].IsError {
		t.Errorf("expected redirect to stray plan-shaped path to return IsError=true, got success: %s", results[0].Content)
	}

	// Error message must name the canonical path so the model knows where to write next.
	if !strings.Contains(results[0].Content, canonicalFile) {
		t.Errorf("expected error message to name canonical path %s, got: %s", canonicalFile, results[0].Content)
	}

	// The content must have been physically written to the canonical file.
	got, readErr := os.ReadFile(canonicalFile)
	if readErr != nil {
		t.Fatalf("canonical file not written: %v", readErr)
	}
	if !strings.Contains(string(got), "my plan content") {
		t.Errorf("canonical file missing expected content; got: %s", string(got))
	}

	// The stray file must NOT exist (write was redirected away from it).
	if _, statErr := os.Stat(strayFile); statErr == nil {
		t.Error("stray file should not exist on disk — write was redirected")
	}
}

// Test 12: Hard-block error message names the canonical path and gives a
// directive to resubmit. Targets a non-plan-shaped path (not inside any
// plans dir), so no redirect fires — it's a straight block.
func TestPlanGate_HardBlockMessageNamesCanonicalPath(t *testing.T) {
	cwd := t.TempDir()
	plansDir := filepath.Join(cwd, ".ion", "plans")
	if err := os.MkdirAll(plansDir, 0755); err != nil {
		t.Fatal(err)
	}
	canonicalFile := filepath.Join(plansDir, "canonical-plan.md")
	// nonPlanFile lives in cwd/src — inside cwd but NOT inside the plans dir.
	srcDir := filepath.Join(cwd, "src")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		t.Fatal(err)
	}
	nonPlanFile := filepath.Join(srcDir, "not-a-plan.md")
	b, run, _ := planGateHelper(t, true, canonicalFile)

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-12",
		Input: map[string]interface{}{"file_path": nonPlanFile, "content": "anything"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, cwd)
	if err != nil {
		t.Fatal(err)
	}

	if !results[0].IsError {
		t.Error("expected hard-block to return IsError=true")
	}

	// Error must name the canonical path so the model knows where to go.
	if !strings.Contains(results[0].Content, canonicalFile) {
		t.Errorf("expected hard-block message to name canonical path %s, got: %s", canonicalFile, results[0].Content)
	}

	// Error must contain the directive to resubmit.
	if !strings.Contains(strings.ToLower(results[0].Content), "resubmit") {
		t.Errorf("expected hard-block message to say 'Resubmit', got: %s", results[0].Content)
	}

	// The non-plan file must not exist.
	if _, statErr := os.Stat(nonPlanFile); statErr == nil {
		t.Error("non-plan file should not exist on disk after hard block")
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

// TestPlanGate_BashAllowlist_PerPromptAdditionAllowed pins the runtime gate
// behavior for the /create-issue scenario: the run's only allowance is a
// per-prompt addition (3-token prefix "echo issue create"), and the gate
// must allow a command that starts with that prefix. The session has no
// allowlist of its own; the addition is what was installed on the run from
// RunOptions.BashAllowlistAdditionsForThisPrompt via buildToolDefs. This is the
// gate twin of TestBuildToolDefs_PerPromptBashAdditionsOnly_NoSessionAllowlist.
//
// SAFETY: uses `echo` instead of `gh issue create` so the allowed-path
// test cannot mutate any live repo when the gate correctly passes the
// command through to real Bash execution.
func TestPlanGate_BashAllowlist_PerPromptAdditionAllowed(t *testing.T) {
	b, run, _ := bashGateHelper(t, []string{"echo issue create"})
	results, isErr := runBashGate(t, b, run, "echo issue create --repo dsswift/ion --title x --body y")
	if isErr && strings.Contains(results[0].Content, "Plan mode: Bash command") {
		t.Errorf("expected gate to allow 'echo issue create …' against per-prompt allowlist [echo issue create], got blocked: %s", results[0].Content)
	}
}

// TestPlanGate_BashAllowlist_PerPromptAdditionStillDeniesOthers verifies the
// addition does not widen the gate beyond its prefix: a command outside the
// per-prompt allowance is still denied. Pins that the run-scoped grant is
// exactly the declared prefix and nothing more.
func TestPlanGate_BashAllowlist_PerPromptAdditionStillDeniesOthers(t *testing.T) {
	b, run, _ := bashGateHelper(t, []string{"echo issue create"})
	results, isErr := runBashGate(t, b, run, "rm -rf /")
	if !isErr {
		t.Fatalf("expected 'rm -rf /' to be blocked against per-prompt allowlist [echo issue create]")
	}
	if !strings.Contains(results[0].Content, "not in the allowed list") {
		t.Errorf("expected blocked-command message, got: %s", results[0].Content)
	}
}

// TestPlanGate_StrayPlanFileWriteRedirectedToCanonical verifies that a Write
// to a plan-shaped path that is NOT the canonical plan file (i.e. a stray
// filename the model invented) is redirected — the content lands on the
// canonical file — AND the tool result is an error so the model corrects its
// path on the next attempt. Before this change, the redirect returned success
// with a notice appended; that failed to reliably correct the model's behavior
// when conversation history anchored it to the stray path.
func TestPlanGate_StrayPlanFileWriteRedirectedToCanonical(t *testing.T) {
	cwd := t.TempDir()
	plansDir := filepath.Join(cwd, ".ion", "plans")
	if err := os.MkdirAll(plansDir, 0755); err != nil {
		t.Fatal(err)
	}
	canonical := filepath.Join(plansDir, "canonical.md")
	if err := os.WriteFile(canonical, []byte("# original plan"), 0644); err != nil {
		t.Fatal(err)
	}
	invented := filepath.Join(plansDir, "invented.md")

	b, run, _ := planGateHelper(t, true, canonical)

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-redirect",
		Input: map[string]interface{}{"file_path": invented, "content": "# revised plan"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, cwd)
	if err != nil {
		t.Fatal(err)
	}
	// Result MUST be an error — redirect is a behavioral correction signal so
	// the model updates its path model and retries with the canonical path.
	if !results[0].IsError {
		t.Errorf("expected redirect to return IsError=true; got success: %s", results[0].Content)
	}
	// Error message must name the canonical path.
	if !strings.Contains(results[0].Content, canonical) {
		t.Errorf("expected error to name canonical path %s, got: %s", canonical, results[0].Content)
	}
	// The invented (stray) file must NOT exist on disk.
	if _, statErr := os.Stat(invented); statErr == nil {
		t.Error("stray plan file should not have been created")
	}
	// The canonical file must contain the redirected content — the physical write happened.
	got, readErr := os.ReadFile(canonical)
	if readErr != nil {
		t.Fatalf("canonical plan file unreadable: %v", readErr)
	}
	if string(got) != "# revised plan" {
		t.Errorf("canonical plan file should contain redirected content, got: %q", string(got))
	}
}

// TestPlanGate_StrayPlanFileEditRedirectedToCanonical mirrors the Write case
// for Edit: an Edit targeting a stray plan-shaped filename is redirected to
// the canonical plan file, but returns IsError=true as a behavioral correction
// signal (same semantics as the Write redirect).
func TestPlanGate_StrayPlanFileEditRedirectedToCanonical(t *testing.T) {
	cwd := t.TempDir()
	plansDir := filepath.Join(cwd, ".ion", "plans")
	if err := os.MkdirAll(plansDir, 0755); err != nil {
		t.Fatal(err)
	}
	canonical := filepath.Join(plansDir, "canonical.md")
	if err := os.WriteFile(canonical, []byte("old marker here"), 0644); err != nil {
		t.Fatal(err)
	}
	invented := filepath.Join(plansDir, "other-plan.md")

	b, run, _ := planGateHelper(t, true, canonical)

	blocks := []types.LlmContentBlock{{
		Name: "Edit",
		ID:   "tc-redirect-edit",
		Input: map[string]interface{}{
			"file_path":  invented,
			"old_string": "old marker here",
			"new_string": "new marker here",
		},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, cwd)
	if err != nil {
		t.Fatal(err)
	}
	// Result MUST be an error — redirect is a behavioral correction signal.
	if !results[0].IsError {
		t.Errorf("expected redirect to return IsError=true; got success: %s", results[0].Content)
	}
	// Error message must name the canonical path.
	if !strings.Contains(results[0].Content, canonical) {
		t.Errorf("expected error to name canonical path %s, got: %s", canonical, results[0].Content)
	}
	if _, statErr := os.Stat(invented); statErr == nil {
		t.Error("stray plan file should not have been created by Edit")
	}
	// The canonical file must reflect the redirected Edit — the physical write happened.
	got, readErr := os.ReadFile(canonical)
	if readErr != nil {
		t.Fatalf("canonical plan file unreadable: %v", readErr)
	}
	if !strings.Contains(string(got), "new marker here") {
		t.Errorf("canonical plan file should reflect the redirected Edit, got: %q", string(got))
	}
}

// TestPlanGate_NonPlanWriteStillBlocked pins that the redirect did NOT loosen
// the hard block for non-plan paths. A Write to a source file outside any
// recognized plans directory is still blocked, even in plan mode.
func TestPlanGate_NonPlanWriteStillBlocked(t *testing.T) {
	cwd := t.TempDir()
	plansDir := filepath.Join(cwd, ".ion", "plans")
	if err := os.MkdirAll(plansDir, 0755); err != nil {
		t.Fatal(err)
	}
	canonical := filepath.Join(plansDir, "canonical.md")
	srcDir := filepath.Join(cwd, "src")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		t.Fatal(err)
	}
	nonPlan := filepath.Join(srcDir, "foo.go")

	b, run, emitted := planGateHelper(t, true, canonical)

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-nonplan",
		Input: map[string]interface{}{"file_path": nonPlan, "content": "package main"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, cwd)
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].IsError {
		t.Error("expected non-plan Write to remain blocked")
	}
	if !strings.Contains(results[0].Content, "not the plan file for this session") {
		t.Errorf("expected hard-block message, got: %s", results[0].Content)
	}
	if _, statErr := os.Stat(nonPlan); statErr == nil {
		t.Error("blocked non-plan file should not exist on disk")
	}
	found := false
	for _, ev := range *emitted {
		if tr, ok := ev.Data.(*types.ToolResultEvent); ok && tr.IsError {
			found = true
		}
	}
	if !found {
		t.Error("expected an error ToolResultEvent for the hard-blocked non-plan write")
	}
}

// TestPlanGate_EmptyPlanFilePathNoRedirect pins that when the run has no
// canonical plan file (prompt-level plan mode with planFilePath=""), a
// plan-shaped write is NOT redirected to "" — it falls through to the hard
// block. There is no canonical target to redirect to, so the engine must not
// write to an empty path.
func TestPlanGate_EmptyPlanFilePathNoRedirect(t *testing.T) {
	cwd := t.TempDir()
	plansDir := filepath.Join(cwd, ".ion", "plans")
	if err := os.MkdirAll(plansDir, 0755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(plansDir, "some-plan.md")

	// planFilePath empty → no canonical target.
	b, run, _ := planGateHelper(t, true, "")

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-empty",
		Input: map[string]interface{}{"file_path": target, "content": "# plan"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, cwd)
	if err != nil {
		t.Fatal(err)
	}
	// With no canonical file, the gate hard-blocks (target != "" canonical).
	if !results[0].IsError {
		t.Error("expected plan-shaped write with empty planFilePath to be blocked, not redirected")
	}
	// Nothing should have been written under the empty path or the target.
	if _, statErr := os.Stat(target); statErr == nil {
		t.Error("no file should have been created when planFilePath is empty")
	}
}

// findPlanFileWritten returns the first PlanFileWrittenEvent in the emitted
// slice, or nil when none was emitted.
func findPlanFileWritten(emitted []types.NormalizedEvent) *types.PlanFileWrittenEvent {
	for _, ev := range emitted {
		if e, ok := ev.Data.(*types.PlanFileWrittenEvent); ok {
			return e
		}
	}
	return nil
}

// TestPlanFileWritten_CreatedOnFirstWrite pins that a successful Write to a
// plan file that does NOT yet exist emits PlanFileWrittenEvent{Operation:
// "created"} with the path + slug. This is the accurate divider trigger:
// the marker fires on the actual write, not on plan-mode entry.
func TestPlanFileWritten_CreatedOnFirstWrite(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "happy-rabbit.md")
	// File does NOT exist yet — this is a "created" write.
	b, run, emitted := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-create",
		Input: map[string]interface{}{"file_path": planFile, "content": "# the plan\n\nstep 1"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].IsError {
		t.Fatalf("write should succeed: %s", results[0].Content)
	}
	ev := findPlanFileWritten(*emitted)
	if ev == nil {
		t.Fatal("expected a PlanFileWrittenEvent after a successful plan-file write")
	}
	if ev.Operation != "created" {
		t.Errorf("Operation = %q, want created (file did not exist before the write)", ev.Operation)
	}
	if ev.PlanFilePath != planFile {
		t.Errorf("PlanFilePath = %q, want %q", ev.PlanFilePath, planFile)
	}
	if ev.PlanSlug != "happy-rabbit" {
		t.Errorf("PlanSlug = %q, want happy-rabbit", ev.PlanSlug)
	}
}

// TestPlanFileWritten_UpdatedWhenFileHasContent pins that a successful Write to
// a plan file that ALREADY has content emits Operation:"updated".
func TestPlanFileWritten_UpdatedWhenFileHasContent(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "frosty-finch.md")
	if err := os.WriteFile(planFile, []byte("# existing plan\n\nlots of prior content here"), 0644); err != nil {
		t.Fatal(err)
	}
	b, run, emitted := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-update",
		Input: map[string]interface{}{"file_path": planFile, "content": "# revised plan\n\nstep 1 and 2"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].IsError {
		t.Fatalf("write should succeed: %s", results[0].Content)
	}
	ev := findPlanFileWritten(*emitted)
	if ev == nil {
		t.Fatal("expected a PlanFileWrittenEvent after a successful plan-file write")
	}
	if ev.Operation != "updated" {
		t.Errorf("Operation = %q, want updated (file had content before the write)", ev.Operation)
	}
}

// TestPlanFileWritten_NotEmittedOnEntry pins that NO PlanFileWrittenEvent is
// emitted for a non-write action in plan mode (it is the WRITE, not plan-mode
// state, that triggers the marker). A blocked write to a non-plan path must
// also not emit the marker.
func TestPlanFileWritten_NotEmittedOnBlockedWrite(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "plan.md")
	otherFile := filepath.Join(t.TempDir(), "src", "main.go")
	b, run, emitted := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-blocked",
		Input: map[string]interface{}{"file_path": otherFile, "content": "package main"},
	}}
	if _, err := b.executeTools(context.Background(), run, blocks, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if ev := findPlanFileWritten(*emitted); ev != nil {
		t.Errorf("no PlanFileWrittenEvent should be emitted for a blocked non-plan write, got %+v", ev)
	}
}
