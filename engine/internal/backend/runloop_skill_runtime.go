package backend

import (
	"context"

	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// stampSkillRuntime gives the Skill tool what it needs from this run: the
// skill_load hook, a permission check for injected commands, the shell
// policy, and a sink that records the skill's allowed-tools on the run.
func stampSkillRuntime(ctx context.Context, run *activeRun, onLoad func(skills.LoadEvent) skills.LoadDecision, permEng *permissions.Engine) context.Context {
	disable := run.opts != nil && run.opts.DisableSkillShellExecution
	return tools.WithSkillRuntime(ctx, tools.SkillRuntime{
		OnLoad:       onLoad,
		Permit:       tools.SkillCommandPermit(permEng, run.requestID),
		DisableShell: disable,
		Grant:        run.addSkillGrants,
	})
}

// addSkillGrants records grants for the rest of the run.
func (r *activeRun) addSkillGrants(grants []types.PermissionRule) {
	r.mu.Lock()
	r.skillGrants = append(r.skillGrants, grants...)
	total := len(r.skillGrants)
	r.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "backend.skill", "skill grants added to run", map[string]any{"run_id": r.requestID, "count": len(grants), "total": total})
}

// skillGrantsSnapshot returns a copy safe to read without run.mu.
func (r *activeRun) skillGrantsSnapshot() []types.PermissionRule {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.skillGrants) == 0 {
		return nil
	}
	return append([]types.PermissionRule(nil), r.skillGrants...)
}
