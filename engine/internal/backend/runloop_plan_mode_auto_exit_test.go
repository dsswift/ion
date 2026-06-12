package backend

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// Regression tests for the deterministic plan-mode auto-exit synthesis
// safety net (issue #187). These tests drive
// maybeSynthesizeExitPlanMode directly so the assertions stay on the
// synthesis decision logic (precondition checks, hook merge,
// PermissionDenial shape, emitted-event ordering) rather than on the
// surrounding runloop infrastructure. End-to-end coverage of the
// runloop end_turn branch lives in the integration tests.

// synthHelper builds an ApiBackend + activeRun pre-configured for the
// synthesis test path. Returns the backend, the run, and a slice that
// the test inspects for emitted events.
func synthHelper(t *testing.T, planMode, autoExit bool, planFilePath string) (*ApiBackend, *activeRun, *[]types.NormalizedEvent) {
	t.Helper()
	b := NewApiBackend()
	var emitted []types.NormalizedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		emitted = append(emitted, ev)
	})
	run := &activeRun{
		requestID:               "test-synth",
		planMode:                planMode,
		planFilePath:            planFilePath,
		planModeAutoExitEnabled: autoExit,
	}
	return b, run, &emitted
}

// textBlock and toolUseBlock build canonical assistant content blocks
// for the synthesis tests. Kept as small helpers because every test
// fabricates assistant turns.
func textBlock(text string) types.LlmContentBlock {
	return types.LlmContentBlock{Type: "text", Text: text}
}

func toolUseBlock(name, id string) types.LlmContentBlock {
	return types.LlmContentBlock{Type: "tool_use", Name: name, ID: id}
}

// Test 1: Synthesis fires when the model ends a plan-mode turn with
// text only and no tool calls. This is the textbook stuck-in-plan-mode
// case the safety net exists to recover.
func TestSynthesizeExitPlanMode_FiresOnTextOnlyEndTurn(t *testing.T) {
	b, run, emitted := synthHelper(t, true, true, "/tmp/plan.md")
	conv := &conversation.Conversation{ID: "sess-1"}
	blocks := []types.LlmContentBlock{textBlock("Plan is ready for review.")}

	fired := b.maybeSynthesizeExitPlanMode(run, conv, RunHooks{}, blocks, "end_turn", 5)

	if !fired {
		t.Fatal("expected synthesis to fire on text-only end_turn")
	}
	run.mu.Lock()
	if !run.exitPlanMode {
		t.Error("expected run.exitPlanMode = true after synthesis")
	}
	if len(run.permissionDenials) != 1 {
		t.Fatalf("expected 1 PermissionDenial, got %d", len(run.permissionDenials))
	}
	denial := run.permissionDenials[0]
	run.mu.Unlock()
	if denial.ToolName != tools.ExitPlanModeName {
		t.Errorf("denial.ToolName = %q, want %q", denial.ToolName, tools.ExitPlanModeName)
	}
	if denial.ToolInput["planFilePath"] != "/tmp/plan.md" {
		t.Errorf("denial.ToolInput.planFilePath = %v, want /tmp/plan.md", denial.ToolInput["planFilePath"])
	}
	if denial.ToolInput["synthesized"] != true {
		t.Errorf("denial.ToolInput.synthesized = %v, want true", denial.ToolInput["synthesized"])
	}
	if !strings.HasPrefix(denial.ToolUseID, "synth-exit-plan-") {
		t.Errorf("denial.ToolUseID = %q, want prefix synth-exit-plan-", denial.ToolUseID)
	}

	// Event order: PlanModeAutoExitEvent first (the engine-synthesized
	// marker), then PlanProposalEvent (the workflow signal).
	if len(*emitted) != 2 {
		t.Fatalf("expected 2 emitted events, got %d", len(*emitted))
	}
	autoExit, ok := (*emitted)[0].Data.(*types.PlanModeAutoExitEvent)
	if !ok {
		t.Fatalf("first event = %T, want *PlanModeAutoExitEvent", (*emitted)[0].Data)
	}
	if autoExit.PlanFilePath != "/tmp/plan.md" {
		t.Errorf("PlanModeAutoExitEvent.PlanFilePath = %q, want /tmp/plan.md", autoExit.PlanFilePath)
	}
	if autoExit.StopReason != "end_turn" {
		t.Errorf("PlanModeAutoExitEvent.StopReason = %q, want end_turn", autoExit.StopReason)
	}
	if autoExit.PlanSlug != "plan" {
		t.Errorf("PlanModeAutoExitEvent.PlanSlug = %q, want plan", autoExit.PlanSlug)
	}
	if _, ok := (*emitted)[1].Data.(*types.PlanProposalEvent); !ok {
		t.Fatalf("second event = %T, want *PlanProposalEvent", (*emitted)[1].Data)
	}
}

// Test 2: Synthesis does NOT fire when the run is not in plan mode.
// This is the most basic guard — without it, any end_turn would
// inject a spurious denial.
func TestSynthesizeExitPlanMode_SkipsWhenNotInPlanMode(t *testing.T) {
	b, run, emitted := synthHelper(t, false, true, "/tmp/plan.md")
	conv := &conversation.Conversation{ID: "sess-1"}
	blocks := []types.LlmContentBlock{textBlock("done")}

	if b.maybeSynthesizeExitPlanMode(run, conv, RunHooks{}, blocks, "end_turn", 1) {
		t.Fatal("expected synthesis to skip when not in plan mode")
	}
	if run.exitPlanMode {
		t.Error("expected run.exitPlanMode to remain false")
	}
	if len(*emitted) != 0 {
		t.Errorf("expected 0 emitted events, got %d", len(*emitted))
	}
}

// Test 3: Synthesis does NOT fire when auto-exit is disabled via
// config / RunOptions. This pins the "opt out" path that strict
// automation harnesses use.
func TestSynthesizeExitPlanMode_SkipsWhenAutoExitDisabled(t *testing.T) {
	b, run, _ := synthHelper(t, true, false, "/tmp/plan.md")
	conv := &conversation.Conversation{ID: "sess-1"}
	blocks := []types.LlmContentBlock{textBlock("done")}

	if b.maybeSynthesizeExitPlanMode(run, conv, RunHooks{}, blocks, "end_turn", 1) {
		t.Fatal("expected synthesis to skip when planModeAutoExitEnabled=false")
	}
	if run.exitPlanMode {
		t.Error("expected run.exitPlanMode to remain false when disabled")
	}
}

// Test 4: Synthesis does NOT fire when the model called ExitPlanMode
// directly. The model-driven path already handles this; synthesizing
// on top would double-emit denials and events.
func TestSynthesizeExitPlanMode_SkipsWhenModelCalledExitPlanMode(t *testing.T) {
	b, run, _ := synthHelper(t, true, true, "/tmp/plan.md")
	conv := &conversation.Conversation{ID: "sess-1"}
	blocks := []types.LlmContentBlock{
		textBlock("Plan ready."),
		toolUseBlock(tools.ExitPlanModeName, "tu-1"),
	}

	if b.maybeSynthesizeExitPlanMode(run, conv, RunHooks{}, blocks, "end_turn", 1) {
		t.Fatal("expected synthesis to skip when model called ExitPlanMode")
	}
}

// Test 5: Synthesis does NOT fire when the model called
// AskUserQuestion. The user is being asked a real question, not
// parked; surfacing a plan-approval card on top would be confusing.
func TestSynthesizeExitPlanMode_SkipsWhenModelCalledAskUserQuestion(t *testing.T) {
	b, run, _ := synthHelper(t, true, true, "/tmp/plan.md")
	conv := &conversation.Conversation{ID: "sess-1"}
	blocks := []types.LlmContentBlock{
		textBlock("Need clarification."),
		toolUseBlock(tools.AskUserQuestionName, "tu-1"),
	}

	if b.maybeSynthesizeExitPlanMode(run, conv, RunHooks{}, blocks, "end_turn", 1) {
		t.Fatal("expected synthesis to skip when model called AskUserQuestion")
	}
}

// Test 6: Synthesis DOES fire when the model called other tools
// (like Bash) but neither ExitPlanMode nor AskUserQuestion. This is
// the exact stuck case from conversation 1780434358497-2a573297a200
// where the model emitted Bash echo "exiting" instead of the real
// ExitPlanMode tool call.
func TestSynthesizeExitPlanMode_FiresWhenModelCalledOnlyBash(t *testing.T) {
	b, run, emitted := synthHelper(t, true, true, "/tmp/plan.md")
	conv := &conversation.Conversation{ID: "sess-1"}
	blocks := []types.LlmContentBlock{
		textBlock("exiting"),
		toolUseBlock("Bash", "tu-1"),
	}

	if !b.maybeSynthesizeExitPlanMode(run, conv, RunHooks{}, blocks, "end_turn", 7) {
		t.Fatal("expected synthesis to fire when only Bash was called")
	}
	if !run.exitPlanMode {
		t.Error("expected run.exitPlanMode = true")
	}
	if len(*emitted) != 2 {
		t.Fatalf("expected 2 emitted events, got %d", len(*emitted))
	}
}

// Test 7: Synthesis does NOT fire when no plan file path is
// resolvable. Synthesizing an exit with no plan to show is worse than
// leaving the conversation parked; the user has nothing to approve.
func TestSynthesizeExitPlanMode_SkipsWhenNoPlanFilePath(t *testing.T) {
	b, run, emitted := synthHelper(t, true, true, "" /* no run.planFilePath */)
	conv := &conversation.Conversation{ID: "sess-1"}
	blocks := []types.LlmContentBlock{textBlock("done")}

	// No GetSessionPlanFilePath hook either, so the path stays empty.
	if b.maybeSynthesizeExitPlanMode(run, conv, RunHooks{}, blocks, "end_turn", 1) {
		t.Fatal("expected synthesis to skip when no plan file path is resolvable")
	}
	if len(*emitted) != 0 {
		t.Errorf("expected 0 emitted events, got %d", len(*emitted))
	}
}

// Test 8: Synthesis recovers a plan file path from the session-level
// fallback when the run's own planFilePath is empty. Mirrors
// interceptExitPlanMode's resolution pattern so the synthesis path is
// not weaker than the model-driven path.
func TestSynthesizeExitPlanMode_ResolvesSessionPlanFilePath(t *testing.T) {
	b, run, emitted := synthHelper(t, true, true, "" /* no run.planFilePath */)
	conv := &conversation.Conversation{ID: "sess-1"}
	blocks := []types.LlmContentBlock{textBlock("done")}
	hooks := RunHooks{
		GetSessionPlanFilePath: func() string { return "/tmp/session-plan.md" },
	}

	if !b.maybeSynthesizeExitPlanMode(run, conv, hooks, blocks, "end_turn", 1) {
		t.Fatal("expected synthesis to fire using session fallback path")
	}
	run.mu.Lock()
	defer run.mu.Unlock()
	if len(run.permissionDenials) != 1 {
		t.Fatalf("expected 1 PermissionDenial, got %d", len(run.permissionDenials))
	}
	if run.permissionDenials[0].ToolInput["planFilePath"] != "/tmp/session-plan.md" {
		t.Errorf("denial.planFilePath = %v, want /tmp/session-plan.md",
			run.permissionDenials[0].ToolInput["planFilePath"])
	}
	if len(*emitted) != 2 {
		t.Errorf("expected 2 emitted events, got %d", len(*emitted))
	}
}

// Test 9: before_plan_mode_auto_exit hook can suppress the synthesis.
// This is the strict-policy harness path — the run completes as a
// normal end_turn and the conversation stays parked in plan mode.
func TestSynthesizeExitPlanMode_HookSuppressesSynthesis(t *testing.T) {
	b, run, emitted := synthHelper(t, true, true, "/tmp/plan.md")
	conv := &conversation.Conversation{ID: "sess-1"}
	blocks := []types.LlmContentBlock{textBlock("done")}
	hooks := RunHooks{
		OnPlanModeAutoExit: func(info PlanModeAutoExitHookInfo) (bool, string, string) {
			return true /* suppress */, "", ""
		},
	}

	if b.maybeSynthesizeExitPlanMode(run, conv, hooks, blocks, "end_turn", 1) {
		t.Fatal("expected synthesis to be suppressed by hook")
	}
	if run.exitPlanMode {
		t.Error("expected run.exitPlanMode to remain false when suppressed")
	}
	if len(*emitted) != 0 {
		t.Errorf("expected 0 emitted events when suppressed, got %d", len(*emitted))
	}
}

// Test 10: before_plan_mode_auto_exit hook can override the plan
// file path used in the synthesized denial and event. This is the
// "stage temp / promote on approval" harness pattern.
func TestSynthesizeExitPlanMode_HookOverridesPlanFilePath(t *testing.T) {
	b, run, emitted := synthHelper(t, true, true, "/tmp/staging-plan.md")
	conv := &conversation.Conversation{ID: "sess-1"}
	blocks := []types.LlmContentBlock{textBlock("done")}
	hooks := RunHooks{
		OnPlanModeAutoExit: func(info PlanModeAutoExitHookInfo) (bool, string, string) {
			return false, "/canonical/plan.md", ""
		},
	}

	if !b.maybeSynthesizeExitPlanMode(run, conv, hooks, blocks, "end_turn", 1) {
		t.Fatal("expected synthesis to fire when hook only overrides path")
	}
	run.mu.Lock()
	gotPath := run.permissionDenials[0].ToolInput["planFilePath"]
	run.mu.Unlock()
	if gotPath != "/canonical/plan.md" {
		t.Errorf("denial.planFilePath = %v, want /canonical/plan.md", gotPath)
	}
	autoExit := (*emitted)[0].Data.(*types.PlanModeAutoExitEvent)
	if autoExit.PlanFilePath != "/canonical/plan.md" {
		t.Errorf("event.PlanFilePath = %q, want /canonical/plan.md", autoExit.PlanFilePath)
	}
}

// Test 11: before_plan_mode_auto_exit hook can override the reason
// string recorded on the synthesized denial and event.
func TestSynthesizeExitPlanMode_HookOverridesReason(t *testing.T) {
	b, run, emitted := synthHelper(t, true, true, "/tmp/plan.md")
	conv := &conversation.Conversation{ID: "sess-1"}
	blocks := []types.LlmContentBlock{textBlock("done")}
	hooks := RunHooks{
		OnPlanModeAutoExit: func(info PlanModeAutoExitHookInfo) (bool, string, string) {
			return false, "", "custom harness reason"
		},
	}

	if !b.maybeSynthesizeExitPlanMode(run, conv, hooks, blocks, "end_turn", 1) {
		t.Fatal("expected synthesis to fire when hook only overrides reason")
	}
	run.mu.Lock()
	gotReason := run.permissionDenials[0].ToolInput["reason"]
	run.mu.Unlock()
	if gotReason != "custom harness reason" {
		t.Errorf("denial.reason = %v, want custom harness reason", gotReason)
	}
	autoExit := (*emitted)[0].Data.(*types.PlanModeAutoExitEvent)
	if autoExit.Reason != "custom harness reason" {
		t.Errorf("event.Reason = %q, want custom harness reason", autoExit.Reason)
	}
}

// Test 12: hook receives the assistant text and emitted tool list.
// Pins the telemetry-friendly payload so a harness that wants to
// track what the model substituted for ExitPlanMode can rely on it.
func TestSynthesizeExitPlanMode_HookReceivesAssistantContext(t *testing.T) {
	b, run, _ := synthHelper(t, true, true, "/tmp/plan.md")
	conv := &conversation.Conversation{ID: "sess-1"}
	blocks := []types.LlmContentBlock{
		textBlock("Plan ready. "),
		textBlock("Exiting now."),
		toolUseBlock("Bash", "tu-1"),
		toolUseBlock("Read", "tu-2"),
	}
	var captured PlanModeAutoExitHookInfo
	hooks := RunHooks{
		OnPlanModeAutoExit: func(info PlanModeAutoExitHookInfo) (bool, string, string) {
			captured = info
			return false, "", ""
		},
	}

	if !b.maybeSynthesizeExitPlanMode(run, conv, hooks, blocks, "end_turn", 3) {
		t.Fatal("expected synthesis to fire")
	}
	if captured.SessionID != "sess-1" {
		t.Errorf("captured.SessionID = %q, want sess-1", captured.SessionID)
	}
	if captured.RunID != "test-synth" {
		t.Errorf("captured.RunID = %q, want test-synth", captured.RunID)
	}
	if captured.StopReason != "end_turn" {
		t.Errorf("captured.StopReason = %q, want end_turn", captured.StopReason)
	}
	if captured.PlanFilePath != "/tmp/plan.md" {
		t.Errorf("captured.PlanFilePath = %q, want /tmp/plan.md", captured.PlanFilePath)
	}
	if captured.AssistantText != "Plan ready. Exiting now." {
		t.Errorf("captured.AssistantText = %q, want concatenated text", captured.AssistantText)
	}
	if len(captured.EmittedTools) != 2 || captured.EmittedTools[0] != "Bash" || captured.EmittedTools[1] != "Read" {
		t.Errorf("captured.EmittedTools = %v, want [Bash Read]", captured.EmittedTools)
	}
}

// Test 13: resolvePlanModeAutoExit precedence chain.
//   1. RunOptions.PlanModeAutoExit takes precedence over everything.
//   2. RunConfig.PlanModeAutoExitOnEndTurn wins when RunOptions is nil.
//   3. Built-in default (true) wins when both are nil.
//
// This pins the configuration plumbing so future refactors of the
// precedence chain cannot silently invert the default.
func TestResolvePlanModeAutoExit_Precedence(t *testing.T) {
	tt := true
	ff := false
	cases := []struct {
		name string
		opts *types.RunOptions
		cfg  *RunConfig
		want bool
	}{
		{
			name: "no opts no cfg -> built-in default true",
			opts: &types.RunOptions{},
			cfg:  nil,
			want: true,
		},
		{
			name: "no opts cfg false -> false",
			opts: &types.RunOptions{},
			cfg:  &RunConfig{PlanModeAutoExitOnEndTurn: &ff},
			want: false,
		},
		{
			name: "no opts cfg true -> true",
			opts: &types.RunOptions{},
			cfg:  &RunConfig{PlanModeAutoExitOnEndTurn: &tt},
			want: true,
		},
		{
			name: "opts true overrides cfg false",
			opts: &types.RunOptions{PlanModeAutoExit: &tt},
			cfg:  &RunConfig{PlanModeAutoExitOnEndTurn: &ff},
			want: true,
		},
		{
			name: "opts false overrides cfg true",
			opts: &types.RunOptions{PlanModeAutoExit: &ff},
			cfg:  &RunConfig{PlanModeAutoExitOnEndTurn: &tt},
			want: false,
		},
		{
			name: "nil opts pointer (this should never happen in practice)",
			opts: nil,
			cfg:  &RunConfig{PlanModeAutoExitOnEndTurn: &ff},
			want: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolvePlanModeAutoExit(tc.opts, tc.cfg)
			if got != tc.want {
				t.Errorf("resolvePlanModeAutoExit = %v, want %v", got, tc.want)
			}
		})
	}
}

// Test 14: synthesizedToolUseID embeds the runID and turn for log
// correlation, and is unique across rapid calls so two synthesis
// firings on the same run cannot collide on the denial ID.
func TestSynthesizedToolUseID_FormatAndUniqueness(t *testing.T) {
	id1 := synthesizedToolUseID("run-A", 3)
	id2 := synthesizedToolUseID("run-A", 3)

	if !strings.HasPrefix(id1, "synth-exit-plan-run-A-t3-") {
		t.Errorf("id1 = %q, want prefix synth-exit-plan-run-A-t3-", id1)
	}
	if id1 == id2 {
		t.Errorf("expected distinct IDs across calls, got %q twice", id1)
	}
}
