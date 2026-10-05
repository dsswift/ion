package backend

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/providers"
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

// TestBuildClaudeArgs_IsModeInvariant pins the cache contract for a claude-code
// spawn. The arguments decide the tools and system prompt the CLI sends to its
// provider, and that prompt is cached as a prefix, so a plan run, an auto run,
// and an implementation run must be spawned with the same arguments.
//
// Plan mode reaches the run through the hook server, the MCP ToolServer, and a
// notice on the user turn instead. Revert-check: put --disallowedTools or the
// plan prompt back into buildClaudeArgs and this goes red.
func TestBuildClaudeArgs_IsModeInvariant(t *testing.T) {
	planPath := filepath.Join(t.TempDir(), "plan.md")
	base := types.RunOptions{
		McpConfig:          "/tmp/mcp.json",
		HookSettingsPath:   "/tmp/settings.json",
		Model:              "claude-sonnet-4-5",
		AppendSystemPrompt: "Tool name aliases: ...",
		PlanFilePath:       planPath,
	}
	auto := buildClaudeArgs(base)

	plan := base
	plan.PlanMode = true
	plan.PlanModePrompt = "HARNESS PLAN PROMPT"
	plan.PlanModeAllowedBashCommands = []string{"gh"}
	implement := base
	implement.ImplementationPhase = true

	for name, opts := range map[string]types.RunOptions{"plan": plan, "implement": implement} {
		if got := buildClaudeArgs(opts); !reflect.DeepEqual(got, auto) {
			t.Errorf("%s spawn differs from the auto spawn:\nauto %v\n%s %v", name, auto, name, got)
		}
	}
	if hasFlag(auto, "--disallowedTools") {
		t.Errorf("no spawn may remove tools by flag; got --disallowedTools %q", flagValue(auto, "--disallowedTools"))
	}
	if got := flagValue(buildClaudeArgs(plan), "--append-system-prompt"); strings.Contains(got, "PLAN") {
		t.Errorf("plan-mode text must not be in the system prompt: %q", got)
	}
	if got := flagValue(auto, "--permission-mode"); got != "bypassPermissions" {
		t.Fatalf("--permission-mode = %q, want bypassPermissions (native plan mode is broken headless)", got)
	}
}

// TestBuildClaudeArgs_PermissionModeCliOverride verifies a caller override is
// honored, in plan mode as in any other.
func TestBuildClaudeArgs_PermissionModeCliOverride(t *testing.T) {
	for _, opts := range []types.RunOptions{
		{PermissionModeCli: "acceptEdits"},
		{PermissionModeCli: "acceptEdits", PlanMode: true},
	} {
		if got := flagValue(buildClaudeArgs(opts), "--permission-mode"); got != "acceptEdits" {
			t.Fatalf("plan=%v: --permission-mode = %q, want acceptEdits", opts.PlanMode, got)
		}
	}
}

// TestBuildClaudeArgs_AutoModeKeepsNativeTools pins that an ordinary run gets
// its full native tool list. Tool removal is tool-level: stripping background
// Bash would strip foreground Bash with it, and the CLI's refusal for a removed
// tool ("Bash is disabled for this session") is terminal-sounding and not ours
// to reword, so the model reads it as "there is no shell" and stops. The async
// modes are refused at the PreToolUse hook instead (cli_async_gate.go), which
// can see the arguments and can word its own refusal.
//
// Revert-check: reinstate an always-on --disallowedTools and this goes red.
func TestBuildClaudeArgs_AutoModeKeepsNativeTools(t *testing.T) {
	args := buildClaudeArgs(types.RunOptions{Model: "claude-sonnet-4-5"})

	if got := flagValue(args, "--permission-mode"); got != "bypassPermissions" {
		t.Fatalf("auto mode --permission-mode = %q, want bypassPermissions", got)
	}
	if hasFlag(args, "--disallowedTools") {
		t.Errorf("auto mode passed --disallowedTools %q; no spawn removes tools by flag", flagValue(args, "--disallowedTools"))
	}
}

// TestBuildClaudeArgs_AutoModeAdvertisesAgent pins that the default advisory
// allowlist names Agent again. It was dropped while Agent was being removed
// wholesale; the gate now refuses only its background mode, so a foreground
// dispatch is legitimate and the allowlist must not contradict that.
func TestBuildClaudeArgs_AutoModeAdvertisesAgent(t *testing.T) {
	for _, hookPath := range []string{"", "/tmp/ion-settings-test.json"} {
		args := buildClaudeArgs(types.RunOptions{Model: "claude-sonnet-4-5", HookSettingsPath: hookPath})
		allowed := flagValue(args, "--allowedTools")
		found := false
		for _, name := range strings.Split(allowed, ",") {
			if name == "Agent" {
				found = true
			}
		}
		if !found {
			t.Errorf("--allowedTools %q omits Agent (hookSettingsPath=%q)", allowed, hookPath)
		}
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

// An explicit provider pick reaches the backend as "anthropic/<model>"; the
// CLI only knows the bare id.
func TestBuildClaudeArgs_QualifiedModelIsStripped(t *testing.T) {
	providers.RegisterModel("args-qualified-model", types.ModelInfo{ProviderID: "args-qualified-provider"})
	t.Cleanup(func() { providers.UnregisterModel("args-qualified-model") })

	args := buildClaudeArgs(types.RunOptions{Model: "args-qualified-provider/args-qualified-model"})
	for i, a := range args {
		if a == "--model" {
			if i+1 >= len(args) || args[i+1] != "args-qualified-model" {
				t.Fatalf("--model value = %q, want bare id", args[i+1:])
			}
			return
		}
	}
	t.Fatal("--model not passed")
}
