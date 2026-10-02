package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wireGitIdentity resolves this run's git author/committer identity and
// stamps buildRunConfig's RunConfig accordingly: the resolved identity
// (principal first, then the configured machine fallback -- see
// resolveGitIdentity) is merged into ToolEnv alongside the caller's own
// opaque EngineConfig.ToolEnv, so a Bash subprocess sees both without the
// engine caring what the caller's entries mean. When identity is required
// but unresolved, every git-mutating Bash subcommand is refused before
// execution rather than committing under the operator's own machine
// identity by accident (see backend.checkGitIdentityRequired).
func (m *Manager) wireGitIdentity(s *engineSession, key string, principal *types.SessionPrincipal, runCfg *backend.RunConfig) {
	var gitCfg *types.GitConfig
	if policyCfg := m.policyConfig(principal); policyCfg != nil {
		gitCfg = policyCfg.Git
	}
	gitAuthor, gitResolved := resolveGitIdentity(gitCfg, principal)

	toolEnv := map[string]string{}
	for k, v := range s.config.ToolEnv {
		toolEnv[k] = v
	}
	for k, v := range gitIdentityEnv(gitAuthor) {
		toolEnv[k] = v
	}
	if len(toolEnv) > 0 {
		runCfg.ToolEnv = toolEnv
	}

	if gitCfg != nil && gitCfg.Identity.RequiredEnabled() && !gitResolved {
		runCfg.GitIdentityRequiredUnresolved = true
		utils.LogWithFields(utils.LevelInfo, "session", "git identity required but unresolved; git-mutating Bash subcommands will be refused", map[string]any{"key": key})
	}
}

// resolveGitIdentity resolves the git author/committer identity for a run,
// following FR-04's precedence: the caller's own principal (when
// GitIdentityConfig.FromPrincipal is enabled, the default) first, then the
// enterprise/user-configured machine identity as fallback. Returns (nil,
// false) when neither source yields a usable identity -- both a name and an
// email are required for a source to count as resolved, since git rejects
// an author line missing either half.
func resolveGitIdentity(cfg *types.GitConfig, principal *types.SessionPrincipal) (*types.GitAuthor, bool) {
	var identity types.GitIdentityConfig
	if cfg != nil {
		identity = cfg.Identity
	}

	if identity.FromPrincipalEnabled() && principal != nil {
		name := principal.DisplayName
		if name == "" {
			name = principal.Username
		}
		if name != "" && principal.Email != "" {
			return &types.GitAuthor{Name: name, Email: principal.Email}, true
		}
	}

	if identity.Machine != nil && identity.Machine.Name != "" && identity.Machine.Email != "" {
		return identity.Machine, true
	}

	return nil, false
}

// gitIdentityEnv builds the four GIT_AUTHOR_*/GIT_COMMITTER_* environment
// variables git reads to stamp commit authorship, overriding whatever the
// operator's own ~/.gitconfig declares for the duration of the tool
// subprocess -- see internal/tools/bash_execution_env.go's WithToolEnv.
func gitIdentityEnv(author *types.GitAuthor) map[string]string {
	if author == nil {
		return nil
	}
	return map[string]string{
		"GIT_AUTHOR_NAME":     author.Name,
		"GIT_AUTHOR_EMAIL":    author.Email,
		"GIT_COMMITTER_NAME":  author.Name,
		"GIT_COMMITTER_EMAIL": author.Email,
	}
}
