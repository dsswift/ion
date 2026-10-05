package session

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

const shellSkill = `---
name: shellskill
description: runs a command
allowed-tools: Bash(git status *)
---
Value: !` + "`echo injected-$ARGUMENTS`" + `
Done.`

func writeShellSkill(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	skillDir := filepath.Join(dir, ".ion", "skills", "shellskill")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(shellSkill), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func resolveShellSkill(t *testing.T, workDir, args string) types.RunOptions {
	t.Helper()
	res, ok := resolveSlashCommand("shellskill", args, workDir, false)
	if !ok {
		t.Fatal("skill did not resolve")
	}
	var opts types.RunOptions
	applyResolvedSlashToOpts("k", &opts, res, false)
	if opts.SlashSkill == nil {
		t.Fatal("a skill resolution must carry SlashSkill")
	}
	return opts
}

func TestRenderSlashSkill_RunsCommandAndGrants(t *testing.T) {
	workDir := writeShellSkill(t)
	mgr, s, _ := contextTestSession(t, "slash-skill")
	opts := resolveShellSkill(t, workDir, "abc")

	if err := mgr.renderSlashSkill(s, "slash-skill", &opts, nil, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(opts.Prompt, "Value: injected-abc") || strings.Contains(opts.Prompt, "echo injected") {
		t.Fatalf("command output must replace the placeholder: %q", opts.Prompt)
	}
	if len(opts.SkillGrants) != 1 || opts.SkillGrants[0].Tool != "Bash" || opts.SkillGrants[0].CommandPatterns[0] != "git status *" {
		t.Fatalf("allowed-tools grant missing: %+v", opts.SkillGrants)
	}
}

func TestRenderSlashSkill_SkillLoadHookDenies(t *testing.T) {
	workDir := writeShellSkill(t)
	mgr, s, _ := contextTestSession(t, "slash-skill-deny")
	host := attachTestHost(t, mgr, "slash-skill-deny")
	no := false
	var seen extension.SkillLoadInfo
	host.SDK().On(extension.HookSkillLoad, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		seen = payload.(extension.SkillLoadInfo)
		return &extension.SkillLoadResult{Allow: &no, Reason: "not in this repo"}, nil
	})
	opts := resolveShellSkill(t, workDir, "")
	before := opts.Prompt

	err := mgr.renderSlashSkill(s, "slash-skill-deny", &opts, s.extGroup, nil)
	if err == nil || !strings.Contains(err.Error(), "not in this repo") {
		t.Fatalf("hook deny must abort with its reason, got %v", err)
	}
	if opts.Prompt != before {
		t.Fatal("a denied skill must not change the prompt")
	}
	if seen.Invocation != skills.InvocationSlash || len(seen.Commands) != 1 || seen.Name != "shellskill" {
		t.Fatalf("hook payload wrong: %+v", seen)
	}
}

func TestRenderSlashSkill_PermissionDenyAborts(t *testing.T) {
	workDir := writeShellSkill(t)
	mgr, s, _ := contextTestSession(t, "slash-skill-perm")
	opts := resolveShellSkill(t, workDir, "")
	eng := permissions.NewEngine(&types.PermissionPolicy{Mode: "ask", Rules: []types.PermissionRule{{Tool: "Bash", Decision: "deny", CommandPatterns: []string{"echo *"}}}})

	if err := mgr.renderSlashSkill(s, "slash-skill-perm", &opts, nil, eng); err == nil {
		t.Fatal("a denied command must abort the skill")
	}
}

func TestRenderSlashSkill_ShellDisabledByPolicy(t *testing.T) {
	workDir := writeShellSkill(t)
	mgr, s, _ := contextTestSession(t, "slash-skill-off")
	opts := resolveShellSkill(t, workDir, "")
	opts.DisableSkillShellExecution = true

	if err := mgr.renderSlashSkill(s, "slash-skill-off", &opts, nil, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(opts.Prompt, skills.ShellDisabledMarker) || strings.Contains(opts.Prompt, "injected") {
		t.Fatalf("disabled shell must leave the marker and run nothing: %q", opts.Prompt)
	}
}

// The Skill tool and the slash path render one body the same way.
func TestSkillRender_ToolAndSlashAgree(t *testing.T) {
	workDir := writeShellSkill(t)
	mgr, s, _ := contextTestSession(t, "skill-parity")
	opts := resolveShellSkill(t, workDir, "xyz")
	if err := mgr.renderSlashSkill(s, "skill-parity", &opts, nil, nil); err != nil {
		t.Fatal(err)
	}

	sk, err := skills.LoadSkill(filepath.Join(workDir, ".ion", "skills", "shellskill", "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	skills.RegisterSkill(sk)
	t.Cleanup(skills.ClearSkillRegistry)
	// A run stamps a runtime; one with no permission engine allows every command.
	runCtx := tools.WithSkillRuntime(context.Background(), tools.SkillRuntime{})
	res, err := tools.ExecuteTool(runCtx, "Skill", map[string]any{"skill": "shellskill", "args": "xyz"}, workDir)
	if err != nil || res.IsError {
		t.Fatalf("tool failed: %v %+v", err, res)
	}
	toolBody := res.SkillInvocation.Content
	want := "Value: injected-xyz\nDone."
	if !strings.HasSuffix(toolBody, want) || !strings.HasSuffix(opts.Prompt, want) {
		t.Fatalf("paths disagree:\ntool:  %q\nslash: %q", toolBody, opts.Prompt)
	}
}

// A slash skill's commands run before any backend run exists, so Stop must
// reach them through the session: SendAbort cancels a command mid-flight.
func TestRenderSlashSkill_AbortCancelsRunningCommand(t *testing.T) {
	dir := t.TempDir()
	skillDir := filepath.Join(dir, ".ion", "skills", "slowskill")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := "---\nname: slowskill\ndescription: waits\n---\nWait: !`sleep 30`\n"
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	mgr, s, _ := contextTestSession(t, "slash-abort")
	res, ok := resolveSlashCommand("slowskill", "", dir, false)
	if !ok {
		t.Fatal("skill did not resolve")
	}
	var opts types.RunOptions
	applyResolvedSlashToOpts("slash-abort", &opts, res, false)

	done := make(chan error, 1)
	go func() { done <- mgr.renderSlashSkill(s, "slash-abort", &opts, nil, nil) }()

	deadline := time.Now().Add(5 * time.Second)
	for {
		mgr.mu.RLock()
		running := s.slashRenderCancel != nil
		mgr.mu.RUnlock()
		if running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("render never registered its cancel")
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond) // let the command start
	mgr.SendAbort("slash-abort")

	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "cancelled") {
			t.Fatalf("want a cancelled render, got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("abort did not stop the running command")
	}
	mgr.mu.RLock()
	defer mgr.mu.RUnlock()
	if s.slashRenderCancel != nil {
		t.Fatal("cancel must be cleared after the render ends")
	}
}
