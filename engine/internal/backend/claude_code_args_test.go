package backend

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// flagValue returns the argument following the first occurrence of flag, or ""
// when the flag is absent or terminal.
func flagValue(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func hasFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

// TestBuildClaudeArgs_PlanModeReadOnly pins the plan-mode spawn contract: the
// engine owns plan mode, so the CLI is spawned read-only under bypassPermissions
// with the mutating tools stripped and the plan prompt injected — NOT under the
// broken native "--permission-mode plan". Revert buildClaudeArgs to
// permMode="plan" for plan mode and this goes red.
func TestBuildClaudeArgs_PlanModeReadOnly(t *testing.T) {
	planPath := filepath.Join(t.TempDir(), "plan.md") // does not exist -> fresh plan
	args := buildClaudeArgs(types.RunOptions{
		PlanMode:     true,
		PlanFilePath: planPath,
		McpConfig:    "/tmp/mcp.json",
		Model:        "claude-sonnet-4-5",
	})

	if got := flagValue(args, "--permission-mode"); got != "bypassPermissions" {
		t.Fatalf("plan mode --permission-mode = %q, want bypassPermissions (native plan mode is broken headless)", got)
	}
	disallowed := flagValue(args, "--disallowedTools")
	if disallowed == "" {
		t.Fatal("plan mode must pass --disallowedTools to enforce read-only")
	}
	for _, tool := range []string{"Write", "Edit", "Bash", "NotebookEdit"} {
		if !strings.Contains(disallowed, tool) {
			t.Errorf("--disallowedTools %q missing mutating tool %q", disallowed, tool)
		}
	}
	appendPrompt := flagValue(args, "--append-system-prompt")
	if !strings.Contains(appendPrompt, "[PLAN MODE]") {
		t.Errorf("plan prompt not injected into --append-system-prompt: %q", appendPrompt)
	}
	if !strings.Contains(appendPrompt, "ExitPlanMode") {
		t.Errorf("plan prompt must instruct the model to call ExitPlanMode: %q", appendPrompt)
	}
}

// TestBuildClaudeArgs_AutoModeNoDisallow verifies a normal (non-plan) run keeps
// bypassPermissions with no --disallowedTools and no injected plan prompt.
func TestBuildClaudeArgs_AutoModeNoDisallow(t *testing.T) {
	args := buildClaudeArgs(types.RunOptions{Model: "claude-sonnet-4-5"})

	if got := flagValue(args, "--permission-mode"); got != "bypassPermissions" {
		t.Fatalf("auto mode --permission-mode = %q, want bypassPermissions", got)
	}
	if hasFlag(args, "--disallowedTools") {
		t.Error("auto mode must not pass --disallowedTools")
	}
	if strings.Contains(flagValue(args, "--append-system-prompt"), "[PLAN MODE]") {
		t.Error("auto mode must not inject the plan prompt")
	}
}

// TestBuildClaudeArgs_McpConfigDrivesWildcard pins the mechanism the reused-
// ToolServer bug broke: when opts.McpConfig is set, buildClaudeArgs must emit
// BOTH --mcp-config and the mcp__<server>__* entry in --allowedTools, so the CLI
// loads and is allowed to call the ion-extensions tools. When McpConfig is empty
// (the turn-2 failure state, where the reused server left it unset), NEITHER may
// appear — that empty-config spawn is exactly what returned "No such tool
// available" for every MCP tool. ensureCliToolServerAttached keeps McpConfig set
// on every turn so this branch is always taken; this test pins the args side.
func TestBuildClaudeArgs_McpConfigDrivesWildcard(t *testing.T) {
	wildcard := "mcp__" + McpServerName + "__*"

	with := buildClaudeArgs(types.RunOptions{Model: "claude-sonnet-4-5", McpConfig: "/tmp/mcp.json"})
	if got := flagValue(with, "--mcp-config"); got != "/tmp/mcp.json" {
		t.Errorf("with McpConfig: --mcp-config = %q, want /tmp/mcp.json", got)
	}
	if allowed := flagValue(with, "--allowedTools"); !strings.Contains(allowed, wildcard) {
		t.Errorf("with McpConfig: --allowedTools %q must contain %q", allowed, wildcard)
	}

	without := buildClaudeArgs(types.RunOptions{Model: "claude-sonnet-4-5"})
	if hasFlag(without, "--mcp-config") {
		t.Error("without McpConfig: must not pass --mcp-config")
	}
	if allowed := flagValue(without, "--allowedTools"); strings.Contains(allowed, wildcard) {
		t.Errorf("without McpConfig: --allowedTools %q must not contain the MCP wildcard", allowed)
	}
}

// TestBuildClaudeArgs_PermissionModeCliOverride verifies a caller override is
// honored for a non-plan run, and that plan mode always wins over it (plan mode
// requires the engine-owned read-only spawn).
func TestBuildClaudeArgs_PermissionModeCliOverride(t *testing.T) {
	nonPlan := buildClaudeArgs(types.RunOptions{PermissionModeCli: "acceptEdits"})
	if got := flagValue(nonPlan, "--permission-mode"); got != "acceptEdits" {
		t.Fatalf("non-plan override --permission-mode = %q, want acceptEdits", got)
	}

	plan := buildClaudeArgs(types.RunOptions{PlanMode: true, PermissionModeCli: "acceptEdits"})
	if got := flagValue(plan, "--permission-mode"); got != "bypassPermissions" {
		t.Fatalf("plan mode must ignore PermissionModeCli, got --permission-mode = %q", got)
	}
}

// TestCliResumeArgs pins the precise resume mechanism: the CLI backend
// resumes ONLY with a captured claude-native session UUID
// (RunOptions.CliResumeSessionID), never with Ion's conversation id
// (RunOptions.ConversationID).
func TestCliResumeArgs(t *testing.T) {
	cases := []struct {
		name string
		opts types.RunOptions
		want []string
	}{
		{
			name: "first run: no captured UUID -> omit --resume",
			opts: types.RunOptions{},
			want: nil,
		},
		{
			name: "subsequent run: captured UUID -> --resume <uuid>",
			opts: types.RunOptions{CliResumeSessionID: "11111111-2222-3333-4444-555555555555"},
			want: []string{"--resume", "11111111-2222-3333-4444-555555555555"},
		},
		{
			name: "Ion ConversationID set but no claude UUID -> still no --resume",
			opts: types.RunOptions{ConversationID: "1781483744990-37463b20c27b"},
			want: nil,
		},
		{
			name: "both set -> resume uses the claude UUID, ignores Ion ConversationID",
			opts: types.RunOptions{
				ConversationID:     "1781483744990-37463b20c27b",
				CliResumeSessionID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			},
			want: []string{"--resume", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := cliResumeArgs(tc.opts)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("cliResumeArgs(%+v) = %v, want %v", tc.opts, got, tc.want)
			}
		})
	}
}
