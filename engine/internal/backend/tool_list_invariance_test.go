package backend

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestBuildToolDefs_IsModeInvariant pins the cache contract for the tool list:
// the same tools, descriptions, schemas, and order whatever the run's mode.
// The read-only boundary is the plan policy, applied when a tool is called.
func TestBuildToolDefs_IsModeInvariant(t *testing.T) {
	b := NewApiBackend()
	provider := &mockLlmProvider{id: "mock"}
	cfg := &RunConfig{ExternalTools: []types.LlmToolDef{
		{Name: "ext_safe", Description: "safe", PlanModeSafe: true},
		{Name: "ext_mutating", Description: "mutating"},
	}}
	build := func(planMode bool, opts types.RunOptions) string {
		opts.EnterPlanModeDescription = "HARNESS ENTER DESCRIPTION"
		run := &activeRun{requestID: "invariant", planMode: planMode, planFilePath: opts.PlanFilePath, cfg: cfg}
		defs, _ := b.buildToolDefs(run, opts, provider)
		raw, err := json.Marshal(defs)
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}

	auto := build(false, types.RunOptions{})
	for name, got := range map[string]string{
		"plan":                  build(true, types.RunOptions{PlanMode: true, PlanFilePath: "/tmp/plan.md"}),
		"plan with bash":        build(true, types.RunOptions{PlanMode: true, PlanFilePath: "/tmp/plan.md", PlanModeAllowedBashCommands: []string{"gh"}}),
		"plan with custom list": build(true, types.RunOptions{PlanMode: true, PlanFilePath: "/tmp/plan.md", PlanModeTools: []string{"Read"}}),
		"implement":             build(false, types.RunOptions{ImplementationPhase: true, PlanFilePath: "/tmp/plan.md"}),
	} {
		if got != auto {
			t.Errorf("%s: tool list differs from the auto-mode list", name)
		}
	}

	for _, name := range []string{
		tools.ExitPlanModeName, tools.EnterPlanModeName, tools.AskUserQuestionName,
		"Bash", "Write", "Edit", "Read", "Skill", "Poll", "NotebookEdit", "ext_safe", "ext_mutating",
	} {
		if !strings.Contains(auto, `"name":"`+name+`"`) {
			t.Errorf("tool list should carry %s in every mode", name)
		}
	}
	if !strings.Contains(auto, "HARNESS ENTER DESCRIPTION") {
		t.Error("the harness EnterPlanMode description must be forwarded in every mode")
	}
}

// EnterPlanMode is in the list on an implementation run, so the refusal that
// the flag promises has to happen when the tool is called.
func TestEnterPlanMode_RefusedOnImplementationRun(t *testing.T) {
	run := &activeRun{requestID: "impl", opts: &types.RunOptions{ImplementationPhase: true}}
	results := make([]conversation.ToolResultEntry, 1)
	block := types.LlmContentBlock{Type: "tool_use", ID: "t1", Name: tools.EnterPlanModeName}
	hookCalled := false
	hooks := RunHooks{OnPlanModeEnter: func() (bool, string, string) {
		hookCalled = true
		return true, "", "/tmp/plan.md"
	}}
	var emitted []types.NormalizedEvent
	emit := func(_ *activeRun, ev types.NormalizedEvent) { emitted = append(emitted, ev) }

	if !interceptEnterPlanMode(run, block, results, 0, hooks, emit) {
		t.Fatal("want handled")
	}
	if run.planMode {
		t.Fatal("an implementation run must not enter plan mode")
	}
	if hookCalled {
		t.Fatal("before_plan_mode_enter must not fire for a refused entry")
	}
	if !strings.Contains(results[0].Content, "already approved") {
		t.Fatalf("refusal must say why, got %q", results[0].Content)
	}
	for _, ev := range emitted {
		if _, ok := ev.Data.(*types.PlanModeChangedEvent); ok {
			t.Fatal("a refused entry must not announce a mode change")
		}
	}
}

// Calling EnterPlanMode while planning is answered, not left to fall through
// as an unknown tool.
func TestEnterPlanMode_AnsweredWhenAlreadyPlanning(t *testing.T) {
	run := &activeRun{requestID: "already", planMode: true, planFilePath: "/tmp/plan.md"}
	results := make([]conversation.ToolResultEntry, 1)
	block := types.LlmContentBlock{Type: "tool_use", ID: "t1", Name: tools.EnterPlanModeName}
	if !interceptEnterPlanMode(run, block, results, 0, RunHooks{}, func(*activeRun, types.NormalizedEvent) {}) {
		t.Fatal("want handled")
	}
	if !strings.Contains(results[0].Content, "already active") || results[0].IsError {
		t.Fatalf("want an 'already active' answer, got %+v", results[0])
	}
}
