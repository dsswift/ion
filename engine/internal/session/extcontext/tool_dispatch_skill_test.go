package extcontext

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// skillRuntimeSA is a session that supplies the skill gates an extension's
// callTool("Skill") must run under.
type skillRuntimeSA struct {
	noopSA
	rt tools.SkillRuntime
}

func (s skillRuntimeSA) SkillRuntime() tools.SkillRuntime { return s.rt }

// An extension calling the Skill tool gets the session's command policy: a
// refused command aborts the skill before anything runs.
func TestCallToolFromExtension_SkillCommandsPassSessionPolicy(t *testing.T) {
	skills.RegisterSkill(&skills.Skill{Name: "ext-gated", Content: "Got: !`echo gated`"})
	t.Cleanup(skills.ClearSkillRegistry)

	var asked []string
	sa := skillRuntimeSA{rt: tools.SkillRuntime{
		Permit: func(command, _ string, _ []types.PermissionRule) (bool, string) {
			asked = append(asked, command)
			return false, "denied by policy"
		},
	}}
	res, err := CallToolFromExtension(context.Background(), sa, "Skill", map[string]interface{}{"skill": "ext-gated"})
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsError || !strings.Contains(res.Content, "denied by policy") {
		t.Fatalf("refused command must fail the skill, got %+v", res)
	}
	if len(asked) != 1 || asked[0] != "echo gated" {
		t.Fatalf("policy never saw the command: %v", asked)
	}
}
