package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/types"
)

var hookURLPattern = regexp.MustCompile(`hook-relay --url '([^']+)'`)

// childHookDecision posts one PreToolUse request to the hook server a child
// was wired with, found the way the CLI finds it: through the settings file.
func childHookDecision(t *testing.T, settingsPath, tool string, input map[string]any) (decision, reason string) {
	t.Helper()
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	var settings struct {
		Hooks struct {
			PreToolUse []struct {
				Hooks []struct {
					Command string `json:"command"`
				} `json:"hooks"`
			} `json:"PreToolUse"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		t.Fatalf("parse settings: %v", err)
	}
	if len(settings.Hooks.PreToolUse) != 1 || len(settings.Hooks.PreToolUse[0].Hooks) != 1 {
		t.Fatalf("settings carry no PreToolUse hook: %s", raw)
	}
	match := hookURLPattern.FindStringSubmatch(settings.Hooks.PreToolUse[0].Hooks[0].Command)
	if match == nil {
		t.Fatalf("hook command is not the relay: %q", settings.Hooks.PreToolUse[0].Hooks[0].Command)
	}
	body, err := json.Marshal(map[string]any{"tool_name": tool, "tool_input": input})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.Post(match[1], "application/json", bytes.NewReader(body)) //nolint:noctx // local test server
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		HookSpecificOutput struct {
			PermissionDecision       string `json:"permissionDecision"`
			PermissionDecisionReason string `json:"permissionDecisionReason"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(out, &decoded); err != nil {
		t.Fatalf("decode %q: %v", out, err)
	}
	return decoded.HookSpecificOutput.PermissionDecision, decoded.HookSpecificOutput.PermissionDecisionReason
}

func buildClaudeChild(t *testing.T, id string, cfg *RunConfig, opts *types.RunOptions) *ToolServer {
	t.Helper()
	opts.Model = "claude-opus-4-8"
	ts, err := BuildDelegatedChildToolServer(NewClaudeCodeBackend(), id, cfg, opts)
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	if ts == nil {
		t.Fatal("claude-code child must get a tool server")
	}
	t.Cleanup(ts.Stop)
	return ts
}

// A claude-code child runs under bypassPermissions. It must be spawned with a
// PreToolUse hook, or nothing the engine decides ever reaches its tool calls.
//
// Revert-check: drop wireChildPermissionRail from BuildDelegatedChildToolServer
// and HookSettingsPath stays empty.
func TestDelegatedChild_GetsAPermissionRail(t *testing.T) {
	var sp, rt bool
	opts := &types.RunOptions{Prompt: "do the work"}
	ts := buildClaudeChild(t, "child-rail", childCfgWithTools(&sp, &rt), opts)

	if opts.HookSettingsPath == "" {
		t.Fatal("claude-code child has no hook settings; it would run every tool unchecked")
	}
	if args := buildClaudeArgs(*opts); flagValue(args, "--settings") != opts.HookSettingsPath {
		t.Fatalf("the child spawn does not pass its hook settings: %v", args)
	}
	if decision, _ := childHookDecision(t, opts.HookSettingsPath, "Write", map[string]any{"file_path": "/repo/a.go"}); decision != "allow" {
		t.Fatalf("auto-mode child: Write decision = %q, want allow", decision)
	}
	// The async gate rides the same hook and applies to a child as to a root.
	if decision, _ := childHookDecision(t, opts.HookSettingsPath, "Bash", map[string]any{"command": "make", "run_in_background": true}); decision != "deny" {
		t.Fatalf("child background Bash decision = %q, want deny", decision)
	}
	if opts.Prompt != "do the work" {
		t.Fatalf("an auto-mode child's prompt must be unchanged, got %q", opts.Prompt)
	}

	// Stopping the tool server releases the rail with it.
	settings := opts.HookSettingsPath
	ts.Stop()
	if _, err := os.Stat(settings); !os.IsNotExist(err) {
		t.Fatalf("hook settings file was not removed with the child: %v", err)
	}
}

// The session's permission rules bind a dispatched child.
func TestDelegatedChild_PermissionRulesApply(t *testing.T) {
	var sp, rt bool
	cfg := childCfgWithTools(&sp, &rt)
	cfg.PermEngine = permissions.NewEngine(&types.PermissionPolicy{
		Mode:  "deny",
		Rules: []types.PermissionRule{{Tool: "Read", Decision: "allow"}},
	})
	opts := &types.RunOptions{Prompt: "do the work"}
	buildClaudeChild(t, "child-rules", cfg, opts)

	if decision, _ := childHookDecision(t, opts.HookSettingsPath, "Write", map[string]any{"file_path": "/repo/a.go"}); decision != "deny" {
		t.Fatalf("a denied tool ran in a dispatched child: decision = %q", decision)
	}
	if decision, _ := childHookDecision(t, opts.HookSettingsPath, "Read", map[string]any{"file_path": "/repo/a.go"}); decision != "allow" {
		t.Fatalf("an allowed tool was refused in a dispatched child: decision = %q", decision)
	}
}

// A child dispatched in plan mode is read-only, told so, and able to write and
// present its plan.
func TestDelegatedChild_PlanMode(t *testing.T) {
	var sp, rt bool
	cfg := childCfgWithTools(&sp, &rt)
	cfg.ExternalTools = append(cfg.ExternalTools, types.LlmToolDef{Name: "read_docs", PlanModeSafe: true})
	planFile := filepath.Join(t.TempDir(), "plan.md")
	opts := &types.RunOptions{Prompt: "plan the work", PlanMode: true, PlanFilePath: planFile}

	child := NewClaudeCodeBackend()
	var events []types.NormalizedEvent
	child.OnNormalized(func(_ string, ev types.NormalizedEvent) { events = append(events, ev) })
	opts.Model = "claude-opus-4-8"
	ts, err := BuildDelegatedChildToolServer(child, "child-plan", cfg, opts)
	if err != nil || ts == nil {
		t.Fatalf("build: ts=%v err=%v", ts, err)
	}
	defer ts.Stop()

	// Told: the spawn arguments carry no plan text, so the prompt does.
	if !strings.HasPrefix(opts.Prompt, "<system-reminder>\n[PLAN MODE]") || !strings.HasSuffix(opts.Prompt, "\n\nplan the work") {
		t.Fatalf("plan-mode child must be started with the enter notice, got %q", opts.Prompt)
	}
	if args := buildClaudeArgs(*opts); hasFlag(args, "--disallowedTools") {
		t.Fatal("the child spawn must not remove tools by flag")
	}

	// Read-only at the hook.
	decision, reason := childHookDecision(t, opts.HookSettingsPath, "Write", map[string]any{"file_path": "/repo/a.go"})
	if decision != "deny" || !strings.Contains(reason, "Plan mode:") {
		t.Fatalf("plan-mode child: Write decision = %q reason %q, want a plan-mode deny", decision, reason)
	}
	if decision, _ := childHookDecision(t, opts.HookSettingsPath, "Bash", map[string]any{"command": "make deploy"}); decision != "deny" {
		t.Fatalf("plan-mode child: Bash decision = %q, want deny", decision)
	}
	if decision, _ := childHookDecision(t, opts.HookSettingsPath, "Read", map[string]any{"file_path": "/repo/a.go"}); decision != "allow" {
		t.Fatalf("plan-mode child: Read decision = %q, want allow", decision)
	}

	// Read-only on the bridge.
	invoke := func(name string, input map[string]interface{}) *types.ToolResult {
		res, ok, err := ts.InvokeTool(context.Background(), name, input)
		if err != nil || !ok {
			t.Fatalf("InvokeTool(%s): ok=%v err=%v", name, ok, err)
		}
		return res
	}
	if res := invoke("emit_briefing", map[string]interface{}{}); !res.IsError || !strings.HasPrefix(res.Content, "Plan mode:") {
		t.Fatalf("a non-plan-safe extension tool ran in a plan-mode child: %+v", res)
	}
	if rt {
		t.Fatal("the refused tool's router was called")
	}
	if res := invoke("read_docs", map[string]interface{}{}); res.IsError {
		t.Fatalf("a plan-safe extension tool was refused: %s", res.Content)
	}

	// Able to author and present the plan.
	if res := invoke(CliWritePlanToolName, map[string]interface{}{"content": "# the plan"}); res.IsError {
		t.Fatalf("WritePlan: %s", res.Content)
	}
	written, err := os.ReadFile(planFile)
	if err != nil || string(written) != "# the plan" {
		t.Fatalf("plan file = %q err=%v, want the written plan at the dispatch's path", written, err)
	}
	sawWritten := false
	for _, ev := range events {
		if e, ok := ev.Data.(*types.PlanFileWrittenEvent); ok && e.PlanFilePath == planFile {
			sawWritten = true
		}
	}
	if !sawWritten {
		t.Fatal("WritePlan in a child must emit PlanFileWrittenEvent on the child's stream")
	}
	if res := invoke(CliEditPlanToolName, map[string]interface{}{"old_string": "the plan", "new_string": "the revised plan"}); res.IsError {
		t.Fatalf("EditPlan: %s", res.Content)
	}
	if revised, _ := os.ReadFile(planFile); string(revised) != "# the revised plan" {
		t.Fatalf("plan file after EditPlan = %q", revised)
	}
	if res := invoke("ExitPlanMode", map[string]interface{}{}); !strings.Contains(res.Content, "Plan presented for approval") {
		t.Fatalf("ExitPlanMode: %q", res.Content)
	}
}

// The plan tools are registered on every claude-code child, so the set does
// not depend on the child's mode. Outside plan mode they say so and write
// nothing.
func TestDelegatedChild_PlanToolsOutsidePlanMode(t *testing.T) {
	var sp, rt bool
	planFile := filepath.Join(t.TempDir(), "plan.md")
	opts := &types.RunOptions{Prompt: "do the work", PlanFilePath: planFile}
	ts := buildClaudeChild(t, "child-noplan", childCfgWithTools(&sp, &rt), opts)

	for _, name := range []string{"ExitPlanMode", CliWritePlanToolName, CliEditPlanToolName} {
		if !ts.HasTool(name) {
			t.Errorf("%s must be registered whatever the child's mode", name)
		}
	}
	res, _, err := ts.InvokeTool(context.Background(), CliWritePlanToolName, map[string]interface{}{"content": "# stray"})
	if err != nil || !res.IsError || !strings.Contains(res.Content, "not in plan mode") {
		t.Fatalf("WritePlan outside plan mode: res=%+v err=%v", res, err)
	}
	if _, err := os.Stat(planFile); !os.IsNotExist(err) {
		t.Fatal("WritePlan outside plan mode wrote a file")
	}
	res, _, err = ts.InvokeTool(context.Background(), "emit_briefing", map[string]interface{}{})
	if err != nil || res.IsError {
		t.Fatalf("an auto-mode child was refused its extension tool: res=%+v err=%v", res, err)
	}
}

// A child whose rail cannot be set up is not wired at all, so the caller has
// nothing to start.
func TestDelegatedChild_NoRailNoChild(t *testing.T) {
	t.Setenv("TMPDIR", "/nonexistent-ion-child-rail-test-dir")
	var sp, rt bool
	opts := &types.RunOptions{Model: "claude-opus-4-8", Prompt: "do the work"}
	ts, err := BuildDelegatedChildToolServer(NewClaudeCodeBackend(), "child-norail", childCfgWithTools(&sp, &rt), opts)
	if err == nil {
		if ts != nil {
			ts.Stop()
		}
		t.Fatal("want an error when the hook settings cannot be written")
	}
	if ts != nil {
		t.Fatal("a child with no rail must get no tool server")
	}
}
