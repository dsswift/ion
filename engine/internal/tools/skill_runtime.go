package tools

import (
	"context"
	"time"

	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SkillRuntime carries what the Skill tool needs from the run that called it:
// the skill_load hook, the permission check for injected commands, the
// shell-execution policy, and a sink for the skill's allowed-tools grants.
// The runloop, and an extension's callTool, stamp it on the tool context.
// Without one, a skill still renders but runs none of its commands: there is
// no policy to check them against, so each placeholder becomes
// skills.ShellDisabledMarker and no grants are recorded.
type SkillRuntime struct {
	OnLoad func(skills.LoadEvent) skills.LoadDecision
	// Permit checks one injected command run in cwd, with the skill's own
	// grants in force.
	Permit       func(command, cwd string, grants []types.PermissionRule) (bool, string)
	DisableShell bool
	// Grant records a skill's allowed-tools on the live run.
	Grant func([]types.PermissionRule)
}

type skillRuntimeKey struct{}

// WithSkillRuntime stamps the run's skill runtime on a tool context.
func WithSkillRuntime(ctx context.Context, rt SkillRuntime) context.Context {
	return context.WithValue(ctx, skillRuntimeKey{}, rt)
}

// skillRuntimeFrom returns the stamped runtime and whether one was stamped.
func skillRuntimeFrom(ctx context.Context) (SkillRuntime, bool) {
	rt, ok := ctx.Value(skillRuntimeKey{}).(SkillRuntime)
	return rt, ok
}

// SkillShellExec runs one skill command through the engine's bash
// operations, so injected commands share the Bash tool's process handling.
func SkillShellExec(ctx context.Context, command, cwd string, timeout time.Duration) (skills.ExecOutcome, error) {
	res, err := GetBashOperations().Exec(ctx, command, cwd, ExecOptions{Timeout: timeout})
	if res == nil {
		return skills.ExecOutcome{}, err
	}
	out := skills.ExecOutcome{ExitCode: res.ExitCode, Output: res.Stdout + res.Stderr, TimedOut: res.TimedOut}
	if err != nil && !res.TimedOut && res.ExitCode == 0 {
		return out, err
	}
	return out, nil
}

// SkillCommandPermit checks an injected skill command as a Bash call. "ask"
// refuses unless one of the skill's own grants settles it, because nobody is
// present to answer a prompt while a skill renders. A nil engine allows.
func SkillCommandPermit(permEng *permissions.Engine, runID string) func(command, cwd string, grants []types.PermissionRule) (bool, string) {
	return func(command, cwd string, grants []types.PermissionRule) (bool, string) {
		if permEng == nil {
			return true, ""
		}
		res := permEng.Check(permissions.CheckInfo{
			Tool:   "Bash",
			Input:  map[string]interface{}{"command": command},
			Cwd:    cwd,
			Grants: grants,
		})
		utils.LogWithFields(utils.LevelDebug, "tools.skill", "skill command permission decided", map[string]any{"run_id": runID, "decision": res.Decision, "layer": res.Layer})
		switch res.Decision {
		case "allow":
			return true, ""
		case "ask":
			return false, "requires approval; add it to the skill's allowed-tools"
		default:
			return false, res.Reason
		}
	}
}
