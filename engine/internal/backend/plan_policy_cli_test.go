package backend

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

func cliTestPolicy() PlanPolicy {
	return PlanPolicy{
		AllowedTools:  DefaultPlanModeTools(),
		PlanSafe:      func(name string) bool { return name == "safe_ext" },
		BashAllowlist: []string{"gh pr"},
		McpAllowlist:  []string{permissions.EngineMcpToolPrefix + "listed_ext"},
	}
}

func TestPlanPolicyDecideBridged(t *testing.T) {
	policy := cliTestPolicy()
	cases := []struct {
		tool   string
		input  map[string]any
		denied bool
	}{
		{tools.ExitPlanModeName, nil, false},
		{tools.EnterPlanModeName, nil, false},
		{tools.AskUserQuestionName, nil, false},
		{CliWritePlanToolName, nil, false},
		{CliEditPlanToolName, nil, false},
		{"ion_agent", nil, false},
		{"ion_agent_status", nil, false},
		{"safe_ext", nil, false},
		{"listed_ext", nil, false},
		{"mutating_ext", nil, true},
		{"Poll", nil, true},
		{"TaskStop", nil, true},
		{"Bash", map[string]any{"command": "gh pr view 1"}, false},
		{"Bash", map[string]any{"command": "rm -rf ."}, true},
	}
	for _, tc := range cases {
		got := policy.DecideBridged(tc.tool, tc.input)
		if got.Denied() != tc.denied {
			t.Errorf("DecideBridged(%q): denied=%v (rule %q), want %v", tc.tool, got.Denied(), got.Rule, tc.denied)
		}
		if got.Denied() && got.Reason == "" {
			t.Errorf("DecideBridged(%q): a refusal must carry a reason", tc.tool)
		}
	}

	// A harness list that leaves Agent out takes ion_agent with it.
	narrow := policy
	narrow.AllowedTools = []string{"Read"}
	if !narrow.DecideBridged("ion_agent", nil).Denied() {
		t.Error("ion_agent must follow the harness tool list")
	}
}

func TestPlanPolicyDecideNativeCli(t *testing.T) {
	policy := cliTestPolicy()
	for _, name := range []string{"Write", "Edit", "MultiEdit", "NotebookEdit"} {
		got := policy.DecideNativeCli(name, map[string]any{"file_path": "/repo/a.go"})
		if !got.Denied() {
			t.Errorf("%s must be refused while planning", name)
		}
		if !strings.Contains(got.Reason, permissions.EngineMcpToolPrefix+CliWritePlanToolName) {
			t.Errorf("%s refusal must name the plan-authoring tool, got %q", name, got.Reason)
		}
	}
	if policy.DecideNativeCli("Bash", map[string]any{"command": "gh pr list"}).Denied() {
		t.Error("an allowlisted Bash command must run while planning")
	}
	if !policy.DecideNativeCli("Bash", map[string]any{"command": "make deploy"}).Denied() {
		t.Error("a Bash command outside the allowlist must be refused")
	}
	for _, name := range []string{"Read", "Grep", "Glob", "WebFetch", "Agent", "TodoWrite", "mcp__other__tool", permissions.EngineMcpToolPrefix + "mutating_ext"} {
		if policy.DecideNativeCli(name, nil).Denied() {
			t.Errorf("%s must not be refused by the native rail", name)
		}
	}
}

// The hook server reads the plan state on every request, so a session that
// enters plan mode part-way through a run is read-only from its next call.
func TestPermissionHook_PlanPolicyFollowsLiveMode(t *testing.T) {
	s, token, _ := newTestPermissionServer(t)
	// No ask callback: a call the plan policy lets through resolves to allow
	// instead of waiting on a person.
	s.SetOnAsk(nil)
	var planning atomic.Bool
	s.SetPlanPolicySource(func() (PlanPolicy, bool) { return cliTestPolicy(), planning.Load() })

	write := map[string]any{"file_path": "/repo/a.go", "content": "x"}
	if decision, _ := postPermissionRaw(t, s, token, "Write", write); decision != "allow" {
		t.Fatalf("auto mode: Write decision = %q, want allow", decision)
	}

	planning.Store(true)
	decision, reason := postPermissionRaw(t, s, token, "Write", write)
	if decision != "deny" {
		t.Fatalf("plan mode: Write decision = %q, want deny", decision)
	}
	if !strings.Contains(reason, "Plan mode:") {
		t.Errorf("plan-mode refusal must say so, got %q", reason)
	}
	if decision, _ := postPermissionRaw(t, s, token, "Bash", map[string]any{"command": "make deploy"}); decision != "deny" {
		t.Errorf("plan mode: non-allowlisted Bash decision = %q, want deny", decision)
	}
	if decision, _ := postPermissionRaw(t, s, token, "Bash", map[string]any{"command": "gh pr view 7"}); decision != "allow" {
		t.Errorf("plan mode: allowlisted Bash decision = %q, want allow", decision)
	}
	if decision, _ := postPermissionRaw(t, s, token, "Read", map[string]any{"file_path": "/repo/a.go"}); decision != "allow" {
		t.Errorf("plan mode: Read decision = %q, want allow", decision)
	}

	planning.Store(false)
	if decision, _ := postPermissionRaw(t, s, token, "Write", write); decision != "allow" {
		t.Fatalf("back in auto mode: Write decision = %q, want allow", decision)
	}
}

// The ToolServer refuses a bridged tool at the call, so a tool that is
// registered in every mode is still unreachable while planning.
func TestToolServer_PlanPolicyRefusesAtTheCall(t *testing.T) {
	ts := NewToolServer("plan-gate-" + t.Name())
	ran := map[string]int{}
	register := func(name string) {
		ts.RegisterTool(name, func(_ context.Context, _ map[string]interface{}) (*types.ToolResult, error) {
			ran[name]++
			return &types.ToolResult{Content: "ran " + name}, nil
		}, name, nil)
	}
	for _, name := range []string{"mutating_ext", "safe_ext", CliWritePlanToolName, "ion_agent"} {
		register(name)
	}
	var planning atomic.Bool
	ts.SetPlanPolicySource(func() (PlanPolicy, bool) { return cliTestPolicy(), planning.Load() })

	invoke := func(name string) *types.ToolResult {
		res, ok, err := ts.InvokeTool(context.Background(), name, map[string]interface{}{})
		if err != nil || !ok {
			t.Fatalf("InvokeTool(%s): ok=%v err=%v", name, ok, err)
		}
		return res
	}

	if res := invoke("mutating_ext"); res.IsError {
		t.Fatalf("auto mode: mutating_ext refused: %s", res.Content)
	}

	planning.Store(true)
	res := invoke("mutating_ext")
	if !res.IsError || !strings.HasPrefix(res.Content, "Plan mode:") {
		t.Fatalf("plan mode: mutating_ext must be refused, got %+v", res)
	}
	if ran["mutating_ext"] != 1 {
		t.Fatalf("a refused tool's handler ran: %d calls", ran["mutating_ext"])
	}
	for _, name := range []string{"safe_ext", CliWritePlanToolName, "ion_agent"} {
		if res := invoke(name); res.IsError {
			t.Errorf("plan mode: %s refused: %s", name, res.Content)
		}
	}
}
