package session

import (
	"context"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// skillLoadHook adapts the extension group to the renderer's skill_load
// seam. Nil when no extensions are loaded.
func skillLoadHook(group *extension.ExtensionGroup, ctx *extension.Context) func(skills.LoadEvent) skills.LoadDecision {
	if group == nil || group.IsEmpty() {
		return nil
	}
	return func(ev skills.LoadEvent) skills.LoadDecision {
		r := group.FireSkillLoad(ctx, extension.SkillLoadInfo{
			Name: ev.Name, Source: ev.Source, BaseDir: ev.BaseDir, Args: ev.Args,
			Invocation: ev.Invocation, Frontmatter: ev.Frontmatter, Commands: ev.Commands,
		})
		return skills.LoadDecision{Allow: r.Allow, Reason: r.Reason, Content: r.Content, AppendContent: r.AppendContent}
	}
}

// renderSlashSkill runs a slash-invoked skill's shell commands and records
// its allowed-tools as grants for the run. It must run with m.mu released:
// a command may take minutes. Returns the error that aborts the prompt.
//
// The prompt is not cancellable while a skill renders; each command is
// bounded by skills.DefaultCommandTimeout instead.
func (m *Manager) renderSlashSkill(s *engineSession, key string, opts *types.RunOptions, extGroup *extension.ExtensionGroup, permEng *permissions.Engine) error {
	sk := opts.SlashSkill
	if sk == nil {
		return nil
	}
	grants := skills.ParseAllowedTools(frontmatterList(sk.Frontmatter, "allowed-tools"), sk.Dir)
	var onLoad func(skills.LoadEvent) skills.LoadDecision
	if extGroup != nil && !extGroup.IsEmpty() {
		onLoad = skillLoadHook(extGroup, m.newExtContext(s, key))
	}
	permit := tools.SkillCommandPermit(permEng, key)
	// The commands run before the backend run exists, so Stop reaches them
	// through the session, not the backend.
	ctx, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	s.slashRenderCancel = cancel
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		s.slashRenderCancel = nil
		m.mu.Unlock()
		cancel()
	}()
	rendered, err := skills.Render(ctx, skills.RenderInput{
		Name:         sk.Name,
		Source:       sk.Source,
		BaseDir:      sk.Dir,
		Args:         sk.Args,
		Invocation:   skills.InvocationSlash,
		Frontmatter:  sk.Frontmatter,
		Body:         opts.Prompt,
		OnLoad:       onLoad,
		Permit:       func(command string) (bool, string) { return permit(command, sk.Dir, grants) },
		Exec:         tools.SkillShellExec,
		DisableShell: opts.DisableSkillShellExecution,
	})
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "session.slash", "slash skill render aborted the prompt", map[string]any{"key": key, "skill": sk.Name, "error": err})
		return err
	}
	opts.Prompt = rendered
	opts.SkillGrants = append(opts.SkillGrants, grants...)
	utils.LogWithFields(utils.LevelInfo, "session.slash", "slash skill rendered", map[string]any{"key": key, "skill": sk.Name, "grants": len(grants)})
	return nil
}

// SkillRuntime gives an extension's callTool("Skill") the gates a run gives
// the model's Skill call: the permission policy for each injected command,
// the skill_load hook, and disableSkillShellExecution. An extension call has
// no run to hold allowed-tools grants, so they are dropped (and logged).
func (a *sessionAccessor) SkillRuntime() tools.SkillRuntime {
	a.m.mu.RLock()
	group := a.s.extGroup
	permEng := a.s.permEngine
	a.m.mu.RUnlock()
	disable := false
	if cfg := a.EngineConfig(); cfg != nil && cfg.Limits.DisableSkillShellExecution != nil {
		disable = *cfg.Limits.DisableSkillShellExecution
	}
	var onLoad func(skills.LoadEvent) skills.LoadDecision
	if group != nil && !group.IsEmpty() {
		onLoad = skillLoadHook(group, a.m.newExtContext(a.s, a.key))
	}
	key := a.key
	return tools.SkillRuntime{
		OnLoad:       onLoad,
		Permit:       tools.SkillCommandPermit(permEng, key),
		DisableShell: disable,
		Grant: func(grants []types.PermissionRule) {
			utils.LogWithFields(utils.LevelInfo, "session.skill", "skill grants dropped: extension call has no run", map[string]any{"key": key, "count": len(grants)})
		},
	}
}

// The extension tool path finds SkillRuntime through this optional interface.
var _ interface{ SkillRuntime() tools.SkillRuntime } = (*sessionAccessor)(nil)
