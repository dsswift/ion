package backend

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestPlanPolicyDecide(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "plan.md")
	policy := PlanPolicy{
		AllowedTools:  defaultPlanModeTools,
		PlanSafe:      func(name string) bool { return name == "safe_ext" },
		BashAllowlist: []string{"gh pr"},
		McpAllowlist:  []string{"mcp__docs"},
		PlanFilePath:  planFile,
	}
	cases := []struct {
		name  string
		tool  string
		input map[string]any
		want  planVerdict
		rule  string
	}{
		{"read-only tool", "Read", nil, planAllow, "allowed_tool"},
		{"plan-safe tool", "safe_ext", nil, planAllow, "plan_mode_safe"},
		{"mutating built-in", "NotebookEdit", nil, planDeny, "not_plan_tool"},
		{"unknown extension tool", "deploy", nil, planDeny, "not_plan_tool"},
		{"allowlisted mcp server", "mcp__docs__search", nil, planAllow, "mcp_allowlist"},
		{"unlisted mcp tool", "mcp__db__drop", nil, planDeny, "not_plan_tool"},
		{"poll", "Poll", nil, planDeny, "poll"},
		{"exit sentinel", tools.ExitPlanModeName, nil, planAllow, "sentinel"},
		{"question sentinel", tools.AskUserQuestionName, nil, planAllow, "sentinel"},
		{"plan file write", "Write", map[string]any{"file_path": planFile}, planAllow, "plan_file_write"},
		{"source file write", "Write", map[string]any{"file_path": "/repo/main.go"}, planDeny, "non_plan_write"},
		{"source file edit", "Edit", map[string]any{"file_path": "/repo/main.go"}, planDeny, "non_plan_write"},
		{"allowlisted bash", "Bash", map[string]any{"command": "gh pr view 1"}, planAllow, "bash_allowlist"},
		{"other bash", "Bash", map[string]any{"command": "rm -rf ."}, planDeny, "bash_not_allowed"},
		{"bash token boundary", "bash", map[string]any{"command": "gh project list"}, planDeny, "bash_not_allowed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := policy.Decide(tc.tool, tc.input)
			if got.Verdict != tc.want || got.Rule != tc.rule {
				t.Fatalf("Decide(%q) = verdict %d rule %q, want verdict %d rule %q", tc.tool, got.Verdict, got.Rule, tc.want, tc.rule)
			}
			if got.Denied() && got.Reason == "" {
				t.Fatal("a refusal must carry a model-facing reason")
			}
		})
	}
}

// A PlanModeSafe flag or a custom tool list must never let Poll through.
func TestPlanPolicyPollIsNeverAllowed(t *testing.T) {
	policy := PlanPolicy{
		AllowedTools: []string{"Poll"},
		PlanSafe:     func(string) bool { return true },
	}
	if got := policy.Decide("Poll", nil); !got.Denied() {
		t.Fatalf("Poll allowed in plan mode by rule %q", got.Rule)
	}
}

// TestPlanPolicyRefusesNonPlanToolsAtTheCall drives executeTools end to end:
// tools that are present in the run's tool list but are not plan-mode tools
// are refused when called in plan mode, and are not refused by plan mode
// outside it.
func TestPlanPolicyRefusesNonPlanToolsAtTheCall(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "plan.md")
	cfg := &RunConfig{ExternalTools: []types.LlmToolDef{
		{Name: "ext_mutating"},
		{Name: "ext_safe", PlanModeSafe: true},
		{Name: "mcp__db__drop"},
	}}
	names := []string{"NotebookEdit", "ext_mutating", "mcp__db__drop", "Poll", "Bash"}

	for _, name := range names {
		b, run, _ := planGateHelper(t, true, planFile)
		run.cfg = cfg
		blocks := []types.LlmContentBlock{{Name: name, ID: "tc", Input: map[string]any{"command": "ls"}}}
		results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if !results[0].IsError || !strings.HasPrefix(results[0].Content, "Plan mode:") {
			t.Errorf("%s: expected a plan-mode refusal, got: %s", name, results[0].Content)
		}
	}

	for _, name := range names {
		b, run, _ := planGateHelper(t, false, "")
		run.cfg = cfg
		blocks := []types.LlmContentBlock{{Name: name, ID: "tc", Input: map[string]any{"command": "true"}}}
		results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if strings.HasPrefix(results[0].Content, "Plan mode:") {
			t.Errorf("%s: refused by plan mode outside plan mode: %s", name, results[0].Content)
		}
	}

	b, run, _ := planGateHelper(t, true, planFile)
	run.cfg = cfg
	blocks := []types.LlmContentBlock{{Name: "ext_safe", ID: "tc", Input: map[string]any{}}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(results[0].Content, "Plan mode:") {
		t.Errorf("plan-safe extension tool refused by plan mode: %s", results[0].Content)
	}
}
