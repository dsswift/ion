package tools

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/types"
)

func registerRuntimeSkill(t *testing.T) {
	t.Helper()
	skills.RegisterSkill(&skills.Skill{
		Name:         "rt-skill",
		Content:      "Got: !`echo from-shell`",
		AllowedTools: []types.PermissionRule{{Tool: "Read", Decision: "allow"}},
	})
	t.Cleanup(skills.ClearSkillRegistry)
}

func TestSkillTool_RuntimeGrantsAndRuns(t *testing.T) {
	registerRuntimeSkill(t)
	var granted []types.PermissionRule
	var hookSaw []string
	ctx := WithSkillRuntime(context.Background(), SkillRuntime{
		OnLoad: func(ev skills.LoadEvent) skills.LoadDecision { hookSaw = ev.Commands; return skills.LoadDecision{} },
		Grant:  func(g []types.PermissionRule) { granted = append(granted, g...) },
	})
	res, err := ExecuteTool(ctx, "Skill", map[string]any{"skill": "rt-skill"}, "/tmp")
	if err != nil || res.IsError {
		t.Fatalf("skill failed: %v %+v", err, res)
	}
	if !strings.Contains(res.SkillInvocation.Content, "Got: from-shell") {
		t.Fatalf("command did not run: %q", res.SkillInvocation.Content)
	}
	if len(granted) != 1 || granted[0].Tool != "Read" {
		t.Fatalf("allowed-tools not granted to the run: %+v", granted)
	}
	if len(hookSaw) != 1 || hookSaw[0] != "echo from-shell" {
		t.Fatalf("skill_load did not see the command: %v", hookSaw)
	}
}

func TestSkillTool_PermitRefusalIsAnError(t *testing.T) {
	registerRuntimeSkill(t)
	var granted bool
	ctx := WithSkillRuntime(context.Background(), SkillRuntime{
		Permit: func(string, string, []types.PermissionRule) (bool, string) { return false, "policy says no" },
		Grant:  func([]types.PermissionRule) { granted = true },
	})
	res, err := ExecuteTool(ctx, "Skill", map[string]any{"skill": "rt-skill"}, "/tmp")
	if err != nil || !res.IsError || !strings.Contains(res.Content, "policy says no") {
		t.Fatalf("want an error result naming the refusal, got %v %+v", err, res)
	}
	if granted {
		t.Fatal("a refused skill must not grant tools")
	}
}

// A Skill call with no stamped runtime has no policy to check commands
// against, so it runs none of them.
func TestSkillTool_NoRuntimeRunsNoCommand(t *testing.T) {
	registerRuntimeSkill(t)
	res, err := ExecuteTool(context.Background(), "Skill", map[string]any{"skill": "rt-skill"}, "/tmp")
	if err != nil || res.IsError {
		t.Fatalf("skill failed: %v %+v", err, res)
	}
	got := res.SkillInvocation.Content
	if strings.Contains(got, "from-shell") || !strings.Contains(got, skills.ShellDisabledMarker) {
		t.Fatalf("command ran without a runtime: %q", got)
	}
}
